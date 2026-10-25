import type { TriageEntry, TriageReport } from './schema.js';

const FLAKY_LINE = 'A flaky test can still point to a real app defect. Check the app behavior too.';

/** Markdown triage report. The same report always renders the same text. */
export function renderTriageMarkdown(report: TriageReport): string {
  const lines: string[] = ['# Triage Report', '', '## Summary', '', '| Test | Verdict | Cause | Confidence |', '| --- | --- | --- | --- |'];
  for (const entry of report.entries) {
    const cause = entry.causes[0]?.cause ?? 'none';
    lines.push(`| ${cell(entry.id)} | ${cell(entry.verdict)} | ${cell(cause)} | ${cell(entry.confidence)} |`);
  }
  if (report.entries.length === 0) {
    lines.push('| none | none | none | none |');
  }
  lines.push('');
  for (const entry of report.entries) {
    lines.push(...renderEntry(entry), '');
  }
  return `${lines.join('\n').replace(/\n$/, '')}\n`;
}

function renderEntry(entry: TriageEntry): string[] {
  const lines = [
    `## ${cell(entry.id)}`,
    '',
    `Verdict: ${entry.verdict}`,
    `Confidence: ${entry.confidence}`,
  ];
  if (entry.verdict === 'flaky') lines.push(FLAKY_LINE);
  lines.push('', '### Causes', '');
  if (entry.causes.length === 0) {
    lines.push('No cause rule matched.');
  } else {
    for (const finding of entry.causes) {
      lines.push(`- ${finding.cause} (${finding.confidence}). Rules: ${finding.ruleIds.join(', ')}`);
    }
  }
  lines.push('', '### Evidence', '');
  if (entry.evidence.length === 0) {
    lines.push('No error text was quoted.');
  } else {
    for (const line of entry.evidence) lines.push(`> ${escapeHtml(line)}`);
  }
  lines.push(
    '',
    '### Attempts',
    '',
    `Total ${entry.attempts.total}, failed ${entry.attempts.failed}, passed ${entry.attempts.passed}. Same code for a pass and a fail: ${entry.attempts.sameCommit ? 'yes' : 'no'}.`,
  );
  const rerunLine = formatReruns(entry.attempts.reruns);
  if (rerunLine) lines.push(rerunLine);
  if (entry.observation) lines.push(entry.observation);
  lines.push('', '### Signals', '');
  if (entry.signals.length === 0) {
    lines.push('No signal recorded.');
  } else {
    for (const signal of entry.signals) lines.push(`- ${signal.kind}: ${signal.detail}`);
  }
  lines.push('', '### Suggested Fix', '', entry.suggestedFix, '', '### Next Step', '', renderNextStep(entry.nextStep));
  if (entry.note) {
    lines.push('', '### Note', '', entry.note);
  }
  lines.push('', `Review status: ${entry.review.status}.`);
  return lines;
}

function formatReruns(reruns: TriageEntry['attempts']['reruns']): string | undefined {
  if (!reruns) return undefined;
  const parts: string[] = [];
  for (const mode of ['repeat', 'isolated', 'in-order'] as const) {
    const counts = reruns[mode];
    if (!counts) continue;
    parts.push(`${mode} total ${counts.total}, failed ${counts.failed}, passed ${counts.passed}`);
  }
  if (parts.length === 0) return undefined;
  return `Reruns: ${parts.join('; ')}.`;
}

/**
 * The command sits in a code span so Markdown escaping does not add
 * backslashes inside it. The sentence before the command is still escaped.
 */
function renderNextStep(nextStep: string): string {
  const marker = 'qa-core-flaky rerun ';
  const at = nextStep.indexOf(marker);
  if (at === -1) return escapeHtml(nextStep);
  const command = nextStep
    .slice(at)
    .replaceAll('`', "'")
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n');
  return `${escapeHtml(nextStep.slice(0, at))}\`${command}\``;
}

function cell(value: string): string {
  return escapeHtml(value)
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n');
}

/**
 * Keep `<`, `>`, and `&` visible, and keep `*`, `_`, and backticks from
 * becoming Markdown emphasis or code. Titles, table cells, evidence, and
 * the next step all use this.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('`', '\\`')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
