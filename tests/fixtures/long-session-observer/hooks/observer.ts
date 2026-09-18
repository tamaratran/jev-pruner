import type { Register } from 'claude-code';

export const register: Register = (on) => {
  let requests = 0;
  let reads = 0;
  on('session.messages', async ($, event, next) => {
    const answer = await next(event);
    if (answer.value) {
      await $.fs.write(`.claude/jev-long-session-evidence/history-${++reads}.json`, JSON.stringify({
        messages: answer.value.length,
        textChars: answer.value.reduce((sum, message) => sum + message.text.length, 0),
        toolResultChars: answer.value.reduce((sum, message) =>
          sum + message.toolUses.reduce((n, tool) => n + (tool.text?.length ?? 0), 0) +
          (message.toolResults ?? []).reduce((n, tool) => n + tool.text.length, 0), 0),
      }));
    }
    return answer;
  });
  on('http.fetch', async ($, event, next) => {
    if (event.url !== 'https://api.typesafe.ai/v1/systemone') return next(event);
    const id = ++requests;
    const started = Date.now();
    const answer = await next(event);
    if (answer.value && event.init?.body) {
      await $.fs.write(`.claude/jev-long-session-evidence/request-${id}.json`, JSON.stringify({
        request: JSON.parse(event.init.body),
        response: { status: answer.value.status, body: JSON.parse(answer.value.text) },
        durationMs: Date.now() - started,
      }));
    }
    return answer;
  });
};
