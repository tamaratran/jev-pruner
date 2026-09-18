import { estimateStateTokens } from './jev.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: readonly {
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
    text?: string;
    result?: unknown;
    isError?: boolean;
  }[];
  toolResults?: readonly {
    tool_use_id: string;
    text: string;
    result?: unknown;
    isError?: boolean;
  }[];
}

export interface HistoryEntry {
  i: number;
  role: ConversationMessage['role'];
  text: string;
  tool_calls?: {
    id: string;
    tool: string;
    input: string;
    result: string;
  }[];
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function inputText(input: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(input), 1_000);
  } catch {
    return '[unserializable input]';
  }
}

function historyEntries(messages: readonly ConversationMessage[]): HistoryEntry[] {
  const results = new Map(
    messages.flatMap((message) =>
      (message.toolResults ?? []).map((result) => [result.tool_use_id, result] as const),
    ),
  );
  let callId = 0;
  return messages.flatMap((message, i) => {
    const toolCalls = message.toolUses.map((tool) => {
      const result = results.get(tool.tool_use_id) ??
        (tool.text !== undefined || tool.result !== undefined || tool.isError ? tool : undefined);
      return {
        id: `t${++callId}`,
        tool: tool.tool,
        input: inputText(tool.input),
        result: result
          ? `${result.isError ? 'error' : 'ok'}, ${result.text?.length ?? 0} chars (omitted)`
          : 'pending',
      };
    });
    if (message.text.trim().length === 0 && toolCalls.length === 0) return [];
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    return [entry];
  });
}

export function fitHistory(
  messages: readonly ConversationMessage[],
  maxTokens: number,
): HistoryEntry[] {
  const history = historyEntries(messages);
  if (history.length === 0) return history;
  const entryTokens = (entry: HistoryEntry): number =>
    estimateStateTokens(JSON.stringify(entry)) + 1;
  const perEntry = history.map(entryTokens);
  let tokens = estimateStateTokens('[]') + perEntry.reduce((sum, count) => sum + count, 0);
  const fits = (): boolean => tokens <= maxTokens;
  const updateTokens = (index: number): void => {
    const now = entryTokens(history[index]!);
    tokens += now - perEntry[index]!;
    perEntry[index] = now;
  };
  if (fits()) return history;

  for (const limit of [200, 60]) {
    history.forEach((entry, index) => {
      for (const call of entry.tool_calls ?? []) call.input = truncate(call.input, limit);
      updateTokens(index);
    });
    if (fits()) return history;
  }

  const pinned = (entry: HistoryEntry): boolean =>
    entry.i === 0 || entry.i >= messages.length - 6;
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];
  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= 590) continue;
    entry.text = `${entry.text.slice(0, 400)}\n[… ${entry.text.length - 550} chars omitted …]\n${entry.text.slice(-150)}`;
    updateTokens(index);
    if (fits()) return history;
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    entry.text = `[… ${messages[entry.i]!.text.length} chars omitted …]`;
    updateTokens(index);
    if (fits()) return history;
  }

  const omitted = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    omitted.add(index);
    tokens -= perEntry[index]!;
    if (fits()) return history.filter((_, i) => !omitted.has(i));
  }
  throw new Error(`history too large for Jev (~${tokens} tokens, limit ${maxTokens})`);
}
