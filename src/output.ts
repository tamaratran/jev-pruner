import { estimateStateTokens, noulAnswer } from './jev.js';
import type { JevAsker, JevQuestions } from './jev.js';
import { fitHistory } from './history.js';
import type { ConversationMessage, HistoryEntry } from './history.js';

const DEFAULT_MIN_CHARS = 4_000;
const DEFAULT_CHUNK_LINES = 20;
const DEFAULT_KEEP_THRESHOLD = 0.5;
const DEFAULT_MAX_STATE_TOKENS = 25_000;
const MAX_REQUEST_TOKENS = 30_000;

const MAX_CHUNKS = 200;
const MAX_LINE_CHARS = 2_000;
// Deliberately narrow: this is the floor that overrides Jev and the budget, so
// it must catch a reported failure without catching a file called
// serialize-error.js in a directory listing.
const ERROR_PATTERN = new RegExp(
  [
    '\\b(ERROR|FATAL|FAILED|FAILURE|PANIC)\\b', // shouted, as loggers write them
    '\\b(error|failure|exception|panic|traceback|assertion)s?\\s*:', // "error: ..."
    '\\b(failed|failing|cannot|could not|unable to|denied|refused|timed out)\\s+\\w', // a sentence about it
    '\\b\\w*(Error|Exception)\\b\\s*[:(]', // TypeError:, NullPointerException(
    '\\bTraceback \\(most recent call last\\)',
    '^\\s*at\\s+\\S+\\(.*:\\d+', // stack frames
    '\\b(severity )?vulnerabilit(y|ies)\\b',
    '\\bCrashLoopBackOff\\b|\\bOOMKilled\\b',
    '\\bHTTP/[0-9.]+ [45]\\d\\d\\b|\\bstatus[=: ]\\s*[45]\\d\\d\\b',
  ].join('|'),
  'm',
);
const OUTPUT_CONTEXT =
  'A coding agent ran a shell command. `history` is the conversation so far, oldest first, with tool outputs replaced by status and length notes; long inputs and texts may be abridged and older text-only messages may be omitted. Use its instructions and decisions to judge what the task needs. The current command output is split into numbered chunks. The agent will only see the chunks that are kept; the full output is saved to a file it can read later. Decide which chunks the agent needs to understand the outcome of the command and continue its task: errors, failures, warnings, summaries, final results, and lines the task depends on are needed; repetitive progress output, verbose listings, download/install noise and boilerplate are not.';

export interface TrimOutputOptions {
  minChars?: number;
  chunkLines?: number;
  keepThreshold?: number;
  maxStateTokens?: number;
  /**
   * Cap on the pruned output. Over it, the lowest-scoring kept chunks go until
   * the rest fits, so a result the engine would otherwise replace with a
   * head-of-file preview stays visible. 0 means no cap.
   */
  maxChars?: number;
  /** Cap on extra Jev requests when the state cannot hold every chunk at full text. */
  maxScoringRequests?: number;
}

export interface TrimOutputInput {
  command: string;
  goal: string;
  output: string;
  fullOutputPath?: string;
  messages?: readonly ConversationMessage[];
}

export interface TrimOutputResult {
  output: string;
  trimmed: boolean;
  chunks: number;
  kept: number;
  dropped: number;
  charsBefore: number;
  charsAfter: number;
  scores: number[];
}

type OutputChunk = {
  id: string;
  text: string;
  lines: number;
  chars: number;
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Output with NULs or a lot of control bytes is not text worth chunking. */
export function looksBinary(output: string): boolean {
  const sample = output.slice(0, 4_000);
  if (sample.includes('\u0000')) return true;
  let control = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32) || code === 127) control += 1;
  }
  return control > sample.length * 0.05;
}

/**
 * Output the agent is likely to parse as one document (a file dump, a diff, a
 * JSON blob). Cutting a hole in it leaves something that still looks complete
 * but is not, so it is left alone.
 */
export function looksStructured(command: string, output: string): boolean {
  const head = output.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(output);
      return true;
    } catch {
      /* not JSON after all */
    }
  }
  if (head.startsWith('<?xml') || head.startsWith('<!DOCTYPE') || head.startsWith('---\n')) return true;
  if (/^diff --git |^--- |^@@ /m.test(output)) return true;
  return /(^|[|;&]\s*)(cat|bat|jq|yq|git\s+(diff|show)|base64|openssl)\b/.test(command);
}

/** Splits over-long lines so one line cannot become an untrimmable chunk. */
function splitLongLines(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length <= MAX_LINE_CHARS) {
      out.push(line);
      continue;
    }
    for (let at = 0; at < line.length; at += MAX_LINE_CHARS) {
      out.push(line.slice(at, at + MAX_LINE_CHARS));
    }
  }
  return out;
}

function chunkOutput(output: string, chunkLines: number): OutputChunk[] {
  const lines = splitLongLines(output);
  const chunks: OutputChunk[] = [];
  for (let start = 0; start < lines.length; start += chunkLines) {
    const text = lines.slice(start, start + chunkLines).join('\n');
    chunks.push({
      id: `c${chunks.length + 1}`,
      text,
      lines: Math.min(chunkLines, lines.length - start),
      chars: text.length,
    });
  }
  return chunks;
}

function stateFor(
  input: TrimOutputInput,
  chunks: readonly OutputChunk[],
  history: HistoryEntry[],
) {
  return {
    context: OUTPUT_CONTEXT,
    task: input.goal,
    history,
    command: input.command,
    chunks: chunks.map(({ id, text }) => ({ id, text })),
  };
}

function questionFor(chunk: OutputChunk): JevQuestions {
  const n = chunk.id.slice(1);
  return {
    [chunk.id]: {
      type: 'noul',
      instructions: `Chunk c${n} must stay visible to the agent for it to understand the result of the command and continue its task.`,
      criteria: {
        true: 'The chunk contains an error, failure, warning, summary, final result, or information the task depends on.',
        false: 'The chunk is repetitive, verbose, or boilerplate output the agent can act without.',
      },
    },
  };
}

function batches(
  chunks: readonly OutputChunk[],
  stateTokens: number,
): OutputChunk[][] {
  const budget = MAX_REQUEST_TOKENS - stateTokens;
  const result: OutputChunk[][] = [];
  let current: OutputChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const tokens = estimateStateTokens(JSON.stringify(questionFor(chunk)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      result.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for output questions (~${stateTokens} of ${MAX_REQUEST_TOKENS} tokens)`,
      );
    }
    current.push(chunk);
    currentTokens += tokens;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function outputMarker(
  chunks: readonly OutputChunk[],
  fullOutputPath: string | undefined,
): string {
  const lines = chunks.reduce((sum, chunk) => sum + chunk.lines, 0);
  const chars =
    chunks.reduce((sum, chunk) => sum + chunk.chars, 0) + Math.max(0, chunks.length - 1);
  return `[fast-jev-output trimmed ${lines} lines (${chars} chars)${
    fullOutputPath
      ? `; full output: ${fullOutputPath} (Read or grep it if needed)`
      : '; not saved to disk, re-run the command if you need these lines'
  }]`;
}

function untrimmed(output: string, chunks: number, scores: number[]): TrimOutputResult {
  return {
    output,
    trimmed: false,
    chunks,
    kept: chunks,
    dropped: 0,
    charsBefore: output.length,
    charsAfter: output.length,
    scores,
  };
}

function maxTokensExceeded(error: unknown): boolean {
  return error instanceof Error && error.message.includes('max_tokens_exceeded');
}

async function trimOutputAttempt(
  input: TrimOutputInput,
  asker: JevAsker,
  options: TrimOutputOptions = {},
  retriesRemaining = 2,
): Promise<TrimOutputResult> {
  const minChars = Math.max(0, finite(options.minChars, DEFAULT_MIN_CHARS));
  const chunkLines = Math.max(
    1,
    Math.floor(finite(options.chunkLines, DEFAULT_CHUNK_LINES)),
  );
  const keepThreshold = finite(options.keepThreshold, DEFAULT_KEEP_THRESHOLD);
  const maxScoringRequests = Math.max(
    1,
    Math.floor(finite(options.maxScoringRequests, DEFAULT_MAX_SCORING_REQUESTS)),
  );
  const maxStateTokens = Math.max(
    1,
    finite(options.maxStateTokens, DEFAULT_MAX_STATE_TOKENS),
  );

  if (input.output.length <= minChars) return untrimmed(input.output, 0, []);

  if (looksBinary(input.output) || looksStructured(input.command, input.output)) {
    return untrimmed(input.output, 0, []);
  }

  const lineCount = splitLongLines(input.output).length;
  const perChunk = Math.max(chunkLines, Math.ceil(lineCount / MAX_CHUNKS));
  const chunks = chunkOutput(input.output, perChunk);
  if (chunks.length <= 2) return untrimmed(input.output, chunks.length, []);

  let stateChunks = chunks.map((chunk) => ({ ...chunk }));
  const outputTokens = estimateStateTokens(JSON.stringify(stateFor(input, stateChunks, [])));
  const history = fitHistory(
    input.messages ?? [],
    maxStateTokens - Math.min(outputTokens, Math.ceil(maxStateTokens / 2)),
  );
  let state = stateFor(input, stateChunks, history);
  let stateTokens = estimateStateTokens(JSON.stringify(state));
  let omitted = new Set<number>();
  if (stateTokens > maxStateTokens) {
    let perChunkChars = 400;
    while (stateTokens > maxStateTokens) {
      stateChunks = chunks
        .filter((_, index) => !omitted.has(index))
        .map((chunk) => ({ ...chunk, text: chunk.text.slice(0, perChunkChars) }));
      state = stateFor(input, stateChunks, history);
      stateTokens = estimateStateTokens(JSON.stringify(state));
      if (stateTokens <= maxStateTokens || perChunkChars === 50) break;
      perChunkChars = Math.max(50, Math.floor(perChunkChars / 2));
    }

    if (stateTokens > maxStateTokens) {
      const middle = (chunks.length - 1) / 2;
      const candidates = chunks
        .map((_, index) => index)
        .filter(
          (index) =>
            index !== 0 &&
            index !== chunks.length - 1 &&
            !omitted.has(index) &&
            !ERROR_PATTERN.test(chunks[index]!.text),
        )
        .sort((left, right) => {
          const distance = Math.abs(left - middle) - Math.abs(right - middle);
          return distance || left - right;
        });
      for (let start = 0; stateTokens > maxStateTokens && start < candidates.length; start += 10) {
        for (const index of candidates.slice(start, start + 10)) omitted.add(index);
        stateChunks = chunks
          .filter((_, index) => !omitted.has(index))
          .map((chunk) => ({ ...chunk, text: chunk.text.slice(0, 50) }));
        state = stateFor(input, stateChunks, history);
        stateTokens = estimateStateTokens(JSON.stringify(state));
      }
    }
  }

  if (stateTokens > maxStateTokens) return untrimmed(input.output, chunks.length, []);

  const asked = chunks.filter((_, index) => !omitted.has(index));
  const scores = Array<number>(chunks.length).fill(0);
  scores[0] = 1;
  scores[chunks.length - 1] = 1;
  try {
    const questionBatches = batches(asked, stateTokens);
    const answered = await Promise.all(
      questionBatches.map(async (batch) => {
        const questions = Object.assign({}, ...batch.map(questionFor));
        return asker.ask(state, questions);
      }),
    );
    let answerOffset = 0;
    for (const batch of questionBatches) {
      const response = answered[answerOffset++];
      if (!response) throw new Error('Missing Jev output answer batch');
      for (const chunk of batch) {
        scores[chunks.indexOf(chunk)] = noulAnswer(response.answers, chunk.id);
      }
    }
  } catch (error) {
    if (maxTokensExceeded(error) && retriesRemaining > 0 && maxStateTokens >= 2_000) {
      return trimOutputAttempt(
        input,
        asker,
        { ...options, maxStateTokens: Math.floor(maxStateTokens / 2) },
        retriesRemaining - 1,
      );
    }
    throw error;
  }

  // Chunks the state could not hold are scored in their own passes, over a
  // state carrying just them: unscored chunks used to be kept blind and then
  // dropped first by the budget, which lost a quiet line the task needed.
  if (omitted.size > 0) {
    const leftovers = chunks.filter((_, index) => omitted.has(index));
    const scored = new Set<number>();
    for (let start = 0; start < leftovers.length; start += LEFTOVER_PASS_CHUNKS) {
      const slice = leftovers.slice(start, start + LEFTOVER_PASS_CHUNKS);
      const sliceState = stateFor(input, slice, history);
      const sliceTokens = estimateStateTokens(JSON.stringify(sliceState));
      if (sliceTokens > maxStateTokens) continue;
      try {
        const answered = await Promise.all(
          batches(slice, sliceTokens).map(async (batch) => {
            const questions = Object.assign({}, ...batch.map(questionFor));
            const response = await asker.ask(sliceState, questions);
            return batch.map((chunk) => [chunk, noulAnswer(response.answers, chunk.id)] as const);
          }),
        );
        for (const [chunk, score] of answered.flat()) {
          const index = chunks.indexOf(chunk);
          scores[index] = score;
          scored.add(index);
        }
      } catch {
        // Leave this slice unscored; it stays kept, as before.
      }
    }
    for (const index of scored) omitted.delete(index);
  }

  return assemble(input, chunks, scores, omitted, {
    keepThreshold,
    maxChars: Math.max(0, finite(options.maxChars, 0)),
    history,
    asker,
    maxStateTokens,
  });
}

async function assemble(
  input: TrimOutputInput,
  chunks: readonly OutputChunk[],
  scores: number[],
  omitted: Set<number>,
  opts: {
    keepThreshold: number;
    maxChars: number;
    history: HistoryEntry[];
    asker: JevAsker;
    maxStateTokens: number;
  },
): Promise<TrimOutputResult> {
  const { keepThreshold, maxChars, history, asker, maxStateTokens } = opts;
  const keptIndexes = new Set<number>();
  for (let index = 0; index < chunks.length; index += 1) {
    if (
      omitted.has(index) ||
      index === 0 ||
      index === chunks.length - 1 ||
      ERROR_PATTERN.test(chunks[index]!.text) ||
      scores[index]! >= keepThreshold
    ) {
      keptIndexes.add(index);
    }
  }
  const shrunk = new Map<number, string>();
  if (maxChars > 0) {
    const kept = [...keptIndexes].sort((a, b) => a - b);
    const size = () =>
      kept.reduce((sum, index) => sum + (shrunk.get(index) ?? chunks[index]!.text).length + 1, 0);
    for (const index of [...kept].sort(
      (a, b) => chunks[b]!.chars - chunks[a]!.chars,
    )) {
      if (size() <= maxChars) break;
      let text: string;
      try {
        text = await shrinkChunkWithJev(
          chunks[index]!,
          input,
          history,
          asker,
          keepThreshold,
          maxStateTokens,
        );
      } catch {
        text = shrinkChunkText(chunks[index]!.text);
      }
      if (text.length < chunks[index]!.chars) shrunk.set(index, text);
    }
  }
  if (maxChars > 0) {
    const size = () =>
      [...keptIndexes].reduce(
        (sum, index) => sum + (shrunk.get(index) ?? chunks[index]!.text).length + 1,
        0,
      );
    // First and last stay, and so does anything that looks like an error or a
    // failure: a budget must never be the reason the one line the agent needs
    // disappears. The rest goes lowest score first, and the budget is missed
    // rather than met if that is not enough.
    const droppable = [...keptIndexes]
      .filter(
        (index) =>
          index !== 0 &&
          index !== chunks.length - 1 &&
          !ERROR_PATTERN.test(chunks[index]!.text),
      )
      .sort((a, b) => (scores[a] ?? 0) - (scores[b] ?? 0));
    for (const index of droppable) {
      if (size() <= maxChars) break;
      keptIndexes.delete(index);
    }
  }
  // Hard fit: shrinking and dropping are both best-effort, so when the kept
  // chunks still exceed the budget (a grep where nearly every line is wanted),
  // fill the budget by priority — reported failures first, then the highest
  // scores — and cut the chunk that straddles the line.
  if (maxChars > 0) {
    const textOf = (index: number) => shrunk.get(index) ?? chunks[index]!.text;
    const size = () =>
      [...keptIndexes].reduce((sum, index) => sum + textOf(index).length + 1, 0);
    if (size() > maxChars) {
      const priority = [...keptIndexes].sort((a, b) => {
        const errors =
          Number(ERROR_PATTERN.test(chunks[b]!.text)) - Number(ERROR_PATTERN.test(chunks[a]!.text));
        if (errors) return errors;
        const edges = Number(b === 0 || b === chunks.length - 1) - Number(a === 0 || a === chunks.length - 1);
        if (edges) return edges;
        return (scores[b] ?? 0) - (scores[a] ?? 0);
      });
      const fitted = new Set<number>();
      let used = 0;
      for (const index of priority) {
        const text = textOf(index);
        if (used + text.length + 1 <= maxChars) {
          fitted.add(index);
          used += text.length + 1;
          continue;
        }
        const room = maxChars - used - 80;
        if (room > 200 && fitted.size === 0) {
          shrunk.set(index, `${text.slice(0, room)}\n[fast-jev-output cut this section to fit]`);
          fitted.add(index);
          used = maxChars;
        }
      }
      for (const index of [...keptIndexes]) if (!fitted.has(index)) keptIndexes.delete(index);
    }
  }
  const droppedIndexes = chunks
    .map((_, index) => index)
    .filter((index) => !keptIndexes.has(index));
  if (droppedIndexes.length === 0) return untrimmed(input.output, chunks.length, scores);

  const parts: string[] = [];
  for (let index = 0; index < chunks.length;) {
    if (keptIndexes.has(index)) {
      parts.push(shrunk.get(index) ?? chunks[index]!.text);
      index += 1;
      continue;
    }
    const run: OutputChunk[] = [];
    while (index < chunks.length && !keptIndexes.has(index)) run.push(chunks[index++]!);
    parts.push(outputMarker(run, input.fullOutputPath));
  }
  const output = parts.join('\n');
  return {
    output,
    trimmed: true,
    chunks: chunks.length,
    kept: keptIndexes.size,
    dropped: droppedIndexes.length,
    charsBefore: input.output.length,
    charsAfter: output.length,
    scores,
  };
}


/**
 * Last resort when the kept chunks alone exceed the budget: inside a chunk,
 * keep the lines that look like errors plus a little context, and say how many
 * lines went. Better than handing back a chunk that will be replaced by a
 * head-of-file preview anyway.
 */
function shrinkChunkText(text: string, keepEdge = 2): string {
  const lines = text.split('\n');
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (ERROR_PATTERN.test(line)) {
      for (let at = index - 1; at <= index + 1; at += 1) if (at >= 0 && at < lines.length) keep.add(at);
    }
  });
  for (let index = 0; index < Math.min(keepEdge, lines.length); index += 1) keep.add(index);
  for (let index = Math.max(0, lines.length - keepEdge); index < lines.length; index += 1) keep.add(index);
  if (keep.size === lines.length) return text;
  const parts: string[] = [];
  let removed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (keep.has(index)) {
      if (removed > 0) {
        parts.push(`[fast-jev-output trimmed ${removed} more lines from this section]`);
        removed = 0;
      }
      parts.push(lines[index]!);
    } else removed += 1;
  }
  if (removed > 0) parts.push(`[fast-jev-output trimmed ${removed} more lines from this section]`);
  return parts.join('\n');
}

const REFINE_GROUP_LINES = 5;
const LEFTOVER_PASS_CHUNKS = 40;
const DEFAULT_MAX_SCORING_REQUESTS = 40;
const SLICE_CONCURRENCY = 4;

/**
 * Asks Jev, line group by line group, what to keep inside one oversized chunk —
 * the same noul question as the chunk pass, over the same state, so the last
 * decision is Jev's rather than a regex. Lines that look like errors are kept
 * whatever Jev says, and a failed request falls back to the regex shrink.
 */
async function shrinkChunkWithJev(
  chunk: OutputChunk,
  input: TrimOutputInput,
  history: HistoryEntry[],
  asker: JevAsker,
  keepThreshold: number,
  maxStateTokens: number,
): Promise<string> {
  const lines = chunk.text.split('\n');
  if (lines.length <= REFINE_GROUP_LINES * 2) return chunk.text;
  const groups: OutputChunk[] = [];
  for (let start = 0; start < lines.length; start += REFINE_GROUP_LINES) {
    const text = lines.slice(start, start + REFINE_GROUP_LINES).join('\n');
    groups.push({ id: `g${groups.length + 1}`, text, lines: Math.min(REFINE_GROUP_LINES, lines.length - start), chars: text.length });
  }
  const state = stateFor({ ...input, output: chunk.text }, groups, history);
  if (estimateStateTokens(JSON.stringify(state)) > maxStateTokens) {
    return shrinkChunkText(chunk.text);
  }
  let scores: number[];
  try {
    const answered = await Promise.all(
      batches(groups, estimateStateTokens(JSON.stringify(state))).map(async (batch) => {
        const questions = Object.assign({}, ...batch.map(questionFor));
        const response = await asker.ask(state, questions);
        return batch.map((group) => [group.id, noulAnswer(response.answers, group.id)] as const);
      }),
    );
    const byId = new Map(answered.flat());
    scores = groups.map((group) => byId.get(group.id) ?? 0);
  } catch {
    return shrinkChunkText(chunk.text);
  }
  const keep = new Set<number>([0, groups.length - 1]);
  groups.forEach((group, index) => {
    if (scores[index]! >= keepThreshold || ERROR_PATTERN.test(group.text)) keep.add(index);
  });
  if (keep.size === groups.length) return chunk.text;
  const parts: string[] = [];
  let removed = 0;
  groups.forEach((group, index) => {
    if (keep.has(index)) {
      if (removed > 0) {
        parts.push(`[fast-jev-output trimmed ${removed} more lines from this section]`);
        removed = 0;
      }
      parts.push(group.text);
    } else removed += group.lines;
  });
  if (removed > 0) parts.push(`[fast-jev-output trimmed ${removed} more lines from this section]`);
  return parts.join('\n');
}

export async function trimOutput(
  input: TrimOutputInput,
  asker: JevAsker,
  options?: TrimOutputOptions,
): Promise<TrimOutputResult> {
  return trimOutputAttempt(input, asker, options, 2);
}
