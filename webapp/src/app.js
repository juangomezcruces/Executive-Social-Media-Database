/**
 * UI for the Executive Social Media Database.
 *
 * Plain modules, no framework and no build step: the page is small enough that
 * a bundler would add a deploy dependency without buying anything.
 *
 * The page is a thin client. Rows come from the API, capped at 100 per request
 * for anonymous visitors; the stat row and both charts are computed in the
 * browser from one precomputed monthly object, so moving a filter costs the
 * database nothing.
 */

import {
  LIMITS, ApiError,
  getManifest, getSummary, getLeaders,
  queryTweets, queryCount, queryAggregates, hasUnchartableFilter,
  runSql, downloadTable, getKey, setKey, hasKey,
  getLanguages, expandTerm,
} from './data.js';

const PAGE_SIZE = 50;

/**
 * A searchable checkbox dropdown. Built by hand rather than pulled in as a
 * dependency: with 62 leaders a native <select multiple> is unusable on a
 * phone, and this is about eighty lines.
 */
function createMultiSelect(root, onChange) {
  const toggle = root.querySelector('.multi-toggle');
  const panel = root.querySelector('.multi-panel');
  const search = root.querySelector('.multi-search');
  const list = root.querySelector('.multi-options');
  const summaryEl = root.querySelector('.multi-summary');
  const placeholder = root.dataset.placeholder || 'All';
  const noun = placeholder.replace(/^All\s+/, '');
  let items = [];
  const selected = new Set();

  function summary() {
    if (selected.size === 0) return placeholder;
    if (selected.size === 1) {
      const only = items.find((i) => i.value === [...selected][0]);
      return only ? only.label : `1 ${noun}`;
    }
    if (selected.size === items.length) return `All ${noun}`;
    return `${selected.size} ${noun} selected`;
  }

  function paint() {
    summaryEl.textContent = summary();
    root.dataset.active = selected.size > 0 ? 'true' : 'false';
  }

  function render() {
    const needle = search.value.trim().toLowerCase();
    const shown = needle
      ? items.filter((i) => i.label.toLowerCase().includes(needle))
      : items;
    if (!shown.length) {
      list.innerHTML = '<p class="multi-empty">No matches.</p>';
      return;
    }
    list.innerHTML = shown.map((i) => `
      <label class="multi-option" role="option"
             aria-selected="${selected.has(i.value)}">
        <input type="checkbox" value="${escapeHtml(i.value)}"
               ${selected.has(i.value) ? 'checked' : ''}>
        <span>${escapeHtml(i.label)}</span>
      </label>`).join('');
  }

  function open(next) {
    panel.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
    if (next) { render(); search.focus(); }
  }

  toggle.addEventListener('click', () => open(panel.hidden));
  search.addEventListener('input', render);
  list.addEventListener('change', (event) => {
    const box = event.target;
    if (box.checked) selected.add(box.value); else selected.delete(box.value);
    box.closest('.multi-option')?.setAttribute('aria-selected', String(box.checked));
    paint();
    onChange();
  });
  root.querySelector('[data-all]').addEventListener('click', () => {
    items.forEach((i) => selected.add(i.value));
    render(); paint(); onChange();
  });
  root.querySelector('[data-none]').addEventListener('click', () => {
    selected.clear(); render(); paint(); onChange();
  });
  // Clicking away closes the panel; Escape returns focus to the button.
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !root.contains(event.target)) open(false);
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) { open(false); toggle.focus(); }
  });

  return {
    setItems(next) { items = next; selected.clear(); paint(); render(); },
    get value() { return [...selected]; },
    clear() { selected.clear(); paint(); render(); },
  };
}

const els = {
  releaseMeta: document.getElementById('release-meta'),
  ledeCounts: document.getElementById('lede-counts'),
  form: document.getElementById('filters'),
  leader: document.getElementById('f-leader'),
  country: document.getElementById('f-country'),
  replies: document.getElementById('f-replies'),
  start: document.getElementById('f-start'),
  end: document.getElementById('f-end'),
  engagement: document.getElementById('f-engagement'),
  search: document.getElementById('f-search'),
  expand: document.getElementById('f-expand'),
  stats: document.getElementById('stats'),
  scopeNote: document.getElementById('scope-note'),
  volNote: document.getElementById('vol-note'),
  countNote: document.getElementById('count-note'),
  resultCount: document.getElementById('result-count'),
  tbody: document.querySelector('#results tbody'),
  pager: document.getElementById('pager'),
  capNote: document.getElementById('cap-note'),
  keyForm: document.getElementById('key-form'),
  keyInput: document.getElementById('key-input'),
  keyStatus: document.getElementById('key-status'),
  keyClear: document.getElementById('key-clear'),
  downloads: document.getElementById('downloads'),
  sqlPanel: document.getElementById('sql-panel'),
  sqlForm: document.getElementById('sql-form'),
  sqlInput: document.getElementById('sql-input'),
  sqlLocked: document.getElementById('sql-locked'),
  sqlHead: document.querySelector('#sql-results thead'),
  sqlBody: document.querySelector('#sql-results tbody'),
};

let page = 0;
let charts = { volume: null, tweets: null, engagement: null };
let sort = { column: 'created_at', direction: 'desc' };
let leaderSelect = null;
let countrySelect = null;
let leaderName = new Map();
let leaderCountry = new Map();
let inFlight = null;
/**
 * The last count, keyed by the filters that produced it. Counting is the one
 * request that can read up to 10,001 rows, and neither turning a page nor
 * changing the sort changes the answer — so it is asked once per filter set,
 * not once per view.
 */
let lastCount = { signature: null, value: null };

/**
 * The current expansion: the term it was built for, the languages it targeted
 * and every suggested term. Held here rather than recomputed, because each
 * expansion is a model call and the point is to make one.
 */
const noExpansion = () => ({ term: null, langs: [], terms: [] });
let expansion = noExpansion();
let languageMap = { by_country: {}, default: [] };

const num = new Intl.NumberFormat('en-US');
const fmtDate = (value) => String(value ?? '').slice(0, 10);
/** "2019-03" → "Mar 2019", for axis labels and the stat row. */
const fmtMonth = (value) => {
  if (!value) return '';
  const [year, month] = value.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
    'Nov', 'Dec'][Number(month) - 1]} ${year}`;
};

/** Ceilings depend on whether a key is present. */
const ceilings = () => (hasKey()
  ? { rows: LIMITS.keyedRows, offset: LIMITS.keyedOffset }
  : { rows: LIMITS.rows, offset: LIMITS.offset });

/** Read the token values the charts should paint with, live from the CSS. */
function tokens() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  return {
    series: get('--series-1'),
    seriesSoft: get('--series-1-soft'),
    muted: get('--text-muted'),
    secondary: get('--text-secondary'),
    grid: get('--gridline'),
    baseline: get('--baseline'),
    surface: get('--surface-1'),
  };
}

function currentFilters() {
  return {
    leaders: leaderSelect ? leaderSelect.value : [],
    countries: countrySelect ? countrySelect.value : [],
    startDate: els.start.value || null,
    endDate: els.end.value || null,
    minEngagement: els.engagement.value ? Number(els.engagement.value) : null,
    search: els.search.value.trim() || null,
    // Everything the model suggested, never the original twice.
    also: expansion.terms.slice(1),
    // The checkbox now reads "Include replies" and is off by default:
    // broadcast is the honest baseline, since a leader who runs an
    // @-reply account otherwise swamps every volume comparison.
    excludeReplies: !els.replies.checked,
  };
}

// --------------------------------------------------------------------------
// charts
// --------------------------------------------------------------------------

/** Shared Chart.js styling: recessive chrome, thin marks, hover always on. */
function baseOptions(t, { valueLabel, valueAxis = 'y' }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 220 },
    plugins: {
      legend: { display: false }, // single series -- the heading names it
      tooltip: {
        backgroundColor: t.surface,
        titleColor: t.secondary,
        bodyColor: t.secondary,
        borderColor: t.baseline,
        borderWidth: 1,
        padding: 10,
        displayColors: false,
        callbacks: {
          label: (ctx) => `${valueLabel}: ${num.format(ctx.parsed[valueAxis])}`,
        },
      },
    },
  };
}

/** `numeric: true` formats tick values; category axes keep their labels. */
function axis(t, { numeric = true, showGrid = true } = {}) {
  return {
    grid: showGrid ? { color: t.grid, drawTicks: false } : { display: false },
    border: { color: t.baseline },
    ticks: {
      color: t.muted,
      font: { size: 11, family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
      ...(numeric ? { callback: (value) => num.format(value) } : {}),
    },
  };
}

function drawVolume(rows) {
  const t = tokens();
  charts.volume?.destroy();
  charts.volume = new Chart(document.getElementById('chart-volume'), {
    type: 'line',
    data: {
      labels: rows.map((r) => r.month),
      datasets: [{
        data: rows.map((r) => r.tweets),
        borderColor: t.series,
        backgroundColor: t.seriesSoft,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: t.series,
        pointHoverBorderColor: t.surface,
        pointHoverBorderWidth: 2,
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      ...baseOptions(t, { valueLabel: 'Tweets', valueAxis: 'y' }),
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: (() => {
          const a = axis(t, { numeric: false, showGrid: false });
          a.ticks = { ...a.ticks, maxTicksLimit: 8, autoSkip: true };
          return a;
        })(),
        y: { ...axis(t), beginAtZero: true },
      },
    },
  });
  // Months are the x values; the tooltip title spells them out in full.
  charts.volume.options.plugins.tooltip.callbacks.title =
    (items) => fmtMonth(items[0].label);
  charts.volume.update('none');
}

/**
 * A horizontal bar of one number per leader. Both leader charts are the same
 * picture of different columns, so they are the same function -- which is also
 * what keeps them looking like one chart drawn twice rather than two charts.
 */
function drawLeaderBars({ key, canvas, rows, value, label }) {
  const t = tokens();
  charts[key]?.destroy();
  charts[key] = new Chart(document.getElementById(canvas), {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.leader),
      datasets: [{
        data: rows.map((r) => r[value]),
        backgroundColor: t.series,
        borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
        borderSkipped: false,
        barThickness: 'flex',
        maxBarThickness: 18,
      }],
    },
    options: {
      ...baseOptions(t, { valueLabel: label, valueAxis: 'x' }),
      indexAxis: 'y',
      interaction: { mode: 'nearest', intersect: true },
      scales: {
        x: { ...axis(t), beginAtZero: true },
        y: axis(t, { numeric: false, showGrid: false }),
      },
    },
  });
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

function renderStats(totals) {
  const span = totals.tweets
    ? `${fmtMonth(totals.firstMonth)} to ${fmtMonth(totals.lastMonth)}`
    : 'no matching tweets';
  const mean = totals.tweets ? Math.round(totals.engagement / totals.tweets) : 0;
  const replyShare = totals.tweets
    ? Math.round((totals.replies / totals.tweets) * 100)
    : 0;
  const replyLine = els.replies.checked
    ? `${num.format(totals.replies)} replies (${replyShare}%)`
    : 'broadcast only';
  els.stats.innerHTML = `
    <dl class="stat"><dt>Tweets</dt><dd>${num.format(totals.tweets)}<span class="sub">${span}</span></dd></dl>
    <dl class="stat"><dt>Leaders</dt><dd>${num.format(totals.leaders)}</dd></dl>
    <dl class="stat"><dt>Total engagement</dt><dd>${num.format(totals.engagement)}</dd></dl>
    <dl class="stat"><dt>Mean per tweet</dt><dd>${num.format(mean)}<span class="sub">${replyLine}</span></dd></dl>
  `;
}

/** Reflect the current sort in the header arrows and aria-sort. */
function paintSortHeaders() {
  for (const th of document.querySelectorAll('#results th[data-sort]')) {
    th.setAttribute(
      'aria-sort',
      th.dataset.sort === sort.column
        ? (sort.direction === 'asc' ? 'ascending' : 'descending')
        : 'none',
    );
  }
}

function renderTable(rows) {
  if (!rows.length) {
    els.tbody.innerHTML =
      '<tr><td class="empty" colspan="8">No tweets match these filters.</td></tr>';
    return;
  }
  els.tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="leader">${escapeHtml(leaderName.get(r.leader_id) || r.leader_id)}</td>
      <td class="when">${fmtDate(r.created_at)}</td>
      <td class="text">${r.is_reply ? '<span class="tag">reply</span> ' : ''}${
        r.is_deleted ? '<span class="tag tag--warn">deleted</span> ' : ''
      }${escapeHtml(r.text)}</td>
      <td class="num">${num.format(r.retweet_count)}</td>
      <td class="num">${num.format(r.reply_count)}</td>
      <td class="num">${num.format(r.like_count)}</td>
      <td class="num">${num.format(r.quote_count)}</td>
      <td class="num">${num.format(r.engagement)}</td>
    </tr>`).join('');
}

/**
 * Paging, bounded by the same offset ceiling the Worker enforces. Walking the
 * corpus 50 rows at a time is exactly what the cap exists to prevent, so the
 * pager stops where the API does and says why instead of erroring.
 */
function renderPager({ count, exact }, shown) {
  const { offset: maxOffset } = ceilings();
  const from = count ? page * PAGE_SIZE + 1 : 0;
  const to = page * PAGE_SIZE + shown;
  const total = exact ? num.format(count) : `${num.format(count)}+`;
  els.resultCount.textContent = count
    ? `${num.format(from)}–${num.format(to)} of ${total}`
    : '0 tweets';

  const lastPageByCount = exact ? Math.ceil(count / PAGE_SIZE) - 1 : Infinity;
  const lastPageByCap = Math.floor(maxOffset / PAGE_SIZE);
  const lastPage = Math.min(lastPageByCount, lastPageByCap);
  const pages = exact ? Math.ceil(count / PAGE_SIZE) : null;

  els.pager.innerHTML = `
    <button class="btn" data-step="-1" ${page === 0 ? 'disabled' : ''}>Previous</button>
    <span class="page-of">Page ${num.format(page + 1)}${pages ? ` of ${num.format(pages)}` : ''}</span>
    <button class="btn" data-step="1" ${page >= lastPage ? 'disabled' : ''}>Next</button>
  `;
  for (const button of els.pager.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      page += Number(button.dataset.step);
      refresh({ resetPage: false, chartsToo: false });
    });
  }

  const atCap = page >= lastPageByCap && lastPageByCount > lastPageByCap;
  els.capNote.hidden = !atCap;
  if (atCap) {
    els.capNote.textContent = hasKey()
      ? `Paging stops at ${num.format(maxOffset)} rows. Download the full table instead.`
      : `Anonymous browsing stops here, at ${num.format(maxOffset + PAGE_SIZE)} rows. `
        + 'A free API key raises the ceiling and unlocks the full tables.';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** One place to turn an ApiError into something a person can act on. */
function describeError(error) {
  const hint = error instanceof ApiError && error.hint ? ` ${error.hint}` : '';
  return `${error.message}${hint}`;
}

// --------------------------------------------------------------------------
// orchestration
// --------------------------------------------------------------------------

/** Human-readable summary of what the charts are currently showing. */
function describeSelection({ leaders, countries, excludeReplies }, totals) {
  const parts = [];
  if (leaders.length === 1) parts.push(leaderName.get(leaders[0]) || '1 leader');
  else if (leaders.length > 1) parts.push(`${leaders.length} leaders`);
  if (countries.length === 1) parts.push(countries[0]);
  else if (countries.length > 1) parts.push(`${countries.length} countries`);
  if (!parts.length) parts.push('All leaders');
  // Always stated, never implied: which of the two populations this is
  // decides whether the numbers underneath mean anything.
  parts.push(excludeReplies ? 'broadcast only' : 'replies included');
  if (totals?.partialMonths) parts.push('whole months only');
  return parts.join(' · ');
}

/**
 * Which languages to translate into: the ones actually used by the countries
 * on screen. Selected countries win; failing that, the countries of the
 * selected leaders; failing that, the languages that cover most of the corpus.
 */
function targetLanguages() {
  const countries = countrySelect ? countrySelect.value : [];
  const fromLeaders = (leaderSelect ? leaderSelect.value : [])
    .map((id) => leaderCountry.get(id))
    .filter(Boolean);
  const chosen = countries.length ? countries : fromLeaders;

  // No country and no leader means the user has not said which languages they
  // care about, and guessing at the whole corpus is worse than not guessing:
  // it translated `housing` into seven languages at once and pulled in `casa`,
  // which is "house" in the everyday sense and matched 2,368 tweets about
  // anything at all. English only until asked otherwise.
  if (!chosen.length) return [];

  const langs = new Set();
  for (const country of chosen) {
    for (const lang of languageMap.by_country[country] || []) langs.add(lang);
  }
  return [...langs].slice(0, 8);
}

/** Fetch an expansion for the current term, unless we already have that one. */
async function ensureExpansion() {
  const term = els.search.value.trim();
  const langs = targetLanguages();
  if (!els.expand.checked || !term) {
    expansion = noExpansion();
    return;
  }
  const same = expansion.term === term
    && expansion.langs.join(',') === langs.join(',');
  if (same) return;

  const result = await expandTerm(term, langs);
  expansion = { term, langs: result.langs || langs, terms: result.terms || [term] };
}

async function refresh({ resetPage = true, chartsToo = true } = {}) {
  if (resetPage) page = 0;
  const filters = currentFilters();

  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  const { signal } = controller;

  // The charts and the stat row are pure arithmetic over data already in the
  // browser, so they repaint immediately, before the network round trip.
  if (chartsToo) {
    try {
      const { monthly, byLeader, totals } = await queryAggregates(filters);
      renderStats(totals);
      drawVolume(monthly);

      // Every leader in the selection, biggest first. No minimum here: a
      // leader with nine tweets has a meaningful total, where their mean
      // engagement would be noise -- which is what the 25 below is for.
      const byVolume = [...byLeader].sort((a, b) => b.tweets - a.tweets);
      drawLeaderBars({
        key: 'tweets',
        canvas: 'chart-tweets',
        rows: byVolume.slice(0, 15),
        value: 'tweets',
        label: 'Tweets',
      });
      els.countNote.textContent = byVolume.length > 15
        ? `The 15 most active of ${num.format(byVolume.length)} leaders in the current selection`
        : 'Leaders in the current selection';

      drawLeaderBars({
        key: 'engagement',
        canvas: 'chart-engagement',
        rows: byLeader.filter((l) => l.tweets >= 25)
          .sort((a, b) => b.mean_engagement - a.mean_engagement)
          .slice(0, 15),
        value: 'mean_engagement',
        label: 'Mean engagement',
      });
      els.volNote.textContent = describeSelection(filters, totals);
    } catch (error) {
      els.stats.innerHTML =
        `<dl class="stat"><dt>Error</dt><dd style="font-size:1rem">${escapeHtml(describeError(error))}</dd></dl>`;
    }
  }

  // Text search and minimum engagement cannot be applied to a monthly object
  // with no text column. Rather than let the summary quietly disagree with the
  // table, say which numbers each filter reaches.
  els.scopeNote.hidden = !hasUnchartableFilter(filters);

  els.tbody.setAttribute('aria-busy', 'true');
  const signature = JSON.stringify(filters);
  try {
    const [tweets, count] = await Promise.all([
      queryTweets(filters, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort: sort.column,
        direction: sort.direction,
        signal,
      }),
      lastCount.signature === signature
        ? Promise.resolve(lastCount.value)
        : queryCount(filters, { signal }),
    ]);
    if (signal.aborted) return;
    lastCount = { signature, value: count };
    renderTable(tweets.rows);
    renderPager(count, tweets.rows.length);
  } catch (error) {
    if (error.name === 'AbortError') return;
    els.tbody.innerHTML =
      `<tr><td class="empty" colspan="8">${escapeHtml(describeError(error))}</td></tr>`;
    els.resultCount.textContent = '';
    els.pager.innerHTML = '';
  } finally {
    els.tbody.removeAttribute('aria-busy');
  }
}

// --------------------------------------------------------------------------
// keys
// --------------------------------------------------------------------------

/** Reflect the presence of a key across the three things it changes. */
function paintKeyState() {
  const on = hasKey();
  els.keyStatus.textContent = on
    ? 'A key is stored in this browser. Full tables and SQL are unlocked.'
    : 'No key. Browsing is capped at 100 rows per request.';
  els.keyStatus.dataset.on = String(on);
  els.keyClear.hidden = !on;
  els.keyInput.value = '';
  els.keyInput.placeholder = on ? 'Replace the stored key…' : 'esmd_…';
  els.sqlForm.hidden = !on;
  els.sqlLocked.hidden = on;
  els.downloads.querySelectorAll('button').forEach((b) => { b.disabled = !on; });
  if (!on) {
    // Don't leave the previous key holder's results sitting under a locked form.
    els.sqlHead.innerHTML = '';
    els.sqlBody.innerHTML = '';
  }
}

async function download(table, format, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const { blob, filename } = await downloadTable(table, format);
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    els.keyStatus.textContent = describeError(error);
    els.keyStatus.dataset.on = 'false';
  } finally {
    button.textContent = original;
    button.disabled = !hasKey();
  }
}

/**
 * Wire up every listener. Called before the first query runs: if loading fails,
 * the controls must still respond rather than falling through to native form
 * submission, which would reload the page.
 */
function bindEvents() {
  // The multi-selects live outside the form's native value handling, so they
  // are built here and cleared explicitly on reset.
  leaderSelect = createMultiSelect(els.leader, () => {});
  countrySelect = createMultiSelect(els.country, () => {});

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await ensureExpansion();
    refresh();
  });

  // Switching expansion off should take effect immediately, not on the next
  // Apply: it changes what the numbers on screen mean.
  els.expand.addEventListener('change', async () => {
    await ensureExpansion();
    refresh();
  });

  els.form.addEventListener('reset', () => {
    leaderSelect.clear();
    countrySelect.clear();
    expansion = noExpansion();
    // Native reset restores the checkbox to unchecked, which is now "replies
    // excluded" -- the default we want.
    sort = { column: 'created_at', direction: 'desc' };
    paintSortHeaders();
    setTimeout(() => refresh(), 0);
  });

  for (const th of document.querySelectorAll('#results th[data-sort]')) {
    th.querySelector('button').addEventListener('click', () => {
      const column = th.dataset.sort;
      // Same column flips direction; a new column starts descending, except
      // for the leader column where A-Z is the useful first click.
      sort = sort.column === column
        ? { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: column === 'leader' ? 'asc' : 'desc' };
      paintSortHeaders();
      refresh({ resetPage: true, chartsToo: false });
    });
  }

  els.keyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.keyInput.value.trim();
    if (!value) return;
    setKey(value);
    paintKeyState();
    refresh({ resetPage: true, chartsToo: false });
  });
  els.keyClear.addEventListener('click', () => {
    setKey(null);
    paintKeyState();
    refresh({ resetPage: true, chartsToo: false });
  });
  els.downloads.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-table]');
    if (button) download(button.dataset.table, button.dataset.format, button);
  });

  els.sqlForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.sqlHead.innerHTML = '';
    els.sqlBody.innerHTML = '<tr><td class="empty">Running…</td></tr>';
    try {
      const { rows } = await runSql(els.sqlInput.value);
      if (!rows.length) {
        els.sqlBody.innerHTML = '<tr><td class="empty">Query returned no rows.</td></tr>';
        return;
      }
      const columns = Object.keys(rows[0]);
      els.sqlHead.innerHTML =
        `<tr>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr>`;
      els.sqlBody.innerHTML = rows.map((row) =>
        `<tr>${columns.map((c) => {
          const value = row[c];
          const isNumber = typeof value === 'number';
          return `<td class="${isNumber ? 'num' : ''}">${escapeHtml(isNumber ? num.format(value) : value)}</td>`;
        }).join('')}</tr>`).join('');
    } catch (error) {
      els.sqlHead.innerHTML = '';
      els.sqlBody.innerHTML =
        `<tr><td class="empty">${escapeHtml(describeError(error))}</td></tr>`;
    }
  });

  // Charts read colour tokens at draw time, so a theme change needs a redraw.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => refresh({ resetPage: false }));
}

async function main() {
  bindEvents();
  paintKeyState();
  els.releaseMeta.textContent = 'Loading…';
  try {
    const [manifest, summary, leaders, languages] = await Promise.all([
      getManifest(), getSummary(), getLeaders(),
      // A missing language map only costs the expansion its targeting, so it
      // must not take the whole page down with it.
      getLanguages().catch(() => ({ by_country: {}, default: [] })),
    ]);
    languageMap = languages;

    els.releaseMeta.textContent =
      `Release ${manifest.version} · ${num.format(summary.tweets)} tweets · `
      + `generated ${manifest.generated_at.slice(0, 10)}`;

    // Derived from the data rather than hardcoded, so the headline can't go
    // stale the next time a batch of leaders is added.
    els.ledeCounts.textContent =
      `${num.format(summary.tweets)} tweets and their engagement metrics from `
      + `${num.format(summary.leaders)} heads of government and state across `
      + `${num.format(summary.countries)} countries, `
      + `${summary.first_date.slice(0, 4)}–${summary.last_date.slice(0, 4)}`;

    leaderName = new Map(leaders.map((l) => [l.leader_id, l.name]));
    leaderCountry = new Map(leaders.map((l) => [l.leader_id, l.country]));
    for (const input of [els.start, els.end]) {
      input.min = summary.first_date;
      input.max = summary.last_date;
    }

    leaderSelect.setItems(leaders.map((l) => ({
      value: l.leader_id, label: `${l.name} (${l.country})`,
    })));
    countrySelect.setItems(
      [...new Set(leaders.map((l) => l.country))].sort()
        .map((c) => ({ value: c, label: c }))
    );

    paintSortHeaders();
    await refresh();
  } catch (error) {
    els.releaseMeta.textContent = `Could not load the dataset: ${describeError(error)}`;
    els.stats.innerHTML =
      `<dl class="stat"><dt>Error</dt><dd style="font-size:1rem">${escapeHtml(describeError(error))}</dd></dl>`;
  }
}

main();
