/**
 * UI for the Executive Social Media Database.
 *
 * Plain modules, no framework and no build step: the page is small enough that
 * a bundler would add a deploy dependency without buying anything.
 */

import {
  dataVersion, queryLeaders, queryTweets, queryVolume,
  queryEngagementByLeader, querySummary, runSql,
} from './data.js';

const PAGE_SIZE = 50;

const els = {
  releaseMeta: document.getElementById('release-meta'),
  form: document.getElementById('filters'),
  leader: document.getElementById('f-leader'),
  country: document.getElementById('f-country'),
  start: document.getElementById('f-start'),
  end: document.getElementById('f-end'),
  engagement: document.getElementById('f-engagement'),
  search: document.getElementById('f-search'),
  stats: document.getElementById('stats'),
  volNote: document.getElementById('vol-note'),
  resultCount: document.getElementById('result-count'),
  tbody: document.querySelector('#results tbody'),
  pager: document.getElementById('pager'),
  sqlForm: document.getElementById('sql-form'),
  sqlInput: document.getElementById('sql-input'),
  sqlHead: document.querySelector('#sql-results thead'),
  sqlBody: document.querySelector('#sql-results tbody'),
};

let page = 0;
let charts = { volume: null, engagement: null };

const num = new Intl.NumberFormat('en-US');
const fmtDate = (value) =>
  new Date(value).toISOString().slice(0, 10);

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
    leader: els.leader.value || null,
    country: els.country.value || null,
    startDate: els.start.value || null,
    endDate: els.end.value || null,
    minEngagement: els.engagement.value ? Number(els.engagement.value) : null,
    search: els.search.value.trim() || null,
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
  const labels = rows.map((r) => fmtDate(r.month).slice(0, 7));
  const data = rows.map((r) => r.tweets);
  charts.volume?.destroy();
  charts.volume = new Chart(document.getElementById('chart-volume'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
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
}

function drawEngagement(rows) {
  const t = tokens();
  charts.engagement?.destroy();
  charts.engagement = new Chart(document.getElementById('chart-engagement'), {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.leader),
      datasets: [{
        data: rows.map((r) => r.mean_engagement),
        backgroundColor: t.series,
        borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
        borderSkipped: false,
        barThickness: 'flex',
        maxBarThickness: 18,
      }],
    },
    options: {
      ...baseOptions(t, { valueLabel: 'Mean engagement', valueAxis: 'x' }),
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

function renderStats(summary) {
  const span = summary.tweets
    ? `${fmtDate(summary.first_date)} to ${fmtDate(summary.last_date)}`
    : 'no matching tweets';
  const mean = summary.tweets
    ? Math.round(summary.engagement / summary.tweets)
    : 0;
  els.stats.innerHTML = `
    <dl class="stat"><dt>Tweets</dt><dd>${num.format(summary.tweets)}<span class="sub">${span}</span></dd></dl>
    <dl class="stat"><dt>Leaders</dt><dd>${num.format(summary.leaders)}</dd></dl>
    <dl class="stat"><dt>Total engagement</dt><dd>${num.format(summary.engagement || 0)}</dd></dl>
    <dl class="stat"><dt>Mean per tweet</dt><dd>${num.format(mean)}</dd></dl>
  `;
}

function renderTable({ rows, total }) {
  if (!rows.length) {
    els.tbody.innerHTML = '<tr><td class="empty" colspan="8">No tweets match these filters.</td></tr>';
  } else {
    els.tbody.innerHTML = rows.map((r) => `
      <tr>
        <td class="leader">${escapeHtml(r.leader)}</td>
        <td class="when">${fmtDate(r.created_at)}</td>
        <td class="text">${escapeHtml(r.text)}</td>
        <td class="num">${num.format(r.retweet_count)}</td>
        <td class="num">${num.format(r.reply_count)}</td>
        <td class="num">${num.format(r.like_count)}</td>
        <td class="num">${num.format(r.quote_count)}</td>
        <td class="num">${num.format(r.engagement)}</td>
      </tr>`).join('');
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? page * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  els.resultCount.textContent = total
    ? `${num.format(from)}–${num.format(to)} of ${num.format(total)}`
    : '0 tweets';

  els.pager.innerHTML = `
    <button class="btn" data-step="-1" ${page === 0 ? 'disabled' : ''}>Previous</button>
    <span class="page-of">Page ${num.format(page + 1)} of ${num.format(pages)}</span>
    <button class="btn" data-step="1" ${page + 1 >= pages ? 'disabled' : ''}>Next</button>
  `;
  for (const button of els.pager.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      page += Number(button.dataset.step);
      refresh({ resetPage: false, chartsToo: false });
    });
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --------------------------------------------------------------------------
// orchestration
// --------------------------------------------------------------------------

async function refresh({ resetPage = true, chartsToo = true } = {}) {
  if (resetPage) page = 0;
  const filters = currentFilters();

  els.volNote.textContent = filters.leader
    ? els.leader.options[els.leader.selectedIndex].text
    : (filters.country || 'All leaders');

  const work = [
    queryTweets(filters, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then(renderTable),
  ];
  if (chartsToo) {
    work.push(
      querySummary(filters).then(renderStats),
      queryVolume(filters).then(drawVolume),
      queryEngagementByLeader(filters).then(drawEngagement),
    );
  }
  await Promise.all(work);
}

/**
 * Wire up every listener. Called before the first query runs: if loading the
 * data fails, the controls must still respond rather than falling through to
 * native form submission, which would reload the page.
 */
function bindEvents() {
  els.form.addEventListener('submit', (event) => { event.preventDefault(); refresh(); });
  els.form.addEventListener('reset', () => setTimeout(() => refresh(), 0));

  els.sqlForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.sqlBody.innerHTML = '<tr><td class="empty">Running…</td></tr>';
    try {
      const rows = await runSql(els.sqlInput.value);
      if (!rows.length) {
        els.sqlHead.innerHTML = '';
        els.sqlBody.innerHTML = '<tr><td class="empty">Query returned no rows.</td></tr>';
        return;
      }
      const columns = Object.keys(rows[0]);
      els.sqlHead.innerHTML =
        `<tr>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr>`;
      els.sqlBody.innerHTML = rows.slice(0, 200).map((row) =>
        `<tr>${columns.map((c) => {
          const value = row[c];
          const isNumber = typeof value === 'number';
          return `<td class="${isNumber ? 'num' : ''}">${escapeHtml(isNumber ? num.format(value) : value)}</td>`;
        }).join('')}</tr>`).join('');
    } catch (error) {
      els.sqlHead.innerHTML = '';
      els.sqlBody.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`;
    }
  });

  // Charts read colour tokens at draw time, so a theme change needs a redraw.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => refresh({ resetPage: false }));
}

async function main() {
  bindEvents();
  els.releaseMeta.textContent = 'Starting DuckDB and loading the dataset…';
  try {
    const [manifest, leaders] = await Promise.all([dataVersion(), queryLeaders()]);

    els.releaseMeta.textContent =
      `Release ${manifest.version} · ${num.format(manifest.tables.tweets.rows)} tweets ` +
      `· generated ${manifest.generated_at.slice(0, 10)}`;

    for (const leader of leaders) {
      els.leader.add(new Option(`${leader.name} (${leader.country})`, leader.leader_id));
    }
    for (const country of [...new Set(leaders.map((l) => l.country))].sort()) {
      els.country.add(new Option(country, country));
    }

    await refresh();
  } catch (error) {
    els.releaseMeta.textContent = `Could not load the dataset: ${error.message}`;
    els.stats.innerHTML = `<dl class="stat"><dt>Error</dt><dd style="font-size:1rem">${escapeHtml(error.message)}</dd></dl>`;
  }
}

main();
