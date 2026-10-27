import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { healPatchName, proposalPatchBody } from '../heal/patch.js';
import { redactHomeText } from '../report-path.js';
import { VERDICT_ORDER } from '../verdict.js';
import { REPORT_SCRIPT, REPORT_STYLE } from './html-template.js';
import type { RerunCounts, TriageEntry, TriageReport, VerdictName } from './schema.js';

const FLAKY_LINE = 'A flaky test can still point to a real app defect. Check the app behavior too.';

const CAUSE_ORDER = ['selectors', 'timing', 'test-data', 'environment', 'unknown'] as const;

const VERDICT_LABEL: Record<VerdictName, string> = {
  'likely-real-bug': 'Likely Real Bug',
  flaky: 'Flaky',
  'broken-test': 'Broken Test',
  'environment-issue': 'Environment Issue',
  'needs-more-runs': 'Needs More Runs',
};

const BADGE_CLASS: Record<VerdictName, string> = {
  'likely-real-bug': 'b1',
  'broken-test': 'b2',
  flaky: 'b3',
  'environment-issue': 'b4',
  'needs-more-runs': 'b5',
};

const CAUSE_LABEL: Record<string, string> = {
  selectors: 'Selectors',
  timing: 'Timing',
  'test-data': 'Test Data',
  environment: 'Environment',
  unknown: 'Unknown',
  none: 'None',
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const SIGNAL_LABEL: Record<string, string> = {
  'consistent-failure': 'Consistent Failure',
  'same-code-flip': 'Same Code Flip',
  'insufficient-evidence': 'Insufficient Evidence',
  'unexpected-pass': 'Unexpected Pass',
};

const MODE_LABEL: Record<string, string> = {
  repeat: 'Repeat',
  isolated: 'Isolated',
  'in-order': 'In Order',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const HEX_COMMIT = /^[0-9a-fA-F]{7,40}$/;

const RERUN_MODES = ['repeat', 'isolated', 'in-order'] as const;

export type HtmlRenderOptions = {
  /** Hide home usernames. Default true. Same rules as `parse --redact`. */
  redact?: boolean;
  /** Tool version in the footer. Omit it and the package version is used. */
  version?: string;
};

/**
 * One self-contained HTML page for a triage report.
 * Facts come from the report. Home usernames are hidden unless `redact` is false.
 * The same report and options always produce the same text.
 * A count that is not a finite number throws before any markup is built.
 */
export function renderTriageHtml(report: TriageReport, options: HtmlRenderOptions = {}): string {
  const source = structuredClone(report);
  if (options.redact !== false) redactStrings(source);
  const counts = source.entries.map((entry) => checkedCounts(entry));
  const version = options.version ?? readPackageVersion();
  const styleHash = sourceHash(REPORT_STYLE);
  const scriptHash = sourceHash(REPORT_SCRIPT);
  const policy = [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    `style-src '${styleHash}'`,
    'img-src data:',
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const body = omitOptionalEndTags(
    [
      '<a class="skip" href="#tests">Skip To Tests</a>',
      renderHeader(source),
      '<main>',
      renderSummary(source),
      renderCauses(source),
      renderTests(source, counts),
      '</main>',
      `<footer class="footer"><p>${footerLine(version)}</p></footer>`,
      `<script>${REPORT_SCRIPT}</script>`,
    ].join(''),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>Triage Report</title>
<link rel="icon" href="data:,">
<style>${REPORT_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * Write `triage.html` in `dir`, or leave a previous file in place.
 * The body is written to a temp name and then renamed. A destination that
 * is not a regular file is left as it is.
 */
export function writeTriageHtml(dir: string, html: string): void {
  if (dir.trim() === '') throw new Error('The output directory is empty.');
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  const dest = path.join(resolved, 'triage.html');
  if (fs.existsSync(dest) && !fs.statSync(dest).isFile()) {
    throw new Error('triage.html must be a file');
  }
  const tmp = path.join(resolved, `.triage.html.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, dest);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error instanceof Error ? error : new Error('unknown error');
  }
}

type CheckedCounts = {
  total: number;
  failed: number;
  passed: number;
  runsSeen: number;
  reruns: Array<{ mode: (typeof RERUN_MODES)[number]; counts: Required<Pick<RerunCounts, 'total' | 'failed' | 'passed'>> & { notRun?: number } }>;
};

function checkedCounts(entry: TriageEntry): CheckedCounts {
  const attempts = entry.attempts;
  const total = requireCount(attempts?.total, 'attempts.total');
  const failed = requireCount(attempts?.failed, 'attempts.failed');
  const passed = requireCount(attempts?.passed, 'attempts.passed');
  const runsSeen = requireCount(entry.history?.runsSeen, 'history.runsSeen');
  const reruns: CheckedCounts['reruns'] = [];
  const raw = attempts?.reruns;
  if (raw) {
    for (const mode of RERUN_MODES) {
      const counts = raw[mode];
      if (counts === undefined) continue;
      const checked = {
        total: requireCount(counts?.total, `attempts.reruns.${mode}.total`),
        failed: requireCount(counts?.failed, `attempts.reruns.${mode}.failed`),
        passed: requireCount(counts?.passed, `attempts.reruns.${mode}.passed`),
      };
      const notRun = counts?.notRun;
      if (notRun !== undefined) {
        reruns.push({ mode, counts: { ...checked, notRun: requireCount(notRun, `attempts.reruns.${mode}.notRun`) } });
      } else {
        reruns.push({ mode, counts: checked });
      }
    }
  }
  return { total, failed, passed, runsSeen, reruns };
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

/**
 * Drop end tags the HTML parser restores on its own.
 * A 200 entry report stays under 300 KB, and the DOM is unchanged.
 */
function omitOptionalEndTags(html: string): string {
  return html
    .replaceAll('</td>', '')
    .replaceAll('</th>', '')
    .replaceAll('</tr>', '')
    .replaceAll('</tbody>', '')
    .replace(/<\/p>(?=<h[1-6]|<p|<pre)/g, '');
}

function footerLine(version: string): string {
  const tool = version ? `Generated by qa-core-flaky ${escapeHtml(version)}.` : 'Generated by qa-core-flaky.';
  return `${tool} Built by SprintSynergy.`;
}

function renderHeader(report: TriageReport): string {
  const rows: string[] = [];
  const generated = report.generatedAt ? formatGenerated(report.generatedAt) : undefined;
  if (generated) rows.push(metaRow('Generated', generated, false));
  const commits = commitsIn(report);
  if (commits.length > 0) rows.push(metaRow('Commit', commits.join(', '), true));
  const meta = rows.length > 0 ? `<dl class="meta">${rows.join('')}</dl>` : '';
  return `<header class="top"><div class="top-inner"><p class="mark">qa-core-flaky</p><h1>Triage Report</h1><p class="lede">Failed and flaky tests. Passed tests are not listed.</p>${meta}</div></header>`;
}

function metaRow(label: string, value: string, mono: boolean): string {
  const dd = mono ? `<dd class="sha">${escapeHtml(value)}</dd>` : `<dd>${escapeHtml(value)}</dd>`;
  return `<div><dt>${escapeHtml(label)}</dt>${dd}</div>`;
}

/**
 * `2026-10-26T18:07:00.000Z` becomes `26 Oct 2026, 18:07 UTC`.
 * Anything that is not a real UTC timestamp is omitted.
 */
function formatGenerated(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return undefined;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const monthName = MONTHS[month - 1];
  if (!monthName) return undefined;
  return `${day} ${monthName} ${year}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`;
}

function renderSummary(report: TriageReport): string {
  const counts = new Map<VerdictName, number>();
  for (const name of VERDICT_ORDER) counts.set(name, 0);
  for (const entry of report.entries) {
    counts.set(entry.verdict, (counts.get(entry.verdict) ?? 0) + 1);
  }
  const cards = [
    card('Tests Flagged', 'tests', report.entries.length),
    ...VERDICT_ORDER.map((name) => card(VERDICT_LABEL[name], name, counts.get(name) ?? 0)),
  ];
  return `<section aria-labelledby="summary-heading"><h2 id="summary-heading">Summary</h2><div class="cards">${cards.join('')}</div></section>`;
}

function card(label: string, key: string, count: number): string {
  const zero = count === 0 ? ' z' : '';
  return `<article class="card${zero}"><p class="card-label">${escapeHtml(label)}</p><p class="card-value" data-summary="${escapeHtml(key)}">${count}</p></article>`;
}

function renderCauses(report: TriageReport): string {
  const counts = causeCounts(report);
  if (report.entries.length === 0) {
    return `<section aria-labelledby="cause-heading"><h2 id="cause-heading">Cause Breakdown</h2><div class="empty"><p class="empty-title">No Causes</p><p>The report has no entries.</p></div></section>`;
  }
  const rows = [...counts.entries()];
  const max = Math.max(1, ...rows.map((row) => row[1] ?? 0));
  const bars = rows
    .map((row) => {
      const cause = row[0] ?? 'unknown';
      const count = row[1] ?? 0;
      const width = Math.round((count / max) * 100);
      const zero = count === 0 ? ' z' : '';
      return `<li class="${zero.trim()}"><span class="bl">${escapeHtml(causeLabel(cause))}</span><span class="bt" aria-hidden="true"><span class="bb" style="width:${width}%"></span></span><span class="bc" data-cause-count="${escapeHtml(cause)}">${count}</span></li>`;
    })
    .join('');
  return `<section aria-labelledby="cause-heading"><h2 id="cause-heading">Cause Breakdown</h2><ul class="bars">${bars}</ul></section>`;
}

function renderTests(report: TriageReport, counts: readonly CheckedCounts[]): string {
  if (report.entries.length === 0) {
    return `<section id="tests" aria-labelledby="tests-heading"><h2 id="tests-heading">Tests</h2><div class="empty"><p class="empty-title">No Entries</p><p>Every test passed or was skipped. There is nothing to review.</p></div></section>`;
  }
  const head = `<thead><tr><th scope="col" data-sort-key="test" aria-sort="none"><button>Test</button></th><th scope="col" data-sort-key="verdict" aria-sort="none"><button>Verdict</button></th><th scope="col" data-sort-key="cause" aria-sort="none"><button>Cause</button></th><th scope="col" data-sort-key="confidence" aria-sort="none"><button>Confidence</button></th><th scope="col" data-sort-key="attempts" aria-sort="none"><button>Attempts</button></th><th scope="col" data-sort-key="runs" aria-sort="none"><button>Runs Seen</button></th></tr></thead>`;
  const bodies = report.entries.map((entry, index) => renderEntry(entry, counts[index])).join('');
  const flaky = report.entries.some((entry) => entry.verdict === 'flaky') ? `<p class="note">${escapeHtml(FLAKY_LINE)}</p>` : '';
  return `<section id="tests" aria-labelledby="tests-heading"><h2 id="tests-heading">Tests</h2>${flaky}${renderToolbar(report)}<div class="table-wrap"><table data-report-table><caption class="sr-only">Triage Tests</caption>${head}${bodies}</table></div><p id="filter-empty" class="filter-empty" hidden>No Matching Tests</p></section>`;
}

function renderToolbar(report: TriageReport): string {
  const verdicts = VERDICT_ORDER.filter((name) => report.entries.some((entry) => entry.verdict === name));
  const causes = [...causeCounts(report).keys()].filter((cause) => (causeCounts(report).get(cause) ?? 0) > 0);
  const confidences = ['high', 'medium', 'low'].filter((name) => report.entries.some((entry) => entry.confidence === name));
  return `<div class="toolbar"><div class="field sort"><label for="sort-by">Sort By</label><select id="sort-by"><option value="">Report Order</option><option value="test">Test</option><option value="verdict">Verdict</option><option value="cause">Cause</option><option value="confidence">Confidence</option><option value="attempts">Attempts</option><option value="runs">Runs Seen</option></select></div><div class="field"><label for="filter-verdict">Verdict</label><select id="filter-verdict">${options(verdicts, VERDICT_LABEL)}</select></div><div class="field"><label for="filter-cause">Cause</label><select id="filter-cause">${options(causes, CAUSE_LABEL)}</select></div><div class="field"><label for="filter-confidence">Confidence</label><select id="filter-confidence">${options(confidences, CONFIDENCE_LABEL)}</select></div><div class="field"><label for="filter-search">Search</label><input id="filter-search" type="search" placeholder="Search Tests" autocomplete="off"></div><p id="filter-status" class="filter-status" aria-live="polite"></p></div>`;
}

function options(values: readonly string[], labels: Record<string, string>): string {
  const parts = ['<option value="">All</option>'];
  for (const value of values) {
    parts.push(`<option value="${escapeHtml(value)}">${escapeHtml(labels[value] ?? value)}</option>`);
  }
  return parts.join('');
}

function renderEntry(entry: TriageEntry, counts: CheckedCounts | undefined): string {
  if (!counts) throw new Error('attempts.total must be a finite number');
  const cause = primaryCause(entry);
  const badge = BADGE_CLASS[entry.verdict] ?? 'b0';
  const parts = splitId(entry.id);
  const title = `<b>${escapeHtml(parts.title)}</b>`;
  const meta = parts.meta ? `<small>${escapeHtml(parts.meta)}</small>` : '';
  return `<tbody data-test="${escapeHtml(entry.id)}" data-v="${escapeHtml(entry.verdict)}" data-c="${escapeHtml(cause)}" data-k="${escapeHtml(entry.confidence)}" data-f="${counts.failed}" data-n="${counts.total}" data-r="${counts.runsSeen}"><tr><th scope="row">${title}${meta}</th><td data-label="Verdict"><i class="${badge}">${escapeHtml(verdictLabel(entry.verdict))}</i></td><td data-label="Cause">${escapeHtml(causeLabel(cause))}</td><td data-label="Confidence">${escapeHtml(confidenceLabel(entry.confidence))}</td><td data-label="Attempts">${counts.failed}/${counts.total}</td><td data-label="Runs Seen">${counts.runsSeen}</td></tr><tr><td colspan="6"><details><summary>Details</summary>${renderDetail(entry, counts)}</details></td></tr></tbody>`;
}

function splitId(id: string): { title: string; meta: string } {
  const parts = id.split('::');
  const file = parts[0];
  const project = parts[1];
  const title = parts.slice(2).join('::');
  if (!file || !project || !title) return { title: id, meta: '' };
  return { title, meta: `${file} · ${project}` };
}

function renderDetail(entry: TriageEntry, counts: CheckedCounts): string {
  const parts: string[] = [];
  if (entry.evidence.length > 0) {
    parts.push(`<b>Evidence</b><pre>${entry.evidence.map((line) => escapeHtml(line)).join('\n')}</pre>`);
  }
  if (entry.signals.length > 0) {
    parts.push('<b>Signals</b>');
    for (const signal of entry.signals) {
      parts.push(
        `<p data-signal="${escapeHtml(signal.kind)}">${escapeHtml(signalLabel(signal.kind))}: ${escapeHtml(signal.detail)}</p>`,
      );
    }
  }
  if (entry.causes.length > 0) {
    parts.push('<b>Causes</b>');
    for (const finding of entry.causes) {
      parts.push(
        `<p>${escapeHtml(causeLabel(finding.cause))} (${escapeHtml(confidenceLabel(finding.confidence))}). ${escapeHtml(finding.ruleIds.join(', '))}</p>`,
      );
    }
  }
  if (entry.suggestedFix) parts.push(`<b>Suggested Fix</b><p>${escapeHtml(entry.suggestedFix)}</p>`);
  if (entry.nextStep) parts.push(`<b>Next Step</b>${renderNextStep(entry.nextStep)}`);
  const reruns = renderReruns(counts);
  if (reruns) parts.push(reruns);
  if (entry.observation) parts.push(`<p>${escapeHtml(entry.observation)}</p>`);
  if (entry.note) parts.push(`<b>Note</b><p>${escapeHtml(entry.note)}</p>`);
  const sameCode = entry.attempts.sameCommit ? 'yes' : 'no';
  parts.push(
    `<b>Attempts</b><p>Total ${counts.total}, failed ${counts.failed}, passed ${counts.passed}. Same code for a pass and a fail: ${sameCode}.</p>`,
  );
  if (counts.runsSeen > 1) parts.push(`<p>Seen In ${counts.runsSeen} Runs</p>`);
  parts.push(`<p>Review Status: ${escapeHtml(entry.review.status)}.${renderProposal(entry)}</p>`);
  return parts.join('');
}

/** A short status, plus a link when the patch file holds the diff and the explanation. */
function renderProposal(entry: TriageEntry): string {
  const proposal = entry.healProposal;
  if (!proposal) return '';
  const status = escapeHtml(proposal.status);
  const refusal = proposal.refusal ? ` data-heal-refusal="${escapeHtml(proposal.refusal.code)}"` : '';
  if (proposalPatchBody(proposal).length === 0) {
    return ` <i data-heal-status="${status}"${refusal}>${status}</i>`;
  }
  const href = escapeHtml(healPatchName(entry.id));
  return ` <a data-heal-status="${status}"${refusal} href="${href}">${status}</a>`;
}

function renderNextStep(nextStep: string): string {
  const marker = 'qa-core-flaky rerun ';
  const at = nextStep.indexOf(marker);
  const lead = at === -1 ? nextStep : nextStep.slice(0, at);
  const command = at === -1 ? nextStep : nextStep.slice(at);
  return `<p>${escapeHtml(lead)}</p><pre>${escapeHtml(command)}</pre><button class="copy">Copy Command</button>`;
}

function renderReruns(counts: CheckedCounts): string {
  const items: string[] = [];
  for (const row of counts.reruns) {
    const label = MODE_LABEL[row.mode] ?? row.mode;
    if (row.counts.total > 0) {
      items.push(
        `<p data-rerun="${escapeHtml(row.mode)}">${escapeHtml(label)}: total ${row.counts.total}, failed ${row.counts.failed}, passed ${row.counts.passed}.</p>`,
      );
    }
    if (row.counts.notRun) {
      items.push(
        `<p data-rerun="${escapeHtml(row.mode)}">${escapeHtml(label)} not run ${row.counts.notRun}: could not select.</p>`,
      );
    }
  }
  if (items.length === 0) return '';
  return `<b>Reruns</b>${items.join('')}`;
}

function causeCounts(report: TriageReport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of CAUSE_ORDER) counts.set(name, 0);
  for (const entry of report.entries) {
    const cause = primaryCause(entry);
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return counts;
}

function primaryCause(entry: TriageEntry): string {
  return entry.causes[0]?.cause ?? 'none';
}

function verdictLabel(name: string): string {
  return VERDICT_LABEL[name as VerdictName] ?? name;
}

function causeLabel(name: string): string {
  return CAUSE_LABEL[name] ?? name;
}

function confidenceLabel(name: string): string {
  return CONFIDENCE_LABEL[name] ?? name;
}

function signalLabel(name: string): string {
  return SIGNAL_LABEL[name] ?? name;
}

/**
 * Commit tokens named by signal text, in first-seen order.
 * Only a 7 to 40 character hex token is shown, and only its first 7 characters.
 */
function commitsIn(report: TriageReport): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const entry of report.entries) {
    for (const signal of entry.signals) {
      for (const match of signal.detail.matchAll(/\bcommit (\S+)/g)) {
        const raw = match[1];
        if (!raw) continue;
        const token = raw.replace(/[.,;:]+$/g, '');
        if (!HEX_COMMIT.test(token) || seen.has(token)) continue;
        seen.add(token);
        found.push(token.slice(0, 7));
      }
    }
  }
  return found;
}

function redactStrings(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === 'string') value[index] = redactHomeText(item);
      else redactStrings(item);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (typeof item === 'string') record[key] = redactHomeText(item);
    else redactStrings(item);
  }
}

function sourceHash(body: string): string {
  return `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
}

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  return typeof pkg.version === 'string' ? pkg.version : '';
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
