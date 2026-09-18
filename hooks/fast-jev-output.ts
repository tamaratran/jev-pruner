import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
} from 'claude-code';

import { DEFAULT_MODEL, buildJevRequest, parseJevResponse } from '../src/jev.js';
import { exceedsOutputThreshold, MIN_OUTPUT_TOKENS, trimOutput } from '../src/output.js';
import type { JevAsker } from '../src/jev.js';

const ARCHIVE_DIR = '.claude/fast-jev-output';
const DEFAULTS = {
  chunkLines: 20,
  keepThreshold: 0.5,
  maxStateTokens: 25_000,
  minTokens: MIN_OUTPUT_TOKENS,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

export type HookFetch = (
  url: string,
  init?: HookFetchInit,
) => Promise<HookFetchResponse>;

export type HookConfig = {
  apiKey?: string;
  chunkLines: number;
  keepThreshold: number;
  maxStateTokens: number;
  minTokens: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveHookConfig(options: PluginOptions): HookConfig {
  const config: HookConfig = {
    chunkLines: optionNumber(options, 'chunkLines', DEFAULTS.chunkLines),
    keepThreshold: optionNumber(options, 'keepThreshold', DEFAULTS.keepThreshold),
    maxStateTokens: optionNumber(options, 'maxStateTokens', DEFAULTS.maxStateTokens),
    minTokens: Math.max(MIN_OUTPUT_TOKENS, optionNumber(options, 'minTokens', DEFAULTS.minTokens)),
    model: optionString(options, 'model') ?? DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  return config;
}

export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

export function goalFromMessages(messages: readonly SessionMessage[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (!message.toolResults || message.toolResults.length === 0),
    )
    .slice(-3)
    .map((message) => message.text.slice(0, 500))
    .join('\n');
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

const SECRET_COMMAND =
  /(^|[|;&]\s*)(printenv|env)\b|\.env\b|\b(secret|secrets|credential|credentials|password|token|keychain|netrc|id_rsa|private[_-]?key)\b/i;
const SECRET_OUTPUT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(aws_secret_access_key|api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*\S|:\/\/[^\s:@/]+:[^\s:@/]+@/i;

export function looksSecret(command: string, output: string): boolean {
  return SECRET_COMMAND.test(command) || SECRET_OUTPUT.test(output);
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);

  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const answer = await next(event);
    try {
      if (answer.deny !== undefined || answer.isError || !answer.result) return answer;
      const record = answer.result;
      const persisted = record.persistedOutputPath;
      const output = persisted ? await $.fs.read(persisted) : record.stdout;
      if (!exceedsOutputThreshold(output, configured.minTokens)) return answer;
      const combined = persisted ? output : output + (record.stderr ? `\n${record.stderr}` : '');
      const apiKey = await getApiKey($, configured);
      if (!apiKey) return answer;
      const messages = await $.session.messages();
      const goal = goalFromMessages(messages);
      const secret = looksSecret(event.command, combined);
      const path = secret
        ? undefined
        : persisted ?? `${ARCHIVE_DIR}/bash-${event.tool_use_id ?? Date.now()}.txt`;
      let archived: Promise<void> | undefined;
      const saveOutput = async (): Promise<void> => {
        if (!path || persisted) return;
        const ignorePath = `${ARCHIVE_DIR}/.gitignore`;
        if (!(await $.fs.exists(ignorePath))) await $.fs.write(ignorePath, '*\n');
        await $.fs.write(path, combined);
      };
      const trimmed = await trimOutput(
        {
          command: event.command,
          goal,
          messages,
          output,
          fullOutputPath: path,
        },
        jevAsker(
          async (url, init) => {
            if (path) await (archived ??= saveOutput());
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          },
          apiKey,
          configured.model,
        ),
        {
          minTokens: configured.minTokens,
          chunkLines: configured.chunkLines,
          keepThreshold: configured.keepThreshold,
          maxStateTokens: configured.maxStateTokens,
        },
      );
      if (!trimmed.trimmed) return answer;
      const stdout = path
        ? `${trimmed.output}\n\n[fast-jev-output full output: ${path} (Read or grep it if needed)]`
        : trimmed.output;
      const scores = trimmed.scores.map((score) => score.toFixed(2)).join(',');
      $.ui.log(
        `bash output: kept ${trimmed.kept}/${trimmed.chunks} chunks (${trimmed.charsBefore}→${stdout.length} chars) scores=${scores}`,
      );
      $.ui.toast(
        `trimmed Bash output ${trimmed.charsBefore}→${stdout.length} chars`,
        { timeoutMs: 8_000 },
      );
      const result = { ...record, stdout };
      delete result.persistedOutputPath;
      delete result.persistedOutputSize;
      if (persisted) result.stderr = '';
      return { result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      $.ui.log(`bash output trim skipped (${message})`);
      return answer;
    }
  });
};
