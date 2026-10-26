/**
 * Inline CSS and script for the triage HTML report.
 * The renderer hashes these exact strings into the Content-Security-Policy.
 * Do not read them from the network, and do not build them from report text.
 */

const WIDTHS = Array.from({ length: 101 }, (_, index) => `.w${index}{width:${index}%}`).join('');

function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

export const REPORT_STYLE = minifyCss(`
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
  --zero: #71717a;
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
    --zero: #a1a1aa;
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
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
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
h1 { margin: 0.2rem 0 0; font-size: 2rem; font-weight: 650; letter-spacing: -0.03em; line-height: 1.15; }
.lede { margin: 0.55rem 0 0; max-width: 40rem; color: var(--band-muted); }
.meta { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; margin: 1.1rem 0 0; }
.meta div { margin: 0; }
.meta dt { margin: 0; font-size: 0.78rem; color: var(--band-muted); }
.meta dd { margin: 0.1rem 0 0; font-weight: 600; overflow-wrap: anywhere; }
.sha { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-weight: 500; }
main { padding-top: 0.25rem; padding-bottom: 1rem; }
section { margin-top: 1.6rem; }
h2 { margin: 0 0 0.75rem; font-size: 1.2rem; font-weight: 650; }
h3 { margin: 0.7rem 0 0.25rem; font-size: 0.92rem; font-weight: 650; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 0.75rem; }
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
.z, .z .card-value, .bars .z { color: var(--zero); }
.bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-width: 36rem; }
.bars li { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr) 2rem; align-items: center; column-gap: 0.75rem; height: 24px; }
.bl { font-size: 0.875rem; line-height: 1; white-space: nowrap; }
.bt { display: block; height: 8px; background: var(--bar-track); border-radius: 999px; overflow: hidden; }
.bb { display: block; height: 8px; background: var(--bar); border-radius: 999px; }
.bars .z .bb { background: transparent; }
.bc { font-size: 0.875rem; font-variant-numeric: tabular-nums; text-align: right; }
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
.toolbar .sort { display: none; }
.field { display: flex; flex-direction: column; gap: 0.25rem; color: var(--muted); font-size: 0.82rem; }
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
.note { margin: -0.35rem 0 0.85rem; color: var(--muted); }
.table-wrap { overflow: auto; max-width: 100%; width: 100%; }
table { width: 100%; border-collapse: collapse; }
caption { caption-side: bottom; }
th, td { text-align: left; vertical-align: top; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--line); }
thead th { position: sticky; top: 0; background: var(--bg-elevated); z-index: 1; }
th button { font: inherit; font-weight: 650; color: inherit; background: transparent; border: 0; padding: 0; cursor: pointer; text-align: left; }
th[aria-sort="ascending"] button::after, th[aria-sort="descending"] button::after {
  content: "";
  display: inline-block;
  margin-left: 0.4rem;
  vertical-align: middle;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
}
th[aria-sort="ascending"] button::after { border-bottom: 6px solid currentColor; }
th[aria-sort="descending"] button::after { border-top: 6px solid currentColor; }
tbody th[scope="row"] { font-weight: 400; overflow-wrap: anywhere; }
tbody th b { display: block; font-weight: 600; }
tbody th small { display: block; color: var(--muted); font-size: 0.82rem; }
td[data-label="Attempts"], td[data-label="Runs Seen"] { font-variant-numeric: tabular-nums; white-space: nowrap; }
.b1, .b2, .b3, .b4, .b5 {
  display: inline-block;
  padding: 0.12rem 0.45rem;
  border-radius: 0.3rem;
  border: 1px solid transparent;
  font-style: normal;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
}
.b1 { background: #18181b; color: #fafafa; }
.b2 { background: #3f3f46; color: #fafafa; }
.b3 { background: #e4e4e7; color: #18181b; }
.b4 { background: transparent; color: #18181b; border-color: #71717a; }
.b5 { background: transparent; color: #52525b; border-style: dashed; border-color: #a1a1aa; }
@media (prefers-color-scheme: dark) {
  .b1 { background: #fafafa; color: #18181b; }
  .b2 { background: #d4d4d8; color: #18181b; }
  .b3 { background: #3f3f46; color: #fafafa; }
  .b4 { color: #fafafa; border-color: #71717a; }
  .b5 { color: #a1a1aa; border-color: #a1a1aa; }
}
details { padding: 0; }
summary { cursor: pointer; color: var(--muted); font-size: 0.82rem; font-weight: 500; }
tbody tr + tr td { padding-top: 0.15rem; padding-bottom: 0.4rem; }
p, li { overflow-wrap: anywhere; }
pre {
  margin: 0;
  padding: 0.7rem 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 0.88rem;
}
code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 0.88rem; overflow-wrap: anywhere; }
.copy { display: block; width: fit-content; margin: 0.45rem 0 0; }
button {
  font: inherit;
  color: var(--ink);
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
}
.copy-buffer { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; }
.empty { padding: 1.1rem 1rem; }
.empty-title { margin: 0; font-size: 1.05rem; font-weight: 650; }
.empty p { margin: 0.4rem 0 0; color: var(--muted); }
.footer { padding-bottom: 2rem; color: var(--muted); font-size: 0.85rem; }
.footer p { margin: 0; }
${WIDTHS}
@media (max-width: 640px) {
  h1 { font-size: 1.6rem; }
  .top-inner, main, .footer { padding-left: 1rem; padding-right: 1rem; }
  .cards { grid-template-columns: 1fr 1fr; }
  .js .toolbar .sort { display: flex; }
  .toolbar { align-items: stretch; }
  .field, .toolbar select, .toolbar input[type="search"] { width: 100%; min-width: 0; }
  .table-wrap { overflow: visible; border: 0; background: transparent; }
  table, thead, tbody, tr, th, td { display: block; width: auto; }
  thead { display: none; }
  tbody {
    margin: 0 0 0.75rem;
    border: 1px solid var(--line);
    border-radius: 0.55rem;
    background: var(--bg-elevated);
    overflow: hidden;
  }
  th, td { border-bottom: 1px solid var(--line); }
  td[data-label]::before {
    content: attr(data-label);
    display: block;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  tbody tr + tr td { border-bottom: 0; }
  td[data-label="Attempts"], td[data-label="Runs Seen"] { white-space: normal; }
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
    --zero: #71717a;
  }
  .skip, .toolbar, .copy { display: none !important; }
  thead { display: table-header-group; position: static; }
  table { display: table; width: 100%; }
  tbody { display: table-row-group; margin: 0; border: 0; background: transparent; overflow: visible; }
  tr { display: table-row; }
  th, td { display: table-cell; }
  td[data-label]::before { content: none; display: none; }
  details, details > * { display: block !important; content-visibility: visible !important; }
  summary { display: list-item !important; }
  .b1 { background: #18181b; color: #fafafa; }
  .b2 { background: #3f3f46; color: #fafafa; }
  .b3 { background: #e4e4e7; color: #18181b; }
  .b4 { color: #18181b; border-color: #71717a; }
  .b5 { color: #52525b; border-color: #a1a1aa; }
  tbody { break-inside: avoid; }
}
`);

export const REPORT_SCRIPT = `
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var details = Array.prototype.slice.call(document.querySelectorAll('details'));
  var openBefore = null;
  window.addEventListener('beforeprint', function () {
    if (openBefore) return;
    openBefore = details.map(function (node) { return node.open; });
    details.forEach(function (node) { node.open = true; });
  });
  window.addEventListener('afterprint', function () {
    if (!openBefore) return;
    details.forEach(function (node, index) { node.open = openBefore[index]; });
    openBefore = null;
  });
  var table = document.querySelector('[data-report-table]');
  if (!table) return;
  var bodies = Array.prototype.slice.call(table.querySelectorAll('tbody'));
  var order = new Map();
  bodies.forEach(function (body, index) { order.set(body, index); });
  var verdict = document.getElementById('filter-verdict');
  var cause = document.getElementById('filter-cause');
  var confidence = document.getElementById('filter-confidence');
  var search = document.getElementById('filter-search');
  var sortBy = document.getElementById('sort-by');
  var status = document.getElementById('filter-status');
  var empty = document.getElementById('filter-empty');
  var headers = Array.prototype.slice.call(table.querySelectorAll('th[data-sort-key]'));
  var sortKey = '';
  var sortDir = 1;
  var verdictRank = { 'likely-real-bug': 0, flaky: 1, 'broken-test': 2, 'environment-issue': 3, 'needs-more-runs': 4 };
  var confidenceRank = { high: 0, medium: 1, low: 2 };

  function textCompare(left, right) {
    var a = String(left);
    var b = String(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function valueOf(body, key) {
    if (key === 'test') return body.getAttribute('data-test') || '';
    if (key === 'verdict') {
      var verdictName = body.getAttribute('data-v') || '';
      return Object.prototype.hasOwnProperty.call(verdictRank, verdictName) ? verdictRank[verdictName] : 5;
    }
    if (key === 'cause') return body.getAttribute('data-c') || '';
    if (key === 'confidence') {
      var confidenceName = body.getAttribute('data-k') || '';
      return Object.prototype.hasOwnProperty.call(confidenceRank, confidenceName) ? confidenceRank[confidenceName] : 3;
    }
    if (key === 'attempts') return [Number(body.getAttribute('data-f') || '0'), Number(body.getAttribute('data-n') || '0')];
    if (key === 'runs') return Number(body.getAttribute('data-r') || '0');
    return order.get(body) || 0;
  }

  function compare(left, right) {
    var a = valueOf(left, sortKey);
    var b = valueOf(right, sortKey);
    var delta = 0;
    if (Array.isArray(a) && Array.isArray(b)) {
      delta = a[0] - b[0];
      if (delta === 0) delta = a[1] - b[1];
    } else if (typeof a === 'number' && typeof b === 'number') {
      delta = a - b;
    } else {
      delta = textCompare(a, b);
    }
    if (delta === 0) delta = (order.get(left) || 0) - (order.get(right) || 0);
    return delta * sortDir;
  }

  function paint() {
    bodies.forEach(function (body) { table.appendChild(body); });
  }

  function applySort() {
    if (!sortKey) return;
    bodies.sort(compare);
    paint();
  }

  function matches(body) {
    if (verdict && verdict.value && body.getAttribute('data-v') !== verdict.value) return false;
    if (cause && cause.value && body.getAttribute('data-c') !== cause.value) return false;
    if (confidence && confidence.value && body.getAttribute('data-k') !== confidence.value) return false;
    var query = search && search.value ? search.value.trim().toLowerCase() : '';
    if (!query) return true;
    var hay = ((body.getAttribute('data-test') || '') + ' ' + (body.textContent || '')).toLowerCase();
    return hay.indexOf(query) !== -1;
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

  function markHeaders(key, direction) {
    headers.forEach(function (other) {
      var next = 'none';
      if (key && other.getAttribute('data-sort-key') === key) next = direction === 1 ? 'ascending' : 'descending';
      other.setAttribute('aria-sort', next);
    });
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
      if (sortBy) sortBy.value = key;
      markHeaders(sortKey, sortDir);
      applySort();
      applyFilter();
    });
  });

  if (sortBy) {
    sortBy.addEventListener('change', function () {
      sortKey = sortBy.value;
      sortDir = 1;
      if (!sortKey) {
        bodies.sort(function (left, right) { return (order.get(left) || 0) - (order.get(right) || 0); });
        paint();
        markHeaders('', 1);
        applyFilter();
        return;
      }
      markHeaders(sortKey, sortDir);
      applySort();
      applyFilter();
    });
  }

  [verdict, cause, confidence].forEach(function (node) {
    if (!node) return;
    node.addEventListener('change', applyFilter);
  });
  if (search) search.addEventListener('input', applyFilter);

  Array.prototype.forEach.call(document.querySelectorAll('button.copy'), function (button) {
    button.addEventListener('click', function () {
      var code = button.previousElementSibling;
      var text = code ? code.textContent || '' : '';
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
