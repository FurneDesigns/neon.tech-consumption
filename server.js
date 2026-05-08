import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_PATH = path.join(__dirname, 'data.json');
const LEGACY_HIST = path.join(__dirname, 'history.json');
const LEGACY_INV = path.join(__dirname, 'invoices.json');
const NEON_API = 'https://console.neon.tech/api/v2';

// ============================================================================
// Built-in rate tables.
// Neon does NOT expose pricing via API, so these are derived from public
// pricing (neon.tech/pricing) plus calibrated overrides for known providers.
// Each org's "effective rates" merge: BASE_RATES → PLAN_RATES[plan] →
// PROVIDER_OVERRIDES[managed_by][plan] → user override.
// ============================================================================
const BASE_RATES = {
  CURRENCY: '$',
  COMPUTE_USD_PER_CU_HOUR: 0.16,
  STORAGE_USD_PER_GB_MONTH: 0.35,
  INSTANT_RESTORE_USD_PER_GB_MONTH: 0.20,
  NETWORK_USD_PER_GB: 0.10,
  INCLUDED_NETWORK_GB_PER_PROJECT: 100,
};

const PLAN_RATES = {
  free: {
    COMPUTE_USD_PER_CU_HOUR: 0,
    STORAGE_USD_PER_GB_MONTH: 0,
    INSTANT_RESTORE_USD_PER_GB_MONTH: 0,
    NETWORK_USD_PER_GB: 0,
    INCLUDED_NETWORK_GB_PER_PROJECT: 5,
  },
  launch: {
    COMPUTE_USD_PER_CU_HOUR: 0.16,
    STORAGE_USD_PER_GB_MONTH: 0.35,
    INSTANT_RESTORE_USD_PER_GB_MONTH: 0.20,
    NETWORK_USD_PER_GB: 0.10,
    INCLUDED_NETWORK_GB_PER_PROJECT: 100,
  },
  scale: {
    COMPUTE_USD_PER_CU_HOUR: 0.16,
    STORAGE_USD_PER_GB_MONTH: 0.35,
    INSTANT_RESTORE_USD_PER_GB_MONTH: 0.20,
    NETWORK_USD_PER_GB: 0.10,
    INCLUDED_NETWORK_GB_PER_PROJECT: 250,
  },
  business: {
    COMPUTE_USD_PER_CU_HOUR: 0.16,
    STORAGE_USD_PER_GB_MONTH: 0.50,
    INSTANT_RESTORE_USD_PER_GB_MONTH: 0.20,
    NETWORK_USD_PER_GB: 0.10,
    INCLUDED_NETWORK_GB_PER_PROJECT: 500,
  },
};

// Provider-specific overrides (Vercel-managed Neon orgs are billed via Vercel
// at different rates than direct Neon). Calibrated from a real invoice.
const PROVIDER_OVERRIDES = {
  vercel: {
    launch: {
      COMPUTE_USD_PER_CU_HOUR: 0.106,
      STORAGE_USD_PER_GB_MONTH: 0.358,
      INSTANT_RESTORE_USD_PER_GB_MONTH: 0.20,
      NETWORK_USD_PER_GB: 0.066,
      INCLUDED_NETWORK_GB_PER_PROJECT: 100,
    },
  },
};

function effectiveRates(org) {
  const plan = (org?.plan || '').toLowerCase();
  const provider = (org?.managed_by || '').toLowerCase();
  const planRates = PLAN_RATES[plan] || {};
  const providerOverride = PROVIDER_OVERRIDES[provider]?.[plan] || {};
  const userOverride = org?.rates_override || {};
  const effective = {
    ...BASE_RATES,
    ...planRates,
    ...providerOverride,
    ...userOverride,
  };
  // Source label for UI transparency
  let source = 'defaults';
  if (Object.keys(planRates).length) source = `plan:${plan}`;
  if (Object.keys(providerOverride).length) source = `${provider}:${plan}`;
  if (Object.keys(userOverride).length) source = 'custom';
  return { ...effective, _source: source, _plan: plan, _provider: provider };
}

const DEFAULT_RATES = { ...BASE_RATES };

// ============================================================================
// File I/O helpers
// ============================================================================
async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); }
  catch { return fallback; }
}
async function writeJson(p, data) {
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n');
}

// ============================================================================
// Config (api_key, orgs, rates)
// ============================================================================
async function loadConfig() {
  const c = await readJson(CONFIG_PATH, null);
  if (c) {
    // config.json exists — it's the source of truth. The .env can only fill
    // a MISSING api_key (e.g. user wiped config.json by mistake) but never
    // overrides the orgs list — otherwise deleting an org via the UI would
    // resurrect it from .env on the next request.
    return {
      api_key: c.api_key || process.env.NEON_API_KEY || '',
      orgs: Array.isArray(c.orgs) ? c.orgs : [],
    };
  }
  // No config.json yet — bootstrap from .env on first run.
  const orgs = process.env.ORG_ID
    ? process.env.ORG_ID.split(',').map(id => ({ id: id.trim(), name: '' })).filter(o => o.id)
    : [];
  return {
    api_key: process.env.NEON_API_KEY || '',
    orgs,
  };
}

async function saveConfig(config) {
  await writeJson(CONFIG_PATH, config);
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return '***';
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

function publicConfig(c) {
  return {
    has_api_key: !!c.api_key,
    api_key_masked: maskKey(c.api_key),
    orgs: c.orgs.map(o => ({ ...o, effective_rates: effectiveRates(o) })),
    base_rates: { ...BASE_RATES },
  };
}

// ============================================================================
// Data (snapshots + invoices, scoped per org)
// ============================================================================
async function loadData() {
  const d = await readJson(DATA_PATH, null);
  if (d?.orgs) return d;
  return { orgs: {} };
}

async function saveData(d) { await writeJson(DATA_PATH, d); }

function ensureOrgBucket(data, orgId) {
  data.orgs[orgId] ||= { snapshots: [], invoices: {} };
  return data.orgs[orgId];
}

async function migrateLegacyIfNeeded(config, data) {
  if (Object.keys(data.orgs).length > 0) return data;
  const legacyHist = await readJson(LEGACY_HIST, null);
  const legacyInv = await readJson(LEGACY_INV, null);
  if (!legacyHist?.snapshots?.length && !legacyInv) return data;
  const targetOrgId = config.orgs[0]?.id;
  if (!targetOrgId) return data;
  const bucket = ensureOrgBucket(data, targetOrgId);
  if (legacyHist?.snapshots) bucket.snapshots = legacyHist.snapshots;
  if (legacyInv) {
    bucket.invoices = Object.fromEntries(
      Object.entries(legacyInv).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object')
    );
  }
  await saveData(data);
  return data;
}

// ============================================================================
// Neon API client
// ============================================================================
async function neonGet(reqPath, params, apiKey) {
  if (!apiKey) throw new Error('Missing API key');
  const url = new URL(NEON_API + reqPath);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Neon API ${r.status} on ${reqPath}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// Pulls account-level monthly consumption history (one entry per billing
// period). Used to back-fill estimated invoices for months we never captured.
async function listConsumptionAccount(orgId, fromIso, toIso, apiKey) {
  const data = await neonGet('/consumption_history/account', {
    from: fromIso, to: toIso, granularity: 'monthly', org_id: orgId,
  }, apiKey);
  return data.periods || [];
}

// First-of-each-UTC-month boundaries between two ISO dates, oldest first.
function monthlyBoundariesAsc(fromIso, toIso) {
  const start = new Date(fromIso);
  const end = new Date(toIso);
  const out = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur < end) {
    out.push(cur.toISOString());
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

// The /consumption_history endpoints reject `from` dates outside both the
// global lower bound (2024-03-01) AND this specific org's data window (406
// "outside the boundaries"). On top of that, the endpoint is plan-gated and
// returns 403 only once `from` lands inside the data window. So we probe
// month-by-month forward and report the first definitive verdict we see.
async function probeAccountHistory(orgId, fromIso, toIso, apiKey) {
  const candidates = monthlyBoundariesAsc(fromIso, toIso);
  let sawBoundary = false;
  for (const from of candidates) {
    try {
      const periods = await listConsumptionAccount(orgId, from, toIso, apiKey);
      return { kind: 'ok', from, periods };
    } catch (e) {
      if (/Scale plans and above/i.test(e.message)) return { kind: 'plan_required', error: e };
      if (/outside the boundaries/i.test(e.message)) { sawBoundary = true; continue; }
      // Unknown error — bubble up rather than silently swallowing.
      throw e;
    }
  }
  return { kind: sawBoundary ? 'no_data' : 'unknown' };
}

// Per-project monthly consumption (paginated).
async function listConsumptionProjects(orgId, fromIso, toIso, apiKey) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const params = { from: fromIso, to: toIso, granularity: 'monthly', org_id: orgId, limit: 100 };
    if (cursor) params.cursor = cursor;
    const data = await neonGet('/consumption_history/projects', params, apiKey);
    out.push(...(data.projects || []));
    cursor = data.pagination?.cursor;
    if (!cursor) break;
  }
  return out;
}

function monthFromIsoUtc(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Convert one ConsumptionHistoryPerTimeframe (v1) to billable units.
// data_storage_bytes_hour is bytes·hour; dividing by hours yields the
// time-weighted average bytes, which is what $/GB-month bills against.
function timeframeToUnits(tf) {
  const cpuH = (Number(tf.compute_time_seconds) || 0) / 3600;
  const start = new Date(tf.timeframe_start);
  const end = new Date(tf.timeframe_end);
  const hours = Math.max(1, (end - start) / 3600000);
  const avgStorageBytes = (Number(tf.data_storage_bytes_hour) || 0) / hours;
  return {
    cpuH,
    activeSec: Number(tf.active_time_seconds) || 0,
    cpuSec: Number(tf.compute_time_seconds) || 0,
    avgStorageBytes,
    avgStorageGB: avgStorageBytes / 1024 ** 3,
    hours,
  };
}

async function listOperations(projectId, sinceDate, apiKey) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 60; i++) {
    const params = { limit: 200 };
    if (cursor) params.cursor = cursor;
    const data = await neonGet(`/projects/${projectId}/operations`, params, apiKey);
    const ops = data.operations || [];
    if (!ops.length) break;
    let outOfWindow = false;
    for (const op of ops) {
      const ts = new Date(op.created_at);
      if (ts >= sinceDate) out.push(op);
      else outOfWindow = true;
    }
    if (outOfWindow) break;
    cursor = data.pagination?.cursor;
    if (!cursor) break;
  }
  return out;
}

function endpointUptime(operations, periodStart, now) {
  const byEp = {};
  for (const op of operations) {
    if (!['start_compute', 'suspend_compute'].includes(op.action)) continue;
    if (!op.endpoint_id) continue;
    (byEp[op.endpoint_id] ||= []).push([op.action, new Date(op.created_at)]);
  }
  const uptime = {};
  for (const [epId, evtsRaw] of Object.entries(byEp)) {
    const evts = evtsRaw.slice().sort((a, b) => a[1] - b[1]);
    const n = evts.length;
    let total = 0;
    let i0 = 0;
    if (evts[0][0] === 'suspend_compute') {
      total += (evts[0][1] - periodStart) / 1000;
      i0 = 1;
    }
    let startTs = null;
    for (let i = i0; i < evts.length; i++) {
      const [action, ts] = evts[i];
      if (action === 'start_compute') startTs = ts;
      else if (action === 'suspend_compute' && startTs) {
        total += (ts - startTs) / 1000;
        startTs = null;
      }
    }
    if (startTs) total += (now - startTs) / 1000;
    uptime[epId] = { sec: Math.max(0, total), n };
  }
  return uptime;
}

async function fetchOrgSnapshot(orgId, apiKey) {
  const org = await neonGet(`/organizations/${orgId}`, null, apiKey);
  const projsResp = await neonGet('/projects', { org_id: orgId, limit: 100 }, apiKey);
  const projs = projsResp.projects || [];

  const periodReset = projs[0]?.quota_reset_at;
  let periodStart = null;
  let billingMonth = '';
  if (periodReset) {
    const reset = new Date(periodReset);
    const prev = new Date(reset.getTime() - 86400 * 1000);
    periodStart = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), 1));
    billingMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const now = new Date();

  const projects = [];
  for (const p of projs) {
    const [endpoints, branches] = await Promise.all([
      neonGet(`/projects/${p.id}/endpoints`, null, apiKey).then(r => r.endpoints || []).catch(() => []),
      neonGet(`/projects/${p.id}/branches`, null, apiKey).then(r => r.branches || []).catch(() => []),
    ]);
    const branchNames = Object.fromEntries(branches.map(b => [b.id, b.name]));

    let epUptime = {};
    if (periodStart) {
      try {
        const ops = await listOperations(p.id, periodStart, apiKey);
        epUptime = endpointUptime(ops, periodStart, now);
      } catch (e) {
        console.warn(`[ops] ${p.name}: ${e.message}`);
      }
    }
    const periodSec = periodStart ? (now - periodStart) / 1000 : 0;
    const epRows = endpoints.map(ep => {
      let { sec: upSec, n: nEvts } = epUptime[ep.id] || { sec: 0, n: 0 };
      const mn = ep.autoscaling_limit_min_cu || 0.25;
      const mx = ep.autoscaling_limit_max_cu || mn;
      let source;
      if (nEvts === 0 && ep.current_state === 'active' && periodSec > 0) {
        upSec = periodSec;
        source = 'assumed (active, no events)';
      } else if (nEvts === 0) {
        source = 'no events (idle)';
      } else {
        source = `${nEvts} events`;
      }
      return {
        endpoint_id: ep.id,
        branch_name: branchNames[ep.branch_id] || ep.branch_id || '',
        current_state: ep.current_state,
        min_cu: mn, max_cu: mx,
        suspend_timeout_seconds: ep.suspend_timeout_seconds,
        uptime_sec: upSec, uptime_source: source,
        cu_h_at_min: (upSec * mn) / 3600,
        cu_h_at_max: (upSec * mx) / 3600,
      };
    });
    projects.push({
      project_id: p.id, name: p.name,
      cpu_used_sec: p.cpu_used_sec || 0,
      active_time_sec: p.active_time || 0,
      storage_bytes: p.synthetic_storage_size || 0,
      quota_reset_at: p.quota_reset_at,
      endpoints: epRows,
    });
  }

  return {
    captured_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    period_reset_at: periodReset,
    period_start_at: periodStart?.toISOString() ?? null,
    billing_month: billingMonth,
    org_id: orgId,
    org_name: org.name,
    org_plan: org.plan,
    org_managed_by: org.managed_by,
    projects,
  };
}

function mergeSnapshot(bucket, snap) {
  bucket.snapshots = (bucket.snapshots || []).filter(s => s.billing_month !== snap.billing_month);
  bucket.snapshots.push(snap);
  bucket.snapshots.sort((a, b) => (a.billing_month || '').localeCompare(b.billing_month || ''));
}

// ============================================================================
// HTTP
// ============================================================================
const app = express();
app.use(express.json({ limit: '1mb' }));
// Disable caching for the dashboard's static files — local-only tool, and we
// want users to never serve stale UI after a server upgrade.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, cacheControl: false,
}));

app.get('/api/state', async (_req, res) => {
  try {
    const config = await loadConfig();
    let data = await loadData();
    data = await migrateLegacyIfNeeded(config, data);
    res.json({ config: publicConfig(config), data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/config', async (req, res) => {
  try {
    const config = await loadConfig();
    const { api_key } = req.body || {};
    if (typeof api_key === 'string' && api_key && !api_key.includes('…')) {
      config.api_key = api_key.trim();
    }
    await saveConfig(config);
    res.json({ config: publicConfig(config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orgs', async (req, res) => {
  try {
    const config = await loadConfig();
    const id = (req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing org id' });
    if (config.orgs.some(o => o.id === id)) {
      return res.status(409).json({ error: 'Org already added' });
    }
    if (!config.api_key) return res.status(400).json({ error: 'Set API key first' });
    // Validate by fetching the org
    let info;
    try {
      info = await neonGet(`/organizations/${id}`, null, config.api_key);
    } catch (e) {
      return res.status(400).json({ error: `Cannot fetch org: ${e.message}` });
    }
    config.orgs.push({
      id,
      name: info.name || '',
      plan: info.plan || '',
      managed_by: info.managed_by || '',
    });
    await saveConfig(config);
    res.json({ config: publicConfig(config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Calibrate an org's rate override from a saved invoice
app.post('/api/orgs/:id/calibrate', async (req, res) => {
  try {
    const month = (req.body?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Expected { month: "YYYY-MM" }' });
    const config = await loadConfig();
    const data = await loadData();
    const org = config.orgs.find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const inv = data.orgs[req.params.id]?.invoices?.[month];
    if (!inv) return res.status(404).json({ error: `Invoice ${month} not found for this org` });

    const ovr = {};
    const num = (n) => Number(n) || 0;
    if (num(inv.compute_cu_h) > 0 && num(inv.compute_cost) > 0) {
      ovr.COMPUTE_USD_PER_CU_HOUR = +(num(inv.compute_cost) / num(inv.compute_cu_h)).toFixed(4);
    }
    if (num(inv.storage_root_gb) > 0 && num(inv.storage_root_cost) > 0) {
      ovr.STORAGE_USD_PER_GB_MONTH = +(num(inv.storage_root_cost) / num(inv.storage_root_gb)).toFixed(4);
    }
    if (num(inv.instant_restore_gb) > 0 && num(inv.instant_restore_cost) > 0) {
      ovr.INSTANT_RESTORE_USD_PER_GB_MONTH = +(num(inv.instant_restore_cost) / num(inv.instant_restore_gb)).toFixed(4);
    }
    if (num(inv.network_gb) > 0 && num(inv.network_cost) > 0) {
      ovr.NETWORK_USD_PER_GB = +(num(inv.network_cost) / num(inv.network_gb)).toFixed(4);
    }
    if (Object.keys(ovr).length === 0) {
      return res.status(400).json({ error: 'Invoice has no usable line items to calibrate from' });
    }
    org.rates_override = { ...(org.rates_override || {}), ...ovr };
    await saveConfig(config);
    res.json({ config: publicConfig(config), applied: ovr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manually set rate override for an org (partial)
app.patch('/api/orgs/:id/rates', async (req, res) => {
  try {
    const config = await loadConfig();
    const org = config.orgs.find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    const incoming = req.body?.rates_override;
    if (incoming && typeof incoming === 'object') {
      org.rates_override = { ...(org.rates_override || {}), ...incoming };
    }
    await saveConfig(config);
    res.json({ config: publicConfig(config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset an org's rate override (back to plan/provider defaults)
app.delete('/api/orgs/:id/rates', async (req, res) => {
  try {
    const config = await loadConfig();
    const org = config.orgs.find(o => o.id === req.params.id);
    if (org) delete org.rates_override;
    await saveConfig(config);
    res.json({ config: publicConfig(config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/orgs/:id', async (req, res) => {
  try {
    const config = await loadConfig();
    const id = req.params.id;
    config.orgs = config.orgs.filter(o => o.id !== id);
    await saveConfig(config);
    if (req.query.purge === '1') {
      const data = await loadData();
      delete data.orgs[id];
      await saveData(data);
    }
    res.json({ config: publicConfig(config) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const config = await loadConfig();
    if (!config.api_key) return res.status(400).json({ error: 'Missing API key' });
    const onlyOrg = req.body?.org_id;
    const orgsToRefresh = onlyOrg
      ? config.orgs.filter(o => o.id === onlyOrg)
      : config.orgs;
    if (!orgsToRefresh.length) return res.status(400).json({ error: 'No orgs configured' });

    let data = await loadData();
    data = await migrateLegacyIfNeeded(config, data);
    const errors = [];
    for (const o of orgsToRefresh) {
      try {
        const snap = await fetchOrgSnapshot(o.id, config.api_key);
        const bucket = ensureOrgBucket(data, o.id);
        mergeSnapshot(bucket, snap);
        // Update cached org metadata for rate auto-detection
        o.name = snap.org_name || o.name;
        o.plan = snap.org_plan || o.plan;
        o.managed_by = snap.org_managed_by || o.managed_by;
      } catch (e) {
        errors.push({ org_id: o.id, error: e.message });
      }
    }
    await saveData(data);
    await saveConfig(config);
    res.json({ config: publicConfig(config), data, errors });
  } catch (e) {
    console.error('[refresh]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/invoice', async (req, res) => {
  try {
    const { org_id, month, data: inv } = req.body || {};
    if (!org_id || !/^\d{4}-\d{2}$/.test(month) || typeof inv !== 'object') {
      return res.status(400).json({ error: 'Expected { org_id, month: "YYYY-MM", data: {...} }' });
    }
    const data = await loadData();
    const bucket = ensureOrgBucket(data, org_id);
    bucket.invoices[month] = inv;
    await saveData(data);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill estimated invoices + synthetic snapshots from the Neon
// consumption_history API. Manual (non-estimated) invoices and live
// snapshots are never overwritten.
app.post('/api/import-history', async (req, res) => {
  try {
    const config = await loadConfig();
    if (!config.api_key) return res.status(400).json({ error: 'Missing API key' });
    const onlyOrg = req.body?.org_id;
    const orgsToImport = onlyOrg
      ? config.orgs.filter(o => o.id === onlyOrg)
      : config.orgs;
    if (!orgsToImport.length) return res.status(400).json({ error: 'No orgs configured' });

    // Neon's consumption_history API rejects "from" earlier than 2024-03-01
    // (per the API's own 400 message). Pin to that lower bound and let it
    // return whatever periods exist for this org within the window.
    const fromIso = '2024-03-01T00:00:00Z';
    const toIso = new Date().toISOString();

    let data = await loadData();
    data = await migrateLegacyIfNeeded(config, data);
    const errors = [];
    const summary = [];

    for (const o of orgsToImport) {
      try {
        // Probe to find a valid `from` (or learn the org is plan-gated).
        const probe = await probeAccountHistory(o.id, fromIso, toIso, config.api_key);
        if (probe.kind === 'plan_required') {
          errors.push({
            org_id: o.id,
            error: 'plan_required',
            plan: o.plan || null,
            note: `The Neon /consumption_history API is gated to Scale, Business and Enterprise plans. This org is on "${o.plan || 'unknown'}" — past months can't be auto-imported. Tip: paste the real invoice line items in the form above to get exact numbers.`,
          });
          continue;
        }
        if (probe.kind === 'no_data') {
          errors.push({
            org_id: o.id,
            error: 'no_data',
            note: `Neon returned no consumption history for this org in any month from ${fromIso.slice(0, 10)} onward.`,
          });
          continue;
        }
        if (probe.kind !== 'ok') {
          errors.push({ org_id: o.id, error: `unexpected probe result: ${probe.kind}` });
          continue;
        }

        const acctPeriods = probe.periods;
        const projsResp = await neonGet('/projects', { org_id: o.id, limit: 100 }, config.api_key);
        const projNames = Object.fromEntries((projsResp.projects || []).map(p => [p.id, p.name]));

        let projHist = [];
        if (acctPeriods.length) {
          const earliestPeriodStart = acctPeriods
            .map(p => p.period_start)
            .filter(Boolean)
            .sort()[0];
          try {
            projHist = await listConsumptionProjects(o.id, earliestPeriodStart, toIso, config.api_key);
          } catch (e) {
            // Per-project breakdown is best-effort — the invoice estimates
            // still work without it.
            console.warn(`[import-history] per-project history failed for ${o.id}: ${e.message}`);
          }
        }

        const bucket = ensureOrgBucket(data, o.id);
        let invoicesAdded = 0;
        let snapshotsAdded = 0;
        const months = [];

        for (const period of acctPeriods) {
          const month = monthFromIsoUtc(period.period_start);
          if (!month) continue;
          months.push(month);
          const planForPeriod = period.period_plan || o.plan;
          const ratesForPeriod = effectiveRates({
            plan: planForPeriod,
            managed_by: o.managed_by,
            rates_override: o.rates_override,
          });
          // monthly granularity → exactly one timeframe per period
          const tf = (period.consumption || [])[0];
          if (!tf) continue;
          const u = timeframeToUnits(tf);
          const computeCost = u.cpuH * (ratesForPeriod.COMPUTE_USD_PER_CU_HOUR || 0);
          const storageCost = u.avgStorageGB * (ratesForPeriod.STORAGE_USD_PER_GB_MONTH || 0);

          // Estimated invoice — never overwrite a manual one.
          const existingInv = bucket.invoices[month];
          if (!existingInv || existingInv._estimated) {
            bucket.invoices[month] = {
              compute_cu_h: +u.cpuH.toFixed(4),
              compute_cost: +computeCost.toFixed(2),
              storage_root_gb: +u.avgStorageGB.toFixed(4),
              storage_root_cost: +storageCost.toFixed(2),
              total: +(computeCost + storageCost).toFixed(2),
              _estimated: true,
              _source: 'consumption_history',
              _period_plan: planForPeriod,
              _imported_at: new Date().toISOString(),
            };
            invoicesAdded++;
          }

          // Synthetic snapshot — never overwrite a live one (live snapshots
          // carry per-endpoint detail that the consumption API doesn't
          // expose, so the live data is strictly richer).
          const existingSnap = bucket.snapshots.find(s => s.billing_month === month);
          if (!existingSnap || existingSnap._estimated) {
            const projects = [];
            for (const ph of projHist) {
              const pp = (ph.periods || []).find(p => monthFromIsoUtc(p.period_start) === month);
              if (!pp) continue;
              const ptf = (pp.consumption || [])[0];
              if (!ptf) continue;
              const pu = timeframeToUnits(ptf);
              projects.push({
                project_id: ph.project_id,
                name: projNames[ph.project_id] || ph.project_id,
                cpu_used_sec: pu.cpuSec,
                active_time_sec: pu.activeSec,
                storage_bytes: Math.round(pu.avgStorageBytes),
                quota_reset_at: null,
                endpoints: [],
              });
            }
            const snap = {
              captured_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
              period_reset_at: period.period_end || null,
              period_start_at: period.period_start || null,
              billing_month: month,
              org_id: o.id,
              org_name: o.name,
              org_plan: planForPeriod,
              org_managed_by: o.managed_by,
              projects,
              _estimated: true,
              _source: 'consumption_history',
            };
            mergeSnapshot(bucket, snap);
            snapshotsAdded++;
          }
        }
        summary.push({
          org_id: o.id,
          periods: acctPeriods.length,
          months_seen: [...new Set(months)].sort(),
          invoices_added: invoicesAdded,
          snapshots_added: snapshotsAdded,
        });
      } catch (e) {
        errors.push({ org_id: o.id, error: e.message });
      }
    }
    await saveData(data);
    res.json({ data, errors, summary });
  } catch (e) {
    console.error('[import-history]', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/invoice/:org_id/:month', async (req, res) => {
  try {
    const data = await loadData();
    const bucket = data.orgs[req.params.org_id];
    if (bucket) delete bucket.invoices[req.params.month];
    await saveData(data);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Browser error reporting → prints to the same terminal as `npm run dev`,
// so frontend runtime errors don't require opening DevTools.
app.post('/api/log', (req, res) => {
  const { level = 'error', message = '', stack, source, line, col, url } = req.body || {};
  const tag = level === 'error' ? '\x1b[31m[browser]\x1b[0m' : `\x1b[33m[browser:${level}]\x1b[0m`;
  const where = source ? ` @ ${source}:${line}:${col}` : '';
  const u = url ? ` (page ${url})` : '';
  console.error(`${tag} ${message}${where}${u}`);
  if (stack) console.error(stack);
  res.json({ ok: true });
});

// Server-side process error logging
process.on('uncaughtException', (err) => {
  console.error('\x1b[31m[uncaughtException]\x1b[0m', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('\x1b[31m[unhandledRejection]\x1b[0m', reason);
});

const PORT = Number(process.env.PORT) || 3000;
const PORT_RETRY_LIMIT = 20;

function startServer(port, attempt = 0) {
  const server = app.listen(port, async () => {
    if (port !== PORT) {
      console.log(`\n  Port ${PORT} in use — using ${port} instead.`);
    }
    console.log(`\n  Neon Consumption  →  http://localhost:${port}`);
    try {
      const c = await loadConfig();
      const keyState = c.api_key ? `set (${maskKey(c.api_key)})` : 'MISSING';
      const orgState = c.orgs.length ? c.orgs.map(o => o.id).join(', ') : 'NONE';
      console.log(`  api_key: ${keyState}`);
      console.log(`  orgs:    ${orgState}\n`);
    } catch (e) {
      console.warn(`  could not load config: ${e.message}\n`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < PORT_RETRY_LIMIT) {
      startServer(port + 1, attempt + 1);
    } else {
      console.error('\x1b[31m[listen error]\x1b[0m', err);
      process.exit(1);
    }
  });
}

startServer(PORT);
