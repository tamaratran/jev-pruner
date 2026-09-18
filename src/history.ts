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
  tool_results?: { id: string; result: string }[];
  part?: {
    field: 'text' | 'tool_calls.input' | 'tool_calls.result' | 'tool_results.result';
    offset: number;
    total_chars: number;
  };
}

function resultText(result: { text?: string; result?: unknown; isError?: boolean }): string {
  return JSON.stringify({ text: result.text, data: result.result, isError: result.isError ?? false });
}

export function historyEntries(messages: readonly ConversationMessage[]): HistoryEntry[] {
  const results = new Map(
    messages.flatMap((message) =>
      (message.toolResults ?? []).map((result) => [result.tool_use_id, resultText(result)] as const),
    ),
  );
  return messages.flatMap((message, i) => {
    const toolCalls = message.toolUses.map((tool) => {
      const embedded = tool.text !== undefined || tool.result !== undefined || tool.isError !== undefined;
      const result = embedded ? resultText(tool) : undefined;
      return {
        id: tool.tool_use_id,
        tool: tool.tool,
        input: JSON.stringify(tool.input),
        result: results.has(tool.tool_use_id) && (!embedded || results.get(tool.tool_use_id) === result)
          ? 'see tool_results with this id'
          : result ?? 'pending',
      };
    });
    const toolResults = (message.toolResults ?? []).map(result => ({
      id: result.tool_use_id,
      result: resultText(result),
    }));
    if (message.text.length === 0 && toolCalls.length === 0 && toolResults.length === 0) return [];
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    if (toolResults.length > 0) entry.tool_results = toolResults;
    return [entry];
  });
}

function splitEntry(entry: HistoryEntry, maxTokens: number): HistoryEntry[] {
  const fits = (part: HistoryEntry): boolean =>
    estimateStateTokens(JSON.stringify([part])) <= maxTokens;
  if (fits(entry)) return [entry];
  const fragments: HistoryEntry[] = [];
  const splitField = (
    text: string,
    field: NonNullable<HistoryEntry['part']>['field'],
    make: (text: string) => HistoryEntry,
  ): void => {
    let offset = 0;
    const fragment = (length: number): HistoryEntry => ({
      ...make(text.slice(offset, offset + length)),
      part: { field, offset, total_chars: text.length },
    });
    do {
      let low = 0;
      let high = text.length - offset;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(fragment(mid))) low = mid;
        else high = mid - 1;
      }
      if (low > 0 && /[\uD800-\uDBFF]/.test(text[offset + low - 1]!) && offset + low < text.length) low -= 1;
      if ((low === 0 && offset < text.length) || !fits(fragment(low))) {
        throw new Error(`history fragment cannot fit in ${maxTokens} tokens`);
      }
      if (offset + low < text.length) {
        const newline = text.lastIndexOf('\n', offset + low - 1);
        if (newline >= offset + low / 2) low = newline - offset + 1;
      }
      fragments.push(fragment(low));
      offset += low;
    } while (offset < text.length);
  };
  const base = { i: entry.i, role: entry.role, text: '' };
  if (entry.text.length > 0) splitField(entry.text, 'text', text => ({ ...base, text }));
  for (const call of entry.tool_calls ?? []) {
    splitField(call.input, 'tool_calls.input', input => ({
      ...base, tool_calls: [{ ...call, input, result: '' }],
    }));
    splitField(call.result, 'tool_calls.result', result => ({
      ...base, tool_calls: [{ ...call, input: '', result }],
    }));
  }
  for (const result of entry.tool_results ?? []) {
    splitField(result.result, 'tool_results.result', text => ({
      ...base, tool_results: [{ id: result.id, result: text }],
    }));
  }
  return fragments;
}

export function splitHistory(
  messages: readonly ConversationMessage[],
  maxTokens: number,
): HistoryEntry[][] {
  const segments: HistoryEntry[][] = [];
  let current: HistoryEntry[] = [];
  for (const entry of historyEntries(messages)) {
    for (const fragment of splitEntry(entry, maxTokens)) {
      if (current.length > 0 && estimateStateTokens(JSON.stringify([...current, fragment])) > maxTokens) {
        segments.push(current);
        current = [];
      }
      current.push(fragment);
    }
  }
  if (current.length > 0 || segments.length === 0) segments.push(current);
  return segments;
}
