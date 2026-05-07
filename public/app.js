// ============================================================================
// State
// ============================================================================
const FALLBACK_RATES = {
  CURRENCY: '$',
  COMPUTE_USD_PER_CU_HOUR: 0.16,
  STORAGE_USD_PER_GB_MONTH: 0.35,
  INSTANT_RESTORE_USD_PER_GB_MONTH: 0.20,
  NETWORK_USD_PER_GB: 0.10,
  INCLUDED_NETWORK_GB_PER_PROJECT: 100,
  _source: 'fallback',
};

let state = {
  config: { has_api_key: false, api_key_masked: '', orgs: [], base_rates: { ...FALLBACK_RATES } },
  data: { orgs: {} },
};
let activeOrgId = '__all__';     // '__all__' for All Orgs view
let activeTab = 'overview';
let activeCharts = [];           // Chart instances to destroy on re-render

// ============================================================================
// Helpers
// ============================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PALETTE = [
  '#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
  '#0ea5e9', '#8b5cf6',
];
const colorFor = (i) => PALETTE[i % PALETTE.length];

// Apply consistent Chart.js defaults globally (called once at init).
function applyChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#475569';
  Chart.defaults.borderColor = 'rgba(15, 23, 42, 0.06)';
  Chart.defaults.animation.duration = 700;
  Chart.defaults.animation.easing = 'easeOutQuart';
}

// Returns base options object every chart shares (clean grid, nice tooltip).
function chartTheme(extra = {}) {
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          boxWidth: 8, boxHeight: 8, padding: 14,
          usePointStyle: true,
          pointStyle: 'circle',
          font: { size: 11, weight: 500 },
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.96)',
        titleColor: '#f8fafc',
        bodyColor: '#e2e8f0',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 8,
        displayColors: true,
        boxPadding: 6,
        usePointStyle: true,
        titleFont: { size: 12, weight: 600 },
        bodyFont: { size: 12 },
      },
    },
    scales: {
      x: {
        grid: { display: false, drawBorder: false },
        border: { display: false },
        ticks: { font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(15, 23, 42, 0.05)', drawBorder: false },
        border: { display: false },
        ticks: { font: { size: 11 } },
        beginAtZero: true,
      },
    },
  };
  // Deep-ish merge for plugins/scales
  const merged = { ...base, ...extra };
  if (extra.plugins) merged.plugins = { ...base.plugins, ...extra.plugins };
  if (extra.scales) merged.scales = { ...base.scales, ...extra.scales };
  return merged;
}

// Money tooltip callback factory (used in many charts)
function moneyTooltip() {
  return { callbacks: { label: (c) => `${c.dataset.label || ''}: ${fmt.money(c.parsed.y ?? c.parsed)}` } };
}

// Linear gradient helper for charts (vertical, color top → translucent bottom)
function makeAreaGradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
  g.addColorStop(0, color + 'cc');
  g.addColorStop(1, color + '08');
  return g;
}

const fmt = {
  num: (n, d = 2) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  int: (n) => Number(n ?? 0).toLocaleString('en-US'),
  pct: (n) => `${(Number(n ?? 0) * 100).toFixed(1)}%`,
  bytes: (b) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let n = Number(b ?? 0);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(2)} ${u[i]}`;
  },
  dur: (s) => {
    s = Math.max(0, Math.round(Number(s ?? 0)));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  },
  money: (n) => `$${fmt.num(n, 2)}`,
};

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4000);
}

function destroyCharts() {
  for (const c of activeCharts) { try { c.destroy(); } catch {} }
  activeCharts = [];
}

function chart(parent, type, data, options = {}) {
  const wrap = el('div', { class: 'chart-wrap' });
  const canvas = el('canvas');
  wrap.append(canvas);
  parent.append(wrap);
  // eslint-disable-next-line no-undef
  const c = new Chart(canvas, { type, data, options: chartTheme(options) });
  activeCharts.push(c);
  return c;
}

// ============================================================================
// API
// ============================================================================
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Forward browser-side errors to the server terminal.
function reportToServer(payload) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: location.href, ...payload }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

window.addEventListener('error', (e) => {
  reportToServer({
    level: 'error',
    message: e.message || String(e.error),
    stack: e.error?.stack,
    source: e.filename,
    line: e.lineno,
    col: e.colno,
  });
  toast(`Runtime error: ${e.message || e.error}`, true);
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  reportToServer({
    level: 'error',
    message: `Unhandled promise rejection: ${reason?.message || reason}`,
    stack: reason?.stack,
  });
  toast(`Promise error: ${reason?.message || reason}`, true);
});

async function loadState() {
  const s = await api('/api/state');
  state = { config: s.config, data: s.data };
  ensureValidActiveOrg();
  render();
}

async function refreshAll() {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Refreshing…';
  try {
    const body = activeOrgId !== '__all__' ? { org_id: activeOrgId } : {};
    const s = await api('/api/refresh', { method: 'POST', body: JSON.stringify(body) });
    state = { config: s.config, data: s.data };
    if (s.errors?.length) {
      toast(`Refreshed with errors: ${s.errors.map(e => e.org_id).join(', ')}`, true);
      console.error('Refresh errors', s.errors);
    } else {
      toast('Data refreshed');
    }
    ensureValidActiveOrg();
    render();
  } catch (e) {
    toast(`Error: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  }
}

// ============================================================================
// Computations
// ============================================================================
function ratesFor(orgId) {
  const o = state.config.orgs.find(x => x.id === orgId);
  return o?.effective_rates || state.config.base_rates || FALLBACK_RATES;
}
function rates() { return state.config.base_rates || FALLBACK_RATES; }

function lastSnapshotForOrg(orgId) {
  return state.data.orgs[orgId]?.snapshots?.at(-1) || null;
}

function snapshotsForOrg(orgId) {
  return state.data.orgs[orgId]?.snapshots || [];
}

function invoicesForOrg(orgId) {
  return Object.fromEntries(
    Object.entries(state.data.orgs[orgId]?.invoices || {}).filter(([, v]) => v && typeof v === 'object')
  );
}

function snapshotCost(snap, orgId = null) {
  const r = orgId ? ratesFor(orgId) : (snap?.org_id ? ratesFor(snap.org_id) : rates());
  const cpuH = (snap.projects || []).reduce((a, p) => a + (p.cpu_used_sec || 0), 0) / 3600;
  const storageGB = (snap.projects || []).reduce((a, p) => a + (p.storage_bytes || 0), 0) / 1024 ** 3;
  return {
    compute: cpuH * r.COMPUTE_USD_PER_CU_HOUR,
    storage: storageGB * r.STORAGE_USD_PER_GB_MONTH,
    total: cpuH * r.COMPUTE_USD_PER_CU_HOUR + storageGB * r.STORAGE_USD_PER_GB_MONTH,
    cpuH, storageGB, rates: r,
  };
}

function ensureValidActiveOrg() {
  if (activeOrgId === '__all__') return;
  if (!state.config.orgs.some(o => o.id === activeOrgId)) {
    activeOrgId = '__all__';
    activeTab = 'overview';
  }
}

// ============================================================================
// Top-level layout
// ============================================================================
function render() {
  destroyCharts();
  // Warning logic: only hidden when we have BOTH a key and at least one org.
  // Tells the user exactly what's missing — no more silent "open Settings".
  const cfg = state.config || {};
  const hasKey = !!cfg.has_api_key;
  const orgCount = (cfg.orgs || []).length;
  const ok = hasKey && orgCount > 0;
  $('#config-warn').hidden = ok;
  if (!ok) {
    const missing = [];
    if (!hasKey) missing.push('API key');
    if (!orgCount) missing.push('at least one organization');
    const warnText = $('#config-warn-text');
    if (warnText) warnText.innerHTML = `Missing: <b>${missing.join(' and ')}</b>. Open <b>Settings</b> to add them.`;
  }
  try {
    renderOrgsNav();
    renderTabs();
    renderContent();
  } catch (err) {
    console.error('[render]', err);
    reportToServer({ level: 'error', message: `render failed: ${err.message}`, stack: err.stack });
    toast(`Render error: ${err.message}`, true);
    const main = $('#content');
    if (main) {
      main.innerHTML = '';
      main.append(el('div', { class: 'empty', style: { color: 'var(--bad)' } }, [
        `Render error: ${err.message}`,
        document.createElement('br'),
        el('span', { style: { fontSize: '11px' } }, 'Check the browser console and the server terminal for details.'),
      ]));
    }
  }
}

function renderOrgsNav() {
  const nav = $('#orgs-nav');
  nav.innerHTML = '';
  const allBtn = el('button', {
    class: `org-btn ${activeOrgId === '__all__' ? 'active' : ''}`,
    type: 'button',
    onclick: () => { activeOrgId = '__all__'; activeTab = 'overview'; render(); },
  }, ['★ All orgs']);
  nav.append(allBtn);

  for (const o of state.config.orgs) {
    nav.append(el('button', {
      class: `org-btn ${activeOrgId === o.id ? 'active' : ''}`,
      type: 'button',
      title: o.id,
      onclick: () => { activeOrgId = o.id; activeTab = 'overview'; render(); },
    }, [o.name || o.id]));
  }

  nav.append(el('button', {
    class: 'org-btn add', type: 'button',
    onclick: openSettings,
  }, ['+ Add org']));
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  const items = activeOrgId === '__all__'
    ? [['overview', 'Overview'], ['trend', 'Monthly trend']]
    : [['overview', 'Overview'], ['endpoints', 'Endpoints'], ['history', 'History'], ['invoices', 'Invoices']];
  if (!items.some(([id]) => id === activeTab)) activeTab = items[0][0];
  for (const [id, label] of items) {
    tabs.append(el('button', {
      class: `tab-btn ${activeTab === id ? 'active' : ''}`,
      type: 'button',
      onclick: () => { activeTab = id; render(); },
    }, [label]));
  }
}

function renderContent() {
  const main = $('#content');
  main.innerHTML = '';
  if (activeOrgId === '__all__') {
    if (activeTab === 'trend') return renderAllOrgsTrend(main);
    return renderAllOrgsOverview(main);
  }
  switch (activeTab) {
    case 'endpoints': return renderEndpoints(main);
    case 'history': return renderHistory(main);
    case 'invoices': return renderInvoices(main);
    default: return renderOrgOverview(main);
  }
}

function renderEmpty(parent, msg, ctaText, ctaFn) {
  const e = el('div', { class: 'empty' }, msg);
  if (ctaText) {
    e.append(document.createElement('br'));
    e.append(el('button', { type: 'button', style: { marginTop: '12px' }, onclick: ctaFn }, [ctaText]));
  }
  parent.append(e);
}

// ============================================================================
// Views: All Orgs
// ============================================================================
function aggregateAllOrgs() {
  const orgs = state.config.orgs.map(o => {
    const last = lastSnapshotForOrg(o.id);
    const cost = last ? snapshotCost(last, o.id) : null;
    return {
      id: o.id, name: o.name || o.id, plan: o.plan, managed_by: o.managed_by,
      snap: last,
      cost,
      projects: last?.projects.length || 0,
      effective_rates: o.effective_rates,
    };
  });
  // Combine months across orgs
  const months = new Set();
  for (const oid of Object.keys(state.data.orgs)) {
    for (const s of snapshotsForOrg(oid)) {
      if (s.billing_month) months.add(s.billing_month);
    }
  }
  const monthsList = [...months].sort();
  return { orgs, months: monthsList };
}

function renderAllOrgsOverview(parent) {
  if (!state.config.orgs.length) {
    return renderEmpty(parent, 'No organizations configured yet.', 'Open Settings', openSettings);
  }
  const agg = aggregateAllOrgs();
  const totalCost = agg.orgs.reduce((a, o) => a + (o.cost?.total || 0), 0);
  const totalCpuH = agg.orgs.reduce((a, o) => a + (o.cost?.cpuH || 0), 0);
  const totalStorageGB = agg.orgs.reduce((a, o) => a + (o.cost?.storageGB || 0), 0);
  const totalProjects = agg.orgs.reduce((a, o) => a + o.projects, 0);
  const orgsWithData = agg.orgs.filter(o => o.snap).length;

  parent.append(el('div', { class: 'stat-grid' }, [
    stat('Organizations', `${state.config.orgs.length}`, `${orgsWithData} with data`),
    stat('Projects (total)', totalProjects),
    stat('CPU hours', fmt.num(totalCpuH, 2), 'current month'),
    stat('Storage', fmt.num(totalStorageGB, 3) + ' GB'),
    stat('Estimated cost', fmt.money(totalCost), 'compute + storage', true),
  ]));

  const tableCard = el('div', { class: 'card' });
  tableCard.append(el('h2', {}, 'Organizations'));
  tableCard.append(el('div', { class: 'card-note' }, 'Click a row to drill into that organization. Numbers are for the current billing period.'));
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, [
    th('Organization'), th('Plan'), th('Projects', 'num'),
    th('CPU h', 'num'), th('Storage', 'num'),
    th('Compute $', 'num'), th('Storage $', 'num'), th('Total $', 'num'),
  ])));
  const tb = el('tbody');
  for (const o of agg.orgs.sort((a, b) => (b.cost?.total || 0) - (a.cost?.total || 0))) {
    tb.append(el('tr', {
      class: 'clickable',
      onclick: () => { activeOrgId = o.id; activeTab = 'overview'; render(); },
    }, [
      el('td', {}, [el('div', {}, o.name), el('div', { class: 'mono' }, o.id)]),
      el('td', {}, o.plan ? el('span', { class: 'badge plan' }, o.plan) : ''),
      el('td', { class: 'num' }, o.projects),
      el('td', { class: 'num' }, o.cost ? fmt.num(o.cost.cpuH, 2) : '—'),
      el('td', { class: 'num' }, o.cost ? fmt.num(o.cost.storageGB, 3) + ' GB' : '—'),
      el('td', { class: 'num' }, o.cost ? fmt.money(o.cost.compute) : '—'),
      el('td', { class: 'num' }, o.cost ? fmt.money(o.cost.storage) : '—'),
      el('td', { class: 'num' }, o.cost ? el('b', {}, fmt.money(o.cost.total)) : '—'),
    ]));
  }
  t.append(tb);
  tableCard.append(t);
  parent.append(tableCard);

  // Charts row
  const row = el('div', { class: 'row-2col' });
  const c1 = el('div', { class: 'card' });
  c1.append(el('h2', {}, 'Cost share — current month'));
  c1.append(el('div', { class: 'card-note' }, 'Estimated total per organization (compute + storage).'));
  const orgsWithCost = agg.orgs.filter(o => o.cost?.total > 0);
  if (orgsWithCost.length) {
    chart(c1, 'doughnut', {
      labels: orgsWithCost.map(o => o.name),
      datasets: [{
        data: orgsWithCost.map(o => o.cost.total),
        backgroundColor: orgsWithCost.map((_, i) => colorFor(i)),
        borderColor: '#fff',
        borderWidth: 3,
        hoverOffset: 12,
        hoverBorderWidth: 3,
      }],
    }, {
      cutout: '68%',
      scales: { x: { display: false }, y: { display: false } },
      plugins: {
        tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt.money(c.parsed)}` } },
        legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8, padding: 14, usePointStyle: true, pointStyle: 'circle' } },
      },
    });
  } else {
    c1.append(el('div', { class: 'empty' }, 'No data yet.'));
  }
  row.append(c1);

  const c2 = el('div', { class: 'card' });
  c2.append(el('h2', {}, 'Top projects by CPU hours'));
  c2.append(el('div', { class: 'card-note' }, 'Across all organizations, current month.'));
  const allProjs = [];
  for (const o of agg.orgs) {
    for (const p of (o.snap?.projects || [])) {
      allProjs.push({ name: `${p.name} · ${o.name}`, cpuH: p.cpu_used_sec / 3600 });
    }
  }
  allProjs.sort((a, b) => b.cpuH - a.cpuH);
  const top = allProjs.slice(0, 10).filter(p => p.cpuH > 0);
  if (top.length) {
    chart(c2, 'bar', {
      labels: top.map(p => p.name),
      datasets: [{
        label: 'CPU hours',
        data: top.map(p => p.cpuH),
        backgroundColor: top.map((_, i) => colorFor(i) + 'd9'),
        borderColor: top.map((_, i) => colorFor(i)),
        borderWidth: 1,
        borderRadius: 6,
        borderSkipped: false,
      }],
    }, {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmt.num(c.parsed.x, 2)} CU·h` } },
      },
      scales: {
        x: { grid: { color: 'rgba(15,23,42,0.05)' }, ticks: { font: { size: 11 } }, beginAtZero: true },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    });
  } else {
    c2.append(el('div', { class: 'empty' }, 'No data yet.'));
  }
  row.append(c2);
  parent.append(row);
}

function renderAllOrgsTrend(parent) {
  const agg = aggregateAllOrgs();
  if (!agg.months.length) {
    return renderEmpty(parent, 'No history yet — click Refresh to fetch the first snapshot.');
  }

  // Build monthly cost matrix: months × orgs
  const orgsList = state.config.orgs.filter(o => state.data.orgs[o.id]);
  const datasetsCost = orgsList.map((o, i) => {
    const data = agg.months.map(m => {
      const snap = snapshotsForOrg(o.id).find(s => s.billing_month === m);
      return snap ? snapshotCost(snap, o.id).total : 0;
    });
    return {
      label: o.name || o.id,
      data,
      backgroundColor: colorFor(i),
      borderRadius: 6,
      borderSkipped: false,
    };
  });

  const c1 = el('div', { class: 'card' });
  c1.append(el('h2', {}, 'Monthly estimated cost by organization'));
  c1.append(el('div', { class: 'card-note' }, 'Stacked. Snapshots are saved per billing month — refresh before the cycle close to capture each month.'));
  const wrap1 = el('div', { class: 'chart-wrap tall' });
  c1.append(wrap1);
  parent.append(c1);
  const canvas1 = el('canvas');
  wrap1.append(canvas1);
  // eslint-disable-next-line no-undef
  activeCharts.push(new Chart(canvas1, {
    type: 'bar',
    data: { labels: agg.months, datasets: datasetsCost },
    options: chartTheme({
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(15,23,42,0.05)' }, ticks: { callback: v => fmt.money(v), font: { size: 11 } } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${fmt.money(c.parsed.y)}`,
            footer: items => 'Total: ' + fmt.money(items.reduce((s, i) => s + i.parsed.y, 0)),
          },
        },
      },
    }),
  }));

  // CPU hours line chart with smooth gradient fill
  const c2 = el('div', { class: 'card' });
  c2.append(el('h2', {}, 'Monthly CPU hours by organization'));
  const wrap2 = el('div', { class: 'chart-wrap tall' });
  c2.append(wrap2);
  parent.append(c2);
  const canvas2 = el('canvas');
  wrap2.append(canvas2);
  const ctx2 = canvas2.getContext('2d');
  const datasetsCpu = orgsList.map((o, i) => ({
    label: o.name || o.id,
    data: agg.months.map(m => {
      const snap = snapshotsForOrg(o.id).find(s => s.billing_month === m);
      return snap ? snap.projects.reduce((a, p) => a + p.cpu_used_sec, 0) / 3600 : 0;
    }),
    borderColor: colorFor(i),
    backgroundColor: makeAreaGradient(ctx2, colorFor(i)),
    borderWidth: 2.5,
    tension: 0.4,
    fill: orgsList.length === 1,
    pointRadius: 3,
    pointBackgroundColor: '#fff',
    pointBorderColor: colorFor(i),
    pointBorderWidth: 2,
    pointHoverRadius: 6,
    pointHoverBorderWidth: 3,
  }));
  // eslint-disable-next-line no-undef
  activeCharts.push(new Chart(canvas2, {
    type: 'line',
    data: { labels: agg.months, datasets: datasetsCpu },
    options: chartTheme({
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(15,23,42,0.05)' }, ticks: { callback: v => `${v} h` } },
      },
      plugins: {
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt.num(c.parsed.y, 2)} h` } },
      },
    }),
  }));
}

// ============================================================================
// Views: Per-org
// ============================================================================
function stat(label, value, sub = '', accent = false) {
  return el('div', { class: 'stat' + (accent ? ' stat-accent' : '') }, [
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, value),
    sub ? el('div', { class: 'stat-sub' }, sub) : null,
  ]);
}
function th(text, cls = '') { return el('th', { class: cls }, text); }

function renderOrgOverview(parent) {
  const snap = lastSnapshotForOrg(activeOrgId);
  if (!snap) {
    return renderEmpty(parent, 'No snapshot for this organization yet.', '↻ Refresh', refreshAll);
  }
  const totalCpuS = snap.projects.reduce((a, p) => a + (p.cpu_used_sec || 0), 0);
  const totalActiveS = snap.projects.reduce((a, p) => a + (p.active_time_sec || 0), 0);
  const totalStorageB = snap.projects.reduce((a, p) => a + (p.storage_bytes || 0), 0);
  const cost = snapshotCost(snap, activeOrgId);
  const r = ratesFor(activeOrgId);
  parent.append(el('div', { class: 'stat-grid' }, [
    stat('Projects', snap.projects.length),
    stat('CPU hours', fmt.num(cost.cpuH, 2), `${fmt.int(totalCpuS)} cpu·s`),
    stat('Active time', fmt.dur(totalActiveS)),
    stat('Storage', fmt.bytes(totalStorageB)),
    stat('Compute $', fmt.money(cost.compute), `$${fmt.num(r.COMPUTE_USD_PER_CU_HOUR, 3)}/CU·h (${r._source})`),
    stat('Storage $', fmt.money(cost.storage), `$${fmt.num(r.STORAGE_USD_PER_GB_MONTH, 3)}/GB-month`),
    stat('Total $', fmt.money(cost.total), 'compute + storage', true),
  ]));

  // ---- Unified per-project chart: cost stacked + key metrics on hover ----
  const enriched = snap.projects.map(p => {
    const cpuH = p.cpu_used_sec / 3600;
    const stoGB = p.storage_bytes / 1024 ** 3;
    return {
      ...p,
      _cpuH: cpuH,
      _activeH: p.active_time_sec / 3600,
      _stoGB: stoGB,
      _compute: cpuH * r.COMPUTE_USD_PER_CU_HOUR,
      _storage: stoGB * r.STORAGE_USD_PER_GB_MONTH,
    };
  }).sort((a, b) => (b._compute + b._storage) - (a._compute + a._storage));

  const overviewCard = el('div', { class: 'card' });
  overviewCard.append(el('h2', {}, 'Cost & usage by project'));
  overviewCard.append(el('div', { class: 'card-note' }, 'Compute $ + storage $ per project (sorted by total). Hover a bar to see CPU hours, active time and storage. The per-project table below has the full numbers.'));
  const wrap = el('div', { class: 'chart-wrap', style: { height: `${Math.max(220, enriched.length * 36 + 80)}px` } });
  overviewCard.append(wrap);
  parent.append(overviewCard);
  const canvas = el('canvas');
  wrap.append(canvas);
  // eslint-disable-next-line no-undef
  activeCharts.push(new Chart(canvas, {
    type: 'bar',
    data: {
      labels: enriched.map(p => p.name),
      datasets: [
        {
          label: 'Compute $',
          data: enriched.map(p => p._compute),
          backgroundColor: '#6366f1d9',
          borderColor: '#6366f1',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
          stack: 'cost',
        },
        {
          label: 'Storage $',
          data: enriched.map(p => p._storage),
          backgroundColor: '#10b981d9',
          borderColor: '#10b981',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
          stack: 'cost',
        },
      ],
    },
    options: chartTheme({
      indexAxis: 'y',
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(15,23,42,0.05)' }, ticks: { callback: v => fmt.money(v) } },
        y: { stacked: true, grid: { display: false } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${fmt.money(c.parsed.x)}`,
            footer: items => {
              const p = enriched[items[0].dataIndex];
              return [
                `CPU: ${fmt.num(p._cpuH, 2)} h  ·  Active: ${fmt.num(p._activeH, 2)} h`,
                `Storage: ${fmt.bytes(p.storage_bytes)}`,
                `Total: ${fmt.money(p._compute + p._storage)}`,
              ].join('\n');
            },
          },
        },
      },
    }),
  }));

  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, 'Per project — current period'));
  card.append(el('div', { class: 'card-note' }, `Period: ${snap.period_start_at?.slice(0, 10) ?? '?'} → ${snap.period_reset_at?.slice(0, 10) ?? '?'} · captured ${new Date(snap.captured_at).toLocaleString('en-US')}`));
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, [
    th('Project'), th('Project ID'),
    th('CPU·s', 'num'), th('CPU h', 'num'), th('Active (h)', 'num'),
    th('Storage', 'num'), th('% CPU', 'num'),
  ])));
  const tb = el('tbody');
  const sorted = [...snap.projects].sort((a, b) => b.cpu_used_sec - a.cpu_used_sec);
  for (const p of sorted) {
    tb.append(el('tr', {}, [
      el('td', {}, p.name),
      el('td', { class: 'mono' }, p.project_id),
      el('td', { class: 'num' }, fmt.int(p.cpu_used_sec)),
      el('td', { class: 'num' }, fmt.num(p.cpu_used_sec / 3600, 2)),
      el('td', { class: 'num' }, fmt.num(p.active_time_sec / 3600, 2)),
      el('td', { class: 'num' }, fmt.bytes(p.storage_bytes)),
      el('td', { class: 'num' }, totalCpuS ? fmt.pct(p.cpu_used_sec / totalCpuS) : '—'),
    ]));
  }
  t.append(tb);
  card.append(t);
  parent.append(card);
}

function renderEndpoints(parent) {
  const snap = lastSnapshotForOrg(activeOrgId);
  if (!snap) return renderEmpty(parent, 'No snapshot yet.');
  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, 'Per-endpoint breakdown'));
  card.append(el('div', { class: 'card-note' }, 'Uptime computed from /operations · for endpoints active without recent events, the period\'s full uptime is assumed (see "Source"). CU·h min = uptime × min CU.'));
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, [
    th('Project'), th('Branch'), th('Endpoint'), th('State'),
    th('min CU', 'num'), th('max CU', 'num'),
    th('Suspend', 'num'), th('Uptime (h)', 'num'),
    th('Source'),
    th('CU·h min', 'num'), th('CU·h max', 'num'), th(`$ approx`, 'num'),
  ])));
  const rows = [];
  for (const p of snap.projects)
    for (const ep of (p.endpoints || []))
      rows.push({ pname: p.name, ...ep });
  rows.sort((a, b) => b.cu_h_at_min - a.cu_h_at_min);

  const tb = el('tbody');
  for (const r of rows) {
    const stCls = r.current_state === 'active' ? 'active' : 'idle';
    tb.append(el('tr', {}, [
      el('td', {}, r.pname),
      el('td', {}, r.branch_name),
      el('td', { class: 'mono' }, r.endpoint_id),
      el('td', {}, el('span', { class: `badge ${stCls}` }, r.current_state || '?')),
      el('td', { class: 'num' }, fmt.num(r.min_cu, 2)),
      el('td', { class: 'num' }, fmt.num(r.max_cu, 2)),
      el('td', { class: 'num' }, r.suspend_timeout_seconds == null ? '?' : (r.suspend_timeout_seconds === 0 ? 'default' : `${r.suspend_timeout_seconds}s`)),
      el('td', { class: 'num' }, fmt.num((r.uptime_sec || 0) / 3600, 2)),
      el('td', { class: 'mono' }, r.uptime_source || ''),
      el('td', { class: 'num' }, fmt.num(r.cu_h_at_min, 3)),
      el('td', { class: 'num' }, fmt.num(r.cu_h_at_max, 3)),
      el('td', { class: 'num' }, fmt.money(r.cu_h_at_min * ratesFor(activeOrgId).COMPUTE_USD_PER_CU_HOUR)),
    ]));
  }
  t.append(tb);
  card.append(t);
  parent.append(card);
}

function renderHistory(parent) {
  const snaps = snapshotsForOrg(activeOrgId);
  const invs = invoicesForOrg(activeOrgId);
  if (!snaps.length && !Object.keys(invs).length) {
    return renderEmpty(parent, 'No history yet — click Refresh to capture the first snapshot.');
  }
  const months = [...new Set([...snaps.map(s => s.billing_month).filter(Boolean), ...Object.keys(invs)])].sort();

  // Chart 1: estimated cost vs invoice total per month
  const card1 = el('div', { class: 'card' });
  card1.append(el('h2', {}, 'Estimated vs invoice — monthly'));
  card1.append(el('div', { class: 'card-note' }, 'Compute + storage estimated from API snapshots, vs the real total from invoices stored under Invoices tab.'));
  const wrap1 = el('div', { class: 'chart-wrap' });
  card1.append(wrap1);
  parent.append(card1);
  const c1 = el('canvas');
  wrap1.append(c1);
  const estimated = months.map(m => {
    const snap = snaps.find(s => s.billing_month === m);
    return snap ? snapshotCost(snap, activeOrgId).total : 0;
  });
  const invoiced = months.map(m => Number(invs[m]?.total || 0));
  // eslint-disable-next-line no-undef
  activeCharts.push(new Chart(c1, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
          label: 'Estimated (API)',
          data: estimated,
          backgroundColor: '#6366f1d9',
          borderColor: '#6366f1',
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: 'Invoice (real)',
          data: invoiced,
          backgroundColor: '#10b981d9',
          borderColor: '#10b981',
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    },
    options: chartTheme({
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(15,23,42,0.05)' }, ticks: { callback: v => fmt.money(v) } },
      },
      plugins: {
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt.money(c.parsed.y)}` } },
      },
    }),
  }));

  // Chart 2: per-project CPU hours stacked over time
  const card2 = el('div', { class: 'card' });
  card2.append(el('h2', {}, 'Monthly CPU hours by project'));
  const wrap2 = el('div', { class: 'chart-wrap tall' });
  card2.append(wrap2);
  parent.append(card2);
  const c2 = el('canvas');
  wrap2.append(c2);
  // Build dataset per project across all months — grouped (one bar per project per month)
  const projectNames = [...new Set(snaps.flatMap(s => s.projects.map(p => p.name)))];
  const datasets = projectNames.map((pname, i) => ({
    label: pname,
    data: snaps.map(s => {
      const p = s.projects.find(x => x.name === pname);
      return p ? p.cpu_used_sec / 3600 : 0;
    }),
    backgroundColor: colorFor(i) + 'd9',
    borderColor: colorFor(i),
    borderWidth: 1,
    borderRadius: 5,
    borderSkipped: false,
  }));
  // eslint-disable-next-line no-undef
  activeCharts.push(new Chart(c2, {
    type: 'bar',
    data: { labels: snaps.map(s => s.billing_month), datasets },
    options: chartTheme({
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(15,23,42,0.05)' }, ticks: { callback: v => `${v} h` } },
      },
      plugins: {
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt.num(c.parsed.y, 2)} h` } },
      },
    }),
  }));

  // Table: monthly summary
  const card3 = el('div', { class: 'card' });
  card3.append(el('h2', {}, 'Monthly summary'));
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, [
    th('Month'), th('Projects', 'num'), th('CPU h', 'num'),
    th('Storage', 'num'), th('Compute $', 'num'), th('Storage $', 'num'),
    th('Estimated $', 'num'), th('Invoice $', 'num'), th('Δ', 'num'), th('Captured'),
  ])));
  const tb = el('tbody');
  for (const m of months) {
    const snap = snaps.find(s => s.billing_month === m);
    const inv = invs[m];
    const cost = snap ? snapshotCost(snap, activeOrgId) : null;
    const estTotal = cost?.total ?? 0;
    const invTotal = Number(inv?.total ?? 0);
    const diff = invTotal - estTotal;
    tb.append(el('tr', {}, [
      el('td', {}, m),
      el('td', { class: 'num' }, snap?.projects.length ?? '—'),
      el('td', { class: 'num' }, snap ? fmt.num(cost.cpuH, 2) : '—'),
      el('td', { class: 'num' }, snap ? fmt.num(cost.storageGB, 3) + ' GB' : '—'),
      el('td', { class: 'num' }, snap ? fmt.money(cost.compute) : '—'),
      el('td', { class: 'num' }, snap ? fmt.money(cost.storage) : '—'),
      el('td', { class: 'num' }, snap ? el('b', {}, fmt.money(estTotal)) : '—'),
      el('td', { class: 'num' }, inv ? el('b', {}, fmt.money(invTotal)) : '—'),
      el('td', { class: 'num', style: { color: diff > 0 ? 'var(--bad)' : (diff < 0 ? 'var(--good)' : 'inherit') } },
        snap && inv ? (diff >= 0 ? '+' : '') + fmt.money(diff) : '—'),
      el('td', { class: 'mono' }, snap ? new Date(snap.captured_at).toLocaleDateString('en-US') : '—'),
    ]));
  }
  t.append(tb);
  card3.append(t);
  parent.append(card3);
}

function renderInvoices(parent) {
  const invs = invoicesForOrg(activeOrgId);
  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, 'Add or update an invoice'));
  card.append(el('div', { class: 'card-note' }, 'Paste the line items from your real Vercel/Neon invoice. Stored locally, never sent anywhere.'));
  const form = el('form', { class: 'invoice-form', onsubmit: onInvoiceSubmit });
  const fields = [
    ['month', 'Month (YYYY-MM)', 'text', '2026-04', true],
    ['compute_cu_h', 'Compute CU·h', 'number', '', false],
    ['compute_cost', 'Compute $', 'number', '', false],
    ['storage_root_gb', 'Storage root GB-month', 'number', '', false],
    ['storage_root_cost', 'Storage root $', 'number', '', false],
    ['storage_child_gb', 'Storage child GB-month', 'number', '', false],
    ['storage_child_cost', 'Storage child $', 'number', '', false],
    ['instant_restore_gb', 'Instant restore GB-month', 'number', '', false],
    ['instant_restore_cost', 'Instant restore $', 'number', '', false],
    ['network_gb', 'Network egress GB', 'number', '', false],
    ['network_cost', 'Network $', 'number', '', false],
    ['total', 'TOTAL $', 'number', '', true],
  ];
  for (const [name, label, type, ph, req] of fields) {
    form.append(el('label', {}, [
      label,
      el('input', { name, type, step: type === 'number' ? '0.001' : null, placeholder: ph, required: req }),
    ]));
  }
  form.append(el('div', { class: 'full' }, el('button', { type: 'submit' }, 'Save invoice')));
  card.append(form);
  parent.append(card);

  const list = el('div', { class: 'card' });
  list.append(el('h2', {}, 'Saved invoices'));
  const months = Object.keys(invs).sort();
  if (!months.length) {
    list.append(el('div', { class: 'empty' }, 'No invoices saved yet.'));
  } else {
    const t = el('table');
    t.append(el('thead', {}, el('tr', {}, [
      th('Month'), th('Compute', 'num'), th('Storage root', 'num'), th('Storage child', 'num'),
      th('Instant restore', 'num'), th('Network', 'num'), th('TOTAL', 'num'), th(''),
    ])));
    const tb = el('tbody');
    for (const m of months) {
      const inv = invs[m];
      tb.append(el('tr', {}, [
        el('td', {}, m),
        el('td', { class: 'num' }, fmt.money(inv.compute_cost || 0)),
        el('td', { class: 'num' }, fmt.money(inv.storage_root_cost || 0)),
        el('td', { class: 'num' }, fmt.money(inv.storage_child_cost || 0)),
        el('td', { class: 'num' }, fmt.money(inv.instant_restore_cost || 0)),
        el('td', { class: 'num' }, fmt.money(inv.network_cost || 0)),
        el('td', { class: 'num' }, el('b', {}, fmt.money(inv.total || 0))),
        el('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, [
          el('button', {
            class: 'secondary', type: 'button',
            title: 'Use this invoice to calibrate the org\'s rates',
            style: { padding: '4px 8px', fontSize: '11px', marginRight: '4px' },
            onclick: () => calibrateOrg(activeOrgId, m),
          }, 'Calibrate'),
          el('button', {
            class: 'danger', type: 'button',
            onclick: () => deleteInvoice(m),
          }, '×'),
        ]),
      ]));
    }
    t.append(tb);
    list.append(t);
  }
  parent.append(list);
}

async function onInvoiceSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const month = String(fd.get('month') || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return toast('Invalid month format (must be YYYY-MM)', true);
  const data = {};
  for (const [k, v] of fd.entries()) {
    if (k === 'month' || v === '' || v == null) continue;
    data[k] = Number(v);
  }
  try {
    const resp = await api('/api/invoice', { method: 'POST', body: JSON.stringify({ org_id: activeOrgId, month, data }) });
    state.data = resp.data;
    toast(`Invoice ${month} saved`);
    e.target.reset();
    render();
  } catch (err) { toast(err.message, true); }
}

async function deleteInvoice(month) {
  if (!confirm(`Delete invoice ${month}?`)) return;
  try {
    const resp = await api(`/api/invoice/${activeOrgId}/${month}`, { method: 'DELETE' });
    state.data = resp.data;
    toast(`Invoice ${month} deleted`);
    render();
  } catch (err) { toast(err.message, true); }
}

// ============================================================================
// Settings modal
// ============================================================================
function openSettings() {
  $('#modal').classList.remove('hidden');
  $('#api-key-input').value = '';
  renderSettings();
}
function closeSettings() {
  $('#modal').classList.add('hidden');
}

function renderSettings() {
  // API key status
  $('#api-key-status').innerHTML = state.config.has_api_key
    ? `Currently set: <code>${state.config.api_key_masked}</code>. Paste a new key and click Save to replace.`
    : 'No API key set. Get one at <code>console.neon.tech</code> → avatar → Account settings → API keys.';

  // Orgs list — each org shows its detected rates and calibration controls
  const list = $('#orgs-list');
  list.innerHTML = '';
  if (!state.config.orgs.length) {
    list.append(el('div', { class: 'helper' }, 'No organizations added yet.'));
  } else {
    for (const o of state.config.orgs) {
      const r = o.effective_rates || {};
      const invMonths = Object.keys(invoicesForOrg(o.id)).sort();
      const planLabel = [o.plan, o.managed_by ? `via ${o.managed_by}` : null].filter(Boolean).join(' · ');
      const sourceLabel = r._source === 'custom'
        ? 'rates: custom (calibrated)'
        : (r._source ? `rates: ${r._source}` : 'rates: defaults');
      const calibSelect = el('select', { id: `calib-month-${o.id}` },
        invMonths.length
          ? invMonths.map(m => el('option', { value: m }, m))
          : [el('option', { value: '', disabled: true, selected: true }, 'no invoices saved')]);
      const ratesGrid = el('div', { class: 'rates-mini', style: { fontSize: '11px', color: 'var(--muted-strong)', marginTop: '6px' } },
        [
          `compute: $${fmt.num(r.COMPUTE_USD_PER_CU_HOUR ?? 0, 3)}/CU·h`,
          `storage: $${fmt.num(r.STORAGE_USD_PER_GB_MONTH ?? 0, 3)}/GB-mo`,
          `network: $${fmt.num(r.NETWORK_USD_PER_GB ?? 0, 3)}/GB`,
          `instant restore: $${fmt.num(r.INSTANT_RESTORE_USD_PER_GB_MONTH ?? 0, 3)}/GB-mo`,
        ].map(s => el('span', { style: { marginRight: '12px' } }, s)));

      list.append(el('div', { class: 'org-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: '6px' } }, [
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
          el('div', { class: 'info' }, [
            el('div', { class: 'name' }, o.name || '(unnamed)'),
            el('div', { class: 'id' }, o.id + (planLabel ? ` · ${planLabel}` : '')),
          ]),
          el('button', { class: 'danger', type: 'button', onclick: () => removeOrg(o.id) }, ['Remove']),
        ]),
        ratesGrid,
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } }, [
          el('span', { style: { fontSize: '11px', color: 'var(--muted)' } }, sourceLabel),
          el('div', { style: { flex: 1 } }),
          el('span', { style: { fontSize: '12px', color: 'var(--muted)' } }, 'Calibrate from:'),
          calibSelect,
          el('button', {
            class: 'secondary',
            type: 'button',
            disabled: !invMonths.length,
            onclick: () => calibrateOrg(o.id, $(`#calib-month-${o.id}`).value),
          }, ['Calibrate']),
          r._source === 'custom'
            ? el('button', { class: 'ghost', type: 'button', onclick: () => resetOrgRates(o.id) }, ['Reset'])
            : null,
        ]),
      ]));
    }
  }
}

async function saveApiKey() {
  const v = $('#api-key-input').value.trim();
  if (!v) return toast('Paste an API key first', true);
  try {
    const resp = await api('/api/config', { method: 'PATCH', body: JSON.stringify({ api_key: v }) });
    state.config = resp.config;
    toast('API key saved');
    $('#api-key-input').value = '';
    renderSettings();
    render();
  } catch (e) { toast(e.message, true); }
}

async function addOrg() {
  const id = $('#org-id-input').value.trim();
  if (!id) return toast('Paste an org id', true);
  try {
    const resp = await api('/api/orgs', { method: 'POST', body: JSON.stringify({ id }) });
    state.config = resp.config;
    toast(`Org ${id} added`);
    $('#org-id-input').value = '';
    renderSettings();
    render();
  } catch (e) { toast(e.message, true); }
}

async function removeOrg(id) {
  if (!confirm(`Remove org ${id}? (Local snapshot history is kept; click "Purge data" twice if you want to delete it.)`)) return;
  try {
    const resp = await api(`/api/orgs/${id}`, { method: 'DELETE' });
    state.config = resp.config;
    toast(`Org ${id} removed`);
    if (activeOrgId === id) { activeOrgId = '__all__'; activeTab = 'overview'; }
    renderSettings();
    render();
  } catch (e) { toast(e.message, true); }
}

async function calibrateOrg(orgId, month) {
  if (!month) return toast('Save an invoice for this org first (Invoices tab)', true);
  try {
    const resp = await api(`/api/orgs/${orgId}/calibrate`, { method: 'POST', body: JSON.stringify({ month }) });
    state.config = resp.config;
    const applied = Object.entries(resp.applied || {}).map(([k, v]) => `${k.replace(/_USD.*/, '')}=$${v}`).join(', ');
    toast(`Calibrated from ${month}: ${applied}`);
    renderSettings();
    render();
  } catch (e) { toast(e.message, true); }
}

async function resetOrgRates(orgId) {
  if (!confirm('Reset to plan/provider auto rates?')) return;
  try {
    const resp = await api(`/api/orgs/${orgId}/rates`, { method: 'DELETE' });
    state.config = resp.config;
    toast('Rates reset to auto');
    renderSettings();
    render();
  } catch (e) { toast(e.message, true); }
}

// ============================================================================
// Init
// ============================================================================
$('#refresh').addEventListener('click', refreshAll);
$('#settings-btn').addEventListener('click', openSettings);
$('#open-settings-from-warn').addEventListener('click', openSettings);
$('#close-modal').addEventListener('click', closeSettings);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeSettings(); });
$('#save-api-key').addEventListener('click', saveApiKey);
$('#add-org').addEventListener('click', addOrg);
$('#org-id-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOrg(); });
$('#api-key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiKey(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

applyChartDefaults();
loadState().catch(e => toast(`Loading error: ${e.message}. Restart the dev server.`, true));
