# neon.tech-consumption

A self-hosted dashboard to track [Neon Postgres](https://neon.tech) usage and
estimated cost across **multiple organizations**, with month-over-month
history, per-endpoint breakdown, real-invoice calibration and proper charts —
without paying for the Scale plan just to see your own numbers.

Built specifically for users on **Free** or **Launch** (including
Vercel-managed orgs) where Neon hides per-project history and support behind
a paid upgrade.

## Why this exists

Neon's `consumption_history` API endpoint is gated to plan **Scale**
(~$69/month). On Free / Launch the API gives you a snapshot of the
**current** period only — there's no per-project history once the period
resets, no per-endpoint breakdown, and Vercel-managed orgs can't even open a
support ticket without upgrading.

This tool uses the public Neon API (works on any plan) to build your own
historical record locally, so you can answer:

- which projects/endpoints are eating compute, and how much,
- whether `min_cu` and autosuspend are sized right,
- how the real invoice compares to the API-derived estimate,
- whether costs trend up or down month over month.

## Features

- **Multi-organization support** — track several Neon orgs from a single
  dashboard. Add and remove them from the in-app Settings panel.
- **All-Orgs aggregate view** — top-level overview with cost share doughnut,
  top-projects bar chart across orgs, and a stacked monthly trend with a
  line chart of CPU hours.
- **Per-org views**
  - **Overview** — current-period stats, **unified per-project chart**
    (compute $ + storage $ stacked horizontally, sorted by total, with CPU·h
    / active time / storage in the hover tooltip), plus a detail table.
  - **Endpoints** — per-endpoint uptime computed from the `/operations`
    log, with `min_cu` / `max_cu` / autosuspend settings, lower- and
    upper-bound CU·h estimates, and a *Source* column that flags how each
    row was derived.
  - **History** — bar chart of estimated (API) vs invoice (real), grouped
    monthly bar chart of CPU hours per project, and a summary table with a
    Δ column highlighting where the invoice over- or under-shoots the
    estimate.
  - **Invoices** — paste real Vercel/Neon invoice line items each month;
    one-click **Calibrate** uses those numbers to derive exact $/CU·h, $/GB
    etc. for that org.
- **Auto-detected rates** — each org's rates are picked from a built-in
  table based on its `plan` and `managed_by` fields (Vercel-managed Launch
  ≠ Neon Launch direct, etc.). One click on Calibrate from a saved invoice
  derives the exact numbers from your real bill.
- **Browser errors → server terminal** — runtime exceptions in the dashboard
  are forwarded to the terminal where you ran `npm run dev`, so you don't
  need to keep DevTools open.
- **All data stays local** — no external service. The only outbound network
  call is to `console.neon.tech`. Both `config.json` (your API key) and
  `data.json` (your snapshots and invoices) are gitignored.

## Setup

```bash
git clone <this-repo>
cd neon.tech-consumption
npm install
npm run dev
```

Open <http://localhost:3000> and click **⚙ Settings**:

1. Paste your **Neon API key** (`napi_…`) and click *Save key*.
2. Add one or more **organization IDs** (`org-xxxx-xxxx`).
3. Close Settings and click **↻ Refresh**.

That's it — the dashboard fetches a snapshot for each org and saves it to
`data.json`. Refresh whenever you want to update; if you refresh before each
`quota_reset_at` (typically the 1st of every month), you build a real
month-over-month history.

### Optional: bootstrap from `.env`

For automation or CI, you can pre-seed the API key and orgs via env vars
(see `.env.example`). They're used only on first run, before `config.json`
exists. After that, the in-app Settings panel is the source of truth.

```bash
cp .env.example .env
# edit .env with your values
npm run dev
```

### Where to find the values

- **NEON_API_KEY** — <https://console.neon.tech> → avatar → *Account
  settings* → *API keys* (personal), or *Settings* → *API keys* in the org
  context for an org-scoped key.
- **Organization IDs** — with the API key set, run:
  ```bash
  curl -H "Authorization: Bearer $KEY" \
    https://console.neon.tech/api/v2/users/me/organizations
  ```
  Each entry has an `id` like `org-xxxxxxxx-xxxxxxxx`. Or copy them from
  the URL when switching orgs in the Neon console.

| Variable        | Where it lives                                     | Notes                                  |
| --------------- | -------------------------------------------------- | -------------------------------------- |
| `NEON_API_KEY`  | `config.json` (managed via UI) or `.env` (initial) | Read access to all orgs you want.      |
| `ORG_ID`        | `config.json` (managed via UI) or `.env` (initial) | Comma-separated when in `.env`.        |
| `PORT`          | `.env`                                             | Optional, default `3000`.              |

## How rates work

Neon does **not** expose pricing through its API. The dashboard handles
this in three layers, applied in this order:

1. **`PLAN_RATES`** — built-in defaults per plan (Free, Launch, Scale,
   Business) derived from <https://neon.tech/pricing>. Used when nothing
   more specific is known.
2. **`PROVIDER_OVERRIDES`** — per-provider deltas. Vercel-managed orgs are
   billed at different per-unit prices than direct Neon; once `managed_by:
   vercel` is detected on refresh, those overrides apply automatically.
3. **`rates_override` per org** — set by clicking **Calibrate** next to a
   saved invoice. The exact $/CU·h, $/GB, etc. are derived by dividing real
   line items (`compute_cost / compute_cu_h`, …) and stored as the new
   override for that org.

Effective rates show their source in Settings (`plan:launch`,
`vercel:launch`, `custom`). **Reset** returns them to auto-detection.

### What the dashboard estimates

- **Compute (org-level)** — `cpu_used_sec / 3600 × $/CU·h`. The
  `cpu_used_sec` field returned by Neon is already weighted by CU size, so
  it's the ground truth for total CU·h consumed in the period.
- **Compute (per endpoint)** — `uptime × min_cu / 3600`. Uptime is
  reconstructed by pairing `start_compute` / `suspend_compute` events from
  `/projects/:id/operations`. This is a **lower bound**: when the
  autoscaler ramps the CU up, the real cost is higher and the project-level
  `cpu_used_sec` reflects it.
- **Storage** — `synthetic_storage_size / 1024³ × $/GB-month`.
- **Network egress** — *not exposed* per project on Free / Launch. Visible
  only on the real invoice. Use the Invoices tab to keep a record.

### Heuristic for endpoints with no recent events

If an endpoint has been running longer than the operations log retention,
there are no recent `start_compute` events to pair. In that case the
endpoint is reported under the assumption *active without events → full
period uptime*, flagged in the *Source* column as
`assumed (active, no events)` so you can spot it.

## Project layout

```
neon.tech-consumption/
├── server.js          ← Express server + Neon API client (multi-org)
├── package.json
├── public/
│   ├── index.html     ← UI + inline styles
│   ├── app.js         ← frontend logic (vanilla JS, no build step)
│   └── favicon.svg    ← Lucide "gauge" icon, indigo→cyan gradient
├── .env.example       ← optional env-based config template
├── config.json        ← API key + orgs + rate overrides (gitignored)
├── data.json          ← snapshots + invoices, scoped per org (gitignored)
├── LICENSE
└── README.md
```

## Privacy

`config.json` (your API key, org list, rate overrides) and `data.json`
(snapshots, invoices) are listed in `.gitignore`. They never leave your
machine — the only outbound network calls go to `console.neon.tech`. The
publishable code carries no personal data; `.env.example` only contains
placeholders.

## Stack

- Node ≥ 18 (uses built-in `fetch`)
- Express
- Chart.js (via CDN)
- Vanilla JS, no build step
- Lucide icons (inlined SVG)

## Author

Built by [furnedesigns](https://furnedesigns.com).

## License

MIT — see [`LICENSE`](./LICENSE).
