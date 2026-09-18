import type { ConversationMessage } from '../history.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

export function codexMessages(transcript: string, sessionId: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let matchedSession = false;
  for (const line of transcript.split('\n').filter(line => line.trim())) {
    const entry = record(JSON.parse(line));
    const payload = record(entry.payload);
    if (entry.type === 'session_meta') {
      if (payload.id !== sessionId) throw new Error('Transcript session mismatch');
      matchedSession = true;
    }
    if (entry.type !== 'response_item') continue;
    if (payload.type === 'reasoning') continue;
    if (payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      if (!Array.isArray(payload.content)) throw new Error('Invalid message content');
      messages.push({
        role: payload.role,
        text: payload.content.map((part: unknown) => {
          const content = record(part);
          return typeof content.text === 'string' ? content.text : JSON.stringify(content);
        }).join('\n'),
        toolUses: [],
      });
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      if (typeof payload.call_id !== 'string' || typeof payload.name !== 'string') {
        throw new Error('Invalid tool call');
      }
      messages.push({
        role: 'assistant',
        text: '',
        toolUses: [{
          tool_use_id: payload.call_id,
          tool: payload.name,
          input: payload.type === 'function_call'
            ? { arguments: payload.arguments }
            : { input: payload.input },
        }],
      });
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      if (typeof payload.call_id !== 'string' || payload.output === undefined) {
        throw new Error('Invalid tool result');
      }
      messages.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{
          tool_use_id: payload.call_id,
          text: typeof payload.output === 'string' ? payload.output : '',
          result: typeof payload.output === 'string' ? undefined : payload.output,
        }],
      });
    } else {
      messages.push({ role: 'assistant', text: JSON.stringify(payload), toolUses: [] });
    }
  }
  if (!matchedSession || !messages.length) throw new Error('Missing session history');
  return messages;
}
