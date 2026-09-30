import { describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';
import { classifyOutput, trimOutput } from '../src/output.js';
import { diagnosticSectionLines } from '../src/retention.js';

const progress = Array.from({ length: 400 }, (_, index) =>
  `tests/test_cache.py::test_entry_${index} PASSED ${' '.repeat(60)}[ 50%]`,
);
const diagnostics = [
  '=================================== FAILURES ===================================',
  '_____________________________ test_capture ______________________________',
  '',
  '    def test_capture(capsys):',
  ...Array.from({ length: 55 }, (_, index) => `        value_${index} = capture(${index})`),
  '>       assert captured == "expected"',
  "E       AssertionError: assert 'actual' == 'expected'",
  'tests/test_capture.py:64: AssertionError',
  '----------------------------- Captured stdout call -----------------------------',
  'release identifier = stable-deployment',
  '--- expected',
  '+++ actual',
  '@@ -1 +1 @@',
  '-expected',
  '+actual',
  '=============================== warnings summary ===============================',
  'tests/test_capture.py:5: UserWarning: deprecated fixture',
  '    initialize_capture()',
  '=========================== short test summary info ============================',
  'FAILED tests/test_capture.py::test_capture - AssertionError',
  '======================== 1 failed, 400 passed in 1.68s =========================',
];
const mixed = (section = diagnostics) => [
  '============================= test session starts ==============================',
  ...progress, ...section, ...progress,
].join('\n');
const score = (probability = 0) => vi.fn(async (_state: JevState, questions: JevQuestions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: probability }])),
}));

describe('reference material inside test diagnostics', () => {
  it.each(['pytest -v', 'node diagnostic-collector.mjs', 'npm test'])(
    'allows mixed output from %s to reach scoring', async command => {
      const output = mixed();
      const ask = score();
      expect(estimateTokens(output)).toBeGreaterThan(10_000);
      expect(classifyOutput(command, output)).not.toBe('document');
      const result = await trimOutput({ command, output, goal: 'Diagnose the failure.' }, { ask });
      expect(ask).toHaveBeenCalled();
      expect(result.trimmed).toBe(true);
      expect(result.output).toContain(diagnostics.join('\n'));
      expect(result.output).not.toContain(progress[200]);
    },
  );

  it.each([
    { chunkLines: 1 },
    { chunkLines: 20 },
    { chunkChars: 1_200 },
  ])('retains entire diagnostic sections across chunk boundaries: %j', async options => {
    const result = await trimOutput(
      { command: 'pytest', output: mixed(), goal: 'Diagnose the failure.' },
      { ask: score() }, options,
    );
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(diagnostics.join('\n'));
    expect(result.output).not.toContain(progress[200]);
  });

  it.each([false, true])('preserves source and captured context during refinement (compact=%s)', async compactMarkers => {
    const ask = score();
    const maxChars = diagnostics.join('\n').length + 1_500;
    const result = await trimOutput(
      { command: 'pytest', output: mixed(), goal: 'Diagnose the failure.', fullOutputPath: '/logs/full.txt' },
      { ask }, { maxChars, compactMarkers },
    );
    expect(ask.mock.calls.some(([, questions]) => Object.keys(questions).some(id => id.startsWith('g')))).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.charsAfter).toBeLessThanOrEqual(maxChars);
    expect(result.output).toContain(diagnostics.join('\n'));
    expect(result.output).not.toContain(progress[200]);
  });

  it('skips scoring when the diagnostic section cannot fit', async () => {
    const ask = score();
    const onDecision = vi.fn();
    const output = mixed();
    const result = await trimOutput(
      { command: 'pytest', output, goal: 'Diagnose.' }, { ask },
      { maxChars: diagnostics.join('\n').length - 1, onDecision },
    );
    expect(result.output).toBe(output);
    expect(onDecision).toHaveBeenCalledWith('budget_unfit');
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps the rest of an incomplete diagnostic section', async () => {
    const section = diagnostics.slice(0, 50);
    const output = [...progress, ...progress, ...section].join('\n');
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    const result = await trimOutput(
      { command: 'pytest', output, goal: 'Diagnose.' }, { ask: score() },
    );
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(section.join('\n'));
  });

  it.each(['FAILURES', 'ERRORS', 'warnings summary', 'short test summary info'])(
    'retains every line in a %s section, including CRLF output', async title => {
      const section = [`=== ${title} ===`, ...diagnostics.slice(1)];
      const output = mixed(section).replace(/\n/g, '\r\n');
      const result = await trimOutput(
        { command: 'pytest', output, goal: 'Diagnose.' }, { ask: score() },
      );
      expect(result.trimmed).toBe(true);
      expect(result.output).toContain(section.join('\r\n'));
    },
  );

  it('handles repeated test sessions without protecting intervening progress', async () => {
    const output = `${mixed()}\n${mixed()}`;
    const sections = diagnosticSectionLines(output.split('\n'));
    expect(sections.size).toBe(diagnostics.length * 2);
    const result = await trimOutput(
      { command: 'pytest && pytest', output, goal: 'Compare failures.' }, { ask: score() },
    );
    expect(result.trimmed).toBe(true);
    expect(result.output.split(diagnostics.join('\n'))).toHaveLength(3);
    expect(result.output).not.toContain(progress[200]);
  });

  it('does not treat a split long line as the end of a diagnostic section', async () => {
    const section = [
      diagnostics[0]!,
      `${'x'.repeat(2_000)}=== 999 passed in 1.0s ===`,
      ...diagnostics.slice(1),
    ];
    const result = await trimOutput(
      { command: 'pytest', output: mixed(section), goal: 'Diagnose.' }, { ask: score() },
    );
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(diagnostics.slice(1).join('\n'));
  });

  it.each([
    '# Setup instructions\nRun the setup command first.',
    'def configure():\n    return "required"',
    '  401c23:\tucomiss xmm6,xmm2',
    'diff --git a/config b/config\n--- a/config\n+++ b/config',
  ])('preserves independent reference material before or after diagnostics: %s', async reference => {
    for (const output of [`${reference}\n${mixed()}`, `${mixed()}\n${reference}`]) {
      const ask = score();
      const result = await trimOutput({ command: 'pytest', output, goal: 'Inspect.' }, { ask });
      expect(result.output).toBe(output);
      expect(ask).not.toHaveBeenCalled();
    }
  });

  it('keeps whole-document commands even when their content resembles a test log', async () => {
    const ask = score();
    const output = mixed();
    const result = await trimOutput({ command: 'cat reference.txt', output, goal: 'Read.' }, { ask });
    expect(result.output).toBe(output);
    expect(ask).not.toHaveBeenCalled();
  });

  it('preserves source in unrecognized diagnostic formats without scoring', async () => {
    const ask = score();
    const output = mixed(['A custom failure report:', 'def test_capture():', '    capture()', 'AssertionError']);
    const result = await trimOutput({ command: 'custom-check', output, goal: 'Inspect.' }, { ask });
    expect(result.output).toBe(output);
    expect(ask).not.toHaveBeenCalled();
  });

  it('retains uncertain progress even when diagnostic sections are recognized', async () => {
    const output = mixed();
    const result = await trimOutput({ command: 'pytest', output, goal: 'Inspect.' }, { ask: score(0.2) });
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });
});
