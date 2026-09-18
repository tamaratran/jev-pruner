import type { Register } from 'claude-code';

const root = '/logs/agent/jev';

export const register: Register = (on) => {
  let requests = 0;
  let logs = 0;
  let calls = 0;
  on('session.start', async ($, event, next) => {
    await $.fs.write(`${root}/activated.json`, JSON.stringify({ observerLoaded: true }));
    return next(event);
  });
  on('http.fetch', async ($, event, next) => {
    if (event.url !== 'https://api.typesafe.ai/v1/systemone') return next(event);
    const id = ++requests;
    const started = Date.now();
    await $.fs.write(`${root}/request-${id}-started.json`, JSON.stringify({
      request: event.init?.body ? JSON.parse(event.init.body) : null,
    }));
    const answer = await next(event);
    await $.fs.write(`${root}/request-${id}.json`, JSON.stringify({
      durationMs: Date.now() - started,
      response: answer.value
        ? { status: answer.value.status, body: answer.value.text }
        : null,
      deny: answer.deny,
    }));
    return answer;
  });
  on('ui.log', async ($, event, next) => {
    await $.fs.write(`${root}/log-${++logs}.json`, JSON.stringify(event));
    return next(event);
  });
  on('fs.write', async ($, event, next) => {
    const answer = await next(event);
    const filename = event.path.match(/(?:^|\/)\.claude\/fast-jev-output\/(bash-[^/]+\.txt)$/)?.[1];
    if (filename) await $.fs.write(`${root}/archives/${filename}`, event.text);
    return answer;
  });
  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const id = ++calls;
    const started = Date.now();
    const answer = await next(event);
    const archive = answer.deny === undefined && !answer.isError
      ? answer.result?.stdout.match(
        /\[fast-jev-output full output: ([^\n]+) \(Read or grep it if needed\)\]/,
      )?.[1]
      : undefined;
    if (archive && event.tool_use_id) {
      try {
        await $.fs.write(
          `${root}/archives/bash-${event.tool_use_id}.txt`,
          await $.fs.read(archive),
        );
      } catch {
        $.ui.log('Evaluation observer could not capture original Bash output');
      }
    }
    await $.fs.write(`${root}/bash-${id}.json`, JSON.stringify({
      toolUseId: event.tool_use_id,
      command: event.command,
      durationMs: Date.now() - started,
      answer,
    }));
    return answer;
  });
};
