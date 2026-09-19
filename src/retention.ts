export type InformationCategory = 'reference' | 'diagnostic' | 'result' | 'progress' | 'unknown';

const REFERENCE_PATTERN = new RegExp([
  '^#{1,6} +\\S|^```|^~~~',
  '^---\\r?\\n[\\w-]+:',
  '^\\S[^\\n]*\\n(?:={3,}|-{3,})\\s*$',
  '^Help on (?:class|function|module)',
  '^\\s*\\|?\\s*(?:Parameters|Returns|Examples)\\s*$',
  '^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|def)\\s+\\w',
  '^\\s*(?:export\\s+)?(?:const|let|var)\\s+\\w+\\s*[=:]',
  '^\\s*(?:from\\s+[\\w.]+\\s+import|import\\s+.+(?:from\\s+|;|$))',
  '^\\s*#include\\s*[<"]',
  '^\\s*(?:(?:static|inline|const)\\s+)*(?:void|int|char|float|double|bool)\\s+\\w+\\s*\\(',
  '^\\s*(?:0x)?[\\da-fA-F]{4,}:\\s+(?:(?:[\\da-fA-F]{2}\\s+)+)?[a-zA-Z][\\w.]*\\s+\\S',
  '^\\s*[\\da-fA-F]{4,}\\s+<[^>]+>:\\s*$',
].join('|'), 'm');

const DIAGNOSTIC_PATTERN = new RegExp(
  [
    '\\b(ERROR|FATAL|FAILED|FAILURE|PANIC|WARN|WARNING)\\b',
    '\\b(error|warning|failure|exception|panic|traceback|assertion)s?\\s*:',
    '\\berror TS\\d+:|^E\\s+\\S',
    '\\b(failed|failing|cannot|could not|unable to|denied|refused|timed out)\\s+\\w',
    '\\b\\w*(Error|Exception)\\b\\s*[:(]',
    '\\bTraceback \\(most recent call last\\)',
    '^\\s*at\\s+\\S+\\(.*:\\d+',
    '\\b(severity )?vulnerabilit(y|ies)\\b',
    '\\bCrashLoopBackOff\\b|\\bOOMKilled\\b',
    '\\bHTTP/[0-9.]+ [45]\\d\\d\\b|\\bstatus[=: ]\\s*[45]\\d\\d\\b',
  ].join('|'),
  'm',
);
const RESULT_PATTERN = /^\s*(?:(?:Test Suites|Tests|Snapshots|Coverage|Results?|Summary|Exit code|Exit status)\s*:|(?:Build|Compilation|Tests?)\s+(?:succeeded|completed|finished|passed|failed)\b|(?:Artifact|Output file|Report|Coverage report)(?: path)?\s*[:=]\s*\S)/im;
const PYTEST_RESULT_PATTERN = /^=+ .*\b\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed|errors?|warnings?)\b.*=+\s*$/im;
const TEST_PROGRESS_PATTERN = /^\S+::\S+\s+PASSED(?:\s+\[\s*\d+%\])?\s*$/i;
const PROGRESS_PATTERN = /^\s*(?:\[[^\]\n]+\]\s*)?(?:INFO\s+)?(?:progress\b|cache(?:d)?\b|download(?:ing)?\b|compil(?:ing|ed)\b)/i;
const MAX_DISPOSABLE_KEEP_PROBABILITY = 0.1;

export function isProtectedLine(text: string): boolean {
  return DIAGNOSTIC_PATTERN.test(text) || RESULT_PATTERN.test(text) || PYTEST_RESULT_PATTERN.test(text);
}

export function classifyInformation(text: string): InformationCategory {
  const unnumbered = text.replace(/^(?:[^\n]*?:\d+(?::\d+)?:|\s*\d+\t)\s*/gm, '');
  if (REFERENCE_PATTERN.test(unnumbered)) return 'reference';
  if (DIAGNOSTIC_PATTERN.test(text)) return 'diagnostic';
  if (RESULT_PATTERN.test(text) || PYTEST_RESULT_PATTERN.test(text)) return 'result';
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  if (lines.length > 0 && lines.every(line =>
    PROGRESS_PATTERN.test(line) || TEST_PROGRESS_PATTERN.test(line))) return 'progress';
  return 'unknown';
}

export function keepScore(score: number, threshold: number): boolean {
  return score >= threshold || score > MAX_DISPOSABLE_KEEP_PROBABILITY;
}
