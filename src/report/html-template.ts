/**
 * Inline CSS and script for the triage HTML report.
 * The renderer hashes these exact strings into the Content-Security-Policy.
 * Do not read them from the network, and do not build them from report text.
 */

export const REPORT_STYLE = `
:root {
  color-scheme: light;
  --bg: #f4f4f5;
  --bg-elevated: #fafafa;
  --ink: #18181b;
  --muted: #3f3f46;
  --line: #d4d4d8;
  --band: #18181b;
  --band-ink: #fafafa;
  --band-muted: #d4d4d8;
  --bar: #3f3f46;
  --bar-track: #e4e4e7;
  --badge-bg: #f4f4f5;
  --badge-ink: #18181b;
  --accent-likely-real-bug: #9f1239;
  --accent-flaky: #a16207;
  --accent-broken-test: #9a3412;
  --accent-environment-issue: #1e40af;
  --accent-needs-more-runs: #52525b;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #09090b;
    --bg-elevated: #18181b;
    --ink: #fafafa;
    --muted: #d4d4d8;
    --line: #3f3f46;
    --band: #27272a;
    --band-ink: #fafafa;
    --band-muted: #d4d4d8;
    --bar: #d4d4d8;
    --bar-track: #27272a;
    --badge-bg: #27272a;
    --badge-ink: #fafafa;
    --accent-likely-real-bug: #fecdd3;
    --accent-flaky: #fde68a;
    --accent-broken-test: #fed7aa;
    --accent-environment-issue: #bfdbfe;
    --accent-needs-more-runs: #e4e4e7;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
}
:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
.skip {
  position: absolute;
  left: 0.75rem;
  top: -3rem;
  z-index: 3;
  background: var(--bg-elevated);
  color: var(--ink);
  padding: 0.4rem 0.7rem;
  border-radius: 0.35rem;
}
.skip:focus { top: 0.75rem; }
.top { background: var(--band); color: var(--band-ink); }
.top-inner, main, .footer {
  max-width: 72rem;
  margin: 0 auto;
  padding-left: 1.25rem;
  padding-right: 1.25rem;
}
.top-inner { padding-top: 2rem; padding-bottom: 1.5rem; }
.mark { margin: 0; color: var(--band-muted); font-size: 0.85rem; }
h1 {
  margin: 0.2rem 0 0;
  font-size: 2rem;
  font-weight: 650;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
.lede { margin: 0.55rem 0 0; max-width: 40rem; color: var(--band-muted); }
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  margin: 1.1rem 0 0;
}
.meta div { margin: 0; }
.meta dt { margin: 0; font-size: 0.78rem; color: var(--band-muted); }
.meta dd { margin: 0.1rem 0 0; font-weight: 600; overflow-wrap: anywhere; }
main { padding-top: 0.25rem; padding-bottom: 1rem; }
section { margin-top: 1.6rem; }
h2 { margin: 0 0 0.75rem; font-size: 1.2rem; font-weight: 650; }
h3 { margin: 1rem 0 0.35rem; font-size: 0.98rem; font-weight: 650; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  gap: 0.75rem;
}
.card, .table-wrap, .empty {
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 0.55rem;
}
.card { padding: 0.85rem 1rem 0.95rem; }
.card-label { margin: 0; color: var(--muted); font-size: 0.82rem; }
.card-value {
  margin: 0.3rem 0 0;
  font-size: 1.75rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.chart-wrap { overflow: auto; max-width: 100%; contain: inline-size; }
.chart { width: 100%; height: auto; display: block; color: var(--ink); }
.chart-label, .chart-count { fill: currentColor; font-size: 14px; font-family: inherit; }
.chart-count { font-variant-numeric: tabular-nums; }
.chart-track { fill: var(--bar-track); }
.chart-bar { fill: var(--bar); }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.toolbar { display: none; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin: 0 0 0.85rem; }
.js .toolbar { display: flex; }
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--muted);
  font-size: 0.82rem;
}
.toolbar select, .toolbar input[type="search"] {
  font: inherit;
  color: var(--ink);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  padding: 0.4rem 0.55rem;
  min-width: 11rem;
}
.filter-status { margin: 0; align-self: center; color: var(--muted); font-size: 0.85rem; }
.table-wrap { overflow: auto; max-width: 100%; width: 100%; contain: paint; }
table { width: 100%; border-collapse: collapse; }
caption { caption-side: bottom; }
th, td {
  text-align: left;
  vertical-align: top;
  padding: 0.7rem 0.75rem;
  border-bottom: 1px solid var(--line);
}
thead th {
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: 1;
}
th button {
  font: inherit;
  font-weight: 650;
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
th[aria-sort="ascending"] button::after,
th[aria-sort="descending"] button::after {
  content: "";
  display: inline-block;
  margin-left: 0.4rem;
  vertical-align: middle;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
}
th[aria-sort="ascending"] button::after { border-bottom: 6px solid currentColor; }
th[aria-sort="descending"] button::after { border-top: 6px solid currentColor; }
tbody th[scope="row"] { font-weight: 600; overflow-wrap: anywhere; }
.frac { font-variant-numeric: tabular-nums; white-space: nowrap; }
.badge {
  display: inline-block;
  padding: 0.12rem 0.5rem 0.12rem 0.45rem;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent, var(--line));
  border-radius: 0.3rem;
  background: var(--badge-bg);
  color: var(--badge-ink);
  font-weight: 650;
  white-space: nowrap;
}
.verdict-likely-real-bug { --accent: var(--accent-likely-real-bug); }
.verdict-flaky { --accent: var(--accent-flaky); }
.verdict-broken-test { --accent: var(--accent-broken-test); }
.verdict-environment-issue { --accent: var(--accent-environment-issue); }
.verdict-needs-more-runs { --accent: var(--accent-needs-more-runs); }
.detail-row td { background: var(--bg); }
details { padding: 0.15rem 0 0.85rem; }
summary { cursor: pointer; font-weight: 650; }
.detail p, .detail li { overflow-wrap: anywhere; }
.caution {
  margin: 0.75rem 0 0;
  padding-left: 0.7rem;
  border-left: 3px solid var(--line);
}
pre {
  margin: 0;
  padding: 0.7rem 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 0.88rem;
}
code {
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 0.88rem;
  overflow-wrap: anywhere;
}
.command-line { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
.copy {
  font: inherit;
  color: var(--ink);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
}
.strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  list-style: none;
  margin: 0.35rem 0 0;
  padding: 0;
}
.strip li {
  width: 0.7rem;
  height: 0.7rem;
  background: var(--bar);
  border-radius: 0.15rem;
}
.empty { padding: 1.1rem 1rem; }
.empty-title { margin: 0; font-size: 1.05rem; font-weight: 650; }
.empty p { margin: 0.4rem 0 0; color: var(--muted); }
.footer { padding-bottom: 2rem; color: var(--muted); font-size: 0.85rem; }
.copy-buffer {
  position: fixed;
  left: -9999px;
  top: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
}
@media (max-width: 720px) {
  h1 { font-size: 1.6rem; }
  .cards { grid-template-columns: 1fr 1fr; }
  .toolbar { align-items: stretch; }
  .field, .toolbar select, .toolbar input[type="search"] { width: 100%; min-width: 0; }
  thead th { position: static; }
  table { min-width: 42rem; }
}
@media print {
  :root {
    color-scheme: light;
    --bg: #fafafa;
    --bg-elevated: #fafafa;
    --ink: #18181b;
    --muted: #3f3f46;
    --line: #d4d4d8;
    --band: #fafafa;
    --band-ink: #18181b;
    --band-muted: #3f3f46;
    --bar: #3f3f46;
    --bar-track: #e4e4e7;
    --badge-bg: #f4f4f5;
    --badge-ink: #18181b;
  }
  .skip, .toolbar, .copy { display: none !important; }
  thead th { position: static; }
  details > :not(summary) { display: block !important; }
  tbody { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
}
`.trim();

export const REPORT_SCRIPT = `
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var table = document.querySelector('[data-report-table]');
  if (!table) return;
  var bodies = Array.prototype.slice.call(table.querySelectorAll('tbody'));
  var verdict = document.getElementById('filter-verdict');
  var cause = document.getElementById('filter-cause');
  var confidence = document.getElementById('filter-confidence');
  var search = document.getElementById('filter-search');
  var status = document.getElementById('filter-status');
  var empty = document.getElementById('filter-empty');
  var headers = Array.prototype.slice.call(table.querySelectorAll('th[data-sort-key]'));
  var sortKey = '';
  var sortDir = 1;

  function textCompare(left, right) {
    var a = String(left);
    var b = String(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function valueOf(body, key) {
    if (key === 'test') return body.getAttribute('data-test') || '';
    if (key === 'verdict') return Number(body.getAttribute('data-verdict-rank') || '0');
    if (key === 'cause') return body.getAttribute('data-cause') || '';
    if (key === 'confidence') return Number(body.getAttribute('data-confidence-rank') || '0');
    if (key === 'attempts') {
      return [Number(body.getAttribute('data-failed') || '0'), Number(body.getAttribute('data-total') || '0')];
    }
    if (key === 'runs') return Number(body.getAttribute('data-runs') || '0');
    return Number(body.getAttribute('data-index') || '0');
  }

  function compare(left, right) {
    var a = valueOf(left, sortKey);
    var b = valueOf(right, sortKey);
    var order = 0;
    if (Array.isArray(a) && Array.isArray(b)) {
      order = a[0] - b[0];
      if (order === 0) order = a[1] - b[1];
    } else if (typeof a === 'number' && typeof b === 'number') {
      order = a - b;
    } else {
      order = textCompare(a, b);
    }
    if (order === 0) {
      order = Number(left.getAttribute('data-index') || '0') - Number(right.getAttribute('data-index') || '0');
    }
    return order * sortDir;
  }

  function applySort() {
    if (!sortKey) return;
    bodies.sort(compare);
    bodies.forEach(function (body) {
      table.appendChild(body);
    });
  }

  function matches(body) {
    if (verdict && verdict.value && body.getAttribute('data-verdict') !== verdict.value) return false;
    if (cause && cause.value && body.getAttribute('data-cause') !== cause.value) return false;
    if (confidence && confidence.value && body.getAttribute('data-confidence') !== confidence.value) return false;
    var query = search && search.value ? search.value.trim().toLowerCase() : '';
    if (!query) return true;
    return (body.textContent || '').toLowerCase().indexOf(query) !== -1;
  }

  function applyFilter() {
    var shown = 0;
    bodies.forEach(function (body) {
      var ok = matches(body);
      body.hidden = !ok;
      if (ok) shown += 1;
    });
    if (status) status.textContent = 'Showing ' + String(shown) + ' of ' + String(bodies.length);
    if (empty) empty.hidden = shown !== 0;
  }

  headers.forEach(function (th) {
    var button = th.querySelector('button');
    if (!button) return;
    button.addEventListener('click', function () {
      var key = th.getAttribute('data-sort-key') || '';
      if (sortKey === key) sortDir = -sortDir;
      else {
        sortKey = key;
        sortDir = 1;
      }
      headers.forEach(function (other) {
        var next = 'none';
        if (other === th) next = sortDir === 1 ? 'ascending' : 'descending';
        other.setAttribute('aria-sort', next);
      });
      applySort();
      applyFilter();
    });
  });

  [verdict, cause, confidence].forEach(function (node) {
    if (!node) return;
    node.addEventListener('change', applyFilter);
  });
  if (search) search.addEventListener('input', applyFilter);

  Array.prototype.forEach.call(document.querySelectorAll('button.copy'), function (button) {
    button.addEventListener('click', function () {
      var holder = button.parentNode;
      var code = holder ? holder.querySelector('code') : null;
      var text = code ? code.textContent || '' : button.getAttribute('data-copy') || '';
      var previous = button.textContent;
      function done() {
        button.textContent = 'Copied';
        window.setTimeout(function () {
          button.textContent = previous;
        }, 1600);
      }
      function fallback() {
        var copied = false;
        function onCopy(event) {
          if (!event.clipboardData) return;
          event.clipboardData.setData('text/plain', text);
          event.preventDefault();
          copied = true;
        }
        document.addEventListener('copy', onCopy);
        var area = document.createElement('textarea');
        area.value = text;
        area.className = 'copy-buffer';
        area.setAttribute('readonly', '');
        document.body.appendChild(area);
        area.focus();
        area.select();
        area.setSelectionRange(0, area.value.length);
        try {
          document.execCommand('copy');
        } catch (error) {
          copied = false;
        }
        document.removeEventListener('copy', onCopy);
        document.body.removeChild(area);
        if (copied) done();
      }
      var clipboard = navigator.clipboard;
      if (location.protocol !== 'file:' && clipboard && clipboard.writeText) {
        clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    });
  });

  applyFilter();
})();
`.trim();
