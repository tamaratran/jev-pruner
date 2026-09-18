import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
} from 'claude-code';

import { DEFAULT_MODEL, buildJevRequest, parseJevResponse } from '../src/jev.js';
import { trimOutput } from '../src/output.js';
import type { JevAsker } from '../src/jev.js';

const ARCHIVE_DIR = '.claude/fast-jev-output';
const DEFAULTS = {
  chunkLines: 20,
  keepThreshold: 0.5,
  maxStateTokens: 25_000,
  minChars: 4_000,
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
  minChars: number;
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
    minChars: optionNumber(options, 'minChars', DEFAULTS.minChars),
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

/** Key lookup order: plugin option, TYPESAFE_API_KEY, EVAL_TYPESAFE_API_KEY, settings env. */
export async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  // `claude plugin eval` runs with a fresh HOME and a scrubbed environment, and
  // passes through only EVAL_* variables, so this is the eval suite's key path.
  const fromEvalEnv = await $.env.get('EVAL_TYPESAFE_API_KEY');
  if (fromEvalEnv) return fromEvalEnv;
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
  return SECRET_COMMAND.test(command) || SECRET_OUTPUT.test(output.slice(0, 20_000));
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);

  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const answer = await next(event);
    try {
      if (answer.deny !== undefined || answer.isError || !answer.result) return answer;
      const record = answer.result;
      if ('persistedOutputPath' in record && record.persistedOutputPath) return answer;
      const combined = record.stdout + (record.stderr ? `\n${record.stderr}` : '');
      if (combined.length <= configured.minChars) return answer;
      const apiKey = await getApiKey($, configured);
      if (!apiKey) return answer;
      const messages = await $.session.messages();
      const goal = goalFromMessages(messages);
      const secret = looksSecret(event.command, combined);
      const path = secret
        ? undefined
        : `${ARCHIVE_DIR}/bash-${event.tool_use_id ?? Date.now()}.txt`;
      const trimmed = await trimOutput(
        {
          command: event.command,
          goal,
          messages,
          output: record.stdout,
          fullOutputPath: path,
        },
        jevAsker(
          async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          },
          apiKey,
          configured.model,
        ),
        {
          minChars: configured.minChars,
          chunkLines: configured.chunkLines,
          keepThreshold: configured.keepThreshold,
          maxStateTokens: configured.maxStateTokens,
        },
      );
      if (!trimmed.trimmed) return answer;
      if (path) {
        const ignorePath = `${ARCHIVE_DIR}/.gitignore`;
        if (!(await $.fs.exists(ignorePath))) await $.fs.write(ignorePath, '*\n');
        await $.fs.write(path, combined);
      }
      const scores = trimmed.scores.map((score) => score.toFixed(2)).join(',');
      $.ui.log(
        `bash output: kept ${trimmed.kept}/${trimmed.chunks} chunks (${trimmed.charsBefore}→${trimmed.charsAfter} chars) scores=${scores}`,
      );
      $.ui.toast(
        `trimmed Bash output ${trimmed.charsBefore}→${trimmed.charsAfter} chars`,
        { timeoutMs: 8_000 },
      );
      return { result: { ...record, stdout: trimmed.output } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      $.ui.log(`bash output trim skipped (${message})`);
      return answer;
    }
  });
};
