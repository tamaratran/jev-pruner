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
  persistedMaxChars: 8_000,
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
  persistedOutputs: boolean;
  persistedMaxChars: number;
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
    persistedOutputs:
      typeof options.persistedOutputs === 'boolean' ? options.persistedOutputs : true,
    persistedMaxChars: optionNumber(options, 'persistedMaxChars', DEFAULTS.persistedMaxChars),
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
      // Output too large to show inline: the engine already saved the whole
      // thing and hands the model a head-of-file preview, which is where the
      // lines that matter usually are not. Prune the saved file instead, and
      // keep citing it so nothing becomes unrecoverable.
      const persistedPath =
        'persistedOutputPath' in record && typeof record.persistedOutputPath === 'string'
          ? record.persistedOutputPath
          : undefined;
      if (persistedPath && !configured.persistedOutputs) return answer;
      let source = record.stdout;
      if (persistedPath) {
        try {
          source = await $.fs.read(persistedPath);
        } catch (error) {
          $.ui.log(
            `bash output: persisted output unreadable (${error instanceof Error ? error.message : String(error)})`,
          );
          return answer;
        }
      }
      const combined = source + (record.stderr ? `\n${record.stderr}` : '');
      if (combined.length <= configured.minChars) return answer;
      const apiKey = await getApiKey($, configured);
      if (!apiKey) return answer;
      const messages = await $.session.messages();
      const goal = goalFromMessages(messages);
      const secret = looksSecret(event.command, combined);
      const path = persistedPath
        ? persistedPath
        : secret
          ? undefined
          : `${ARCHIVE_DIR}/bash-${event.tool_use_id ?? Date.now()}.txt`;
      const trimmed = await trimOutput(
        {
          command: event.command,
          goal,
          messages,
          output: source,
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
          // A pruned result that is still too big to show inline would be
          // replaced by a preview again, so cap it when the engine saved it.
          maxChars: persistedPath ? configured.persistedMaxChars : 0,
          chunkLines: configured.chunkLines,
          keepThreshold: configured.keepThreshold,
          maxStateTokens: configured.maxStateTokens,
        },
      );
      if (!trimmed.trimmed) return answer;
      // A workspace that cannot be written to (a sandbox, a read-only checkout)
      // must not cost the trim: drop the saved copy and keep the pruning.
      let saved = path !== undefined;
      if (path && !persistedPath) {
        try {
          const ignorePath = `${ARCHIVE_DIR}/.gitignore`;
          if (!(await $.fs.exists(ignorePath))) await $.fs.write(ignorePath, '*\n');
          await $.fs.write(path, combined);
        } catch (error) {
          saved = false;
          $.ui.log(
            `bash output: full copy not saved (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      const output = saved
        ? trimmed.output
        : trimmed.output.replaceAll(
            `; full output: ${path} (Read or grep it if needed)`,
            '; not saved to disk, re-run the command if you need these lines',
          );
      const scores = trimmed.scores.map((score) => score.toFixed(2)).join(',');
      $.ui.log(
        `bash output: kept ${trimmed.kept}/${trimmed.chunks} chunks (${trimmed.charsBefore}→${trimmed.charsAfter} chars) scores=${scores}`,
      );
      $.ui.toast(
        `trimmed Bash output ${trimmed.charsBefore}→${trimmed.charsAfter} chars`,
        { timeoutMs: 8_000 },
      );
      if (!persistedPath) return { result: { ...record, stdout: output } };
      // The record still says the output was too large to show, so the engine
      // would hand the model a preview of our pruned text. The pruned text is
      // small and cites the saved file, so drop those flags.
      const {
        persistedOutputPath: _persistedOutputPath,
        persistedOutputSize: _persistedOutputSize,
        ...inline
      } = record as Record<string, unknown> & { stdout: string };
      return { result: { ...inline, stdout: output } as typeof record };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      $.ui.log(`bash output trim skipped (${message})`);
      return answer;
    }
  });
};
