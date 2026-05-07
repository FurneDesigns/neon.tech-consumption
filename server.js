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
app.listen(PORT, async () => {
  console.log(`\n  Neon Consumption  →  http://localhost:${PORT}`);
  // Log resolved config so users can immediately see if creds aren't loaded.
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
