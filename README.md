# Sports Trading Bot

A personal sports **trading & analytics dashboard** built on Next.js. It ingests live
odds from prediction markets and betting exchanges, finds edges (mispricings and
cross‑venue arbitrage), and — behind a deliberately strict safety gate — can place real
orders.

> ⚠️ **Personal research tool, provided as‑is.** Nothing here is financial advice. Live
> trading is off by default and must be armed by hand. You trade at your own risk.

---

## What it does

The app is a multi‑tab dashboard (`/`):

| Tab | What it is |
|-----|-----------|
| **Claw Arbs** (`/arbitrage`) | The flagship — cross‑venue **arbitrage** scanner + gated live execution (see below). |
| **Value Plays** (`/value-plays`) | Model‑vs‑market value bets for MLB, with grading + P&L tracking. |
| **Player Props** (`/props`) | MLB player‑prop line/odds discrepancy scanner across books. |
| **Live Trading** (`/live-trading`) | Kalshi paper/live trade proposals + history. |
| **Markets / Line Movement / Performance / WNBA** | Supporting boards for market data, line moves, bot performance, and WNBA. |

No database — everything persists as date‑keyed JSON under `data/` (gitignored).

---

## The arbitrage strategy (Claw Arbs)

The core idea is a classic **two‑leg cross‑venue arbitrage**:

1. **Ingest** the same games from multiple venues and normalize every market (moneyline,
   total over/under, run‑line spread) into one shape, keyed by `sport:league:teams`.
2. **Match** identical markets across venues (same game, same line).
3. **Detect** an arb when you can buy *both* sides for a combined cost **< \$1.00** —
   i.e. the two venues' implied probabilities sum to **< 100%**. The gap (minus fees and
   a slippage reserve) is the locked‑in edge.
4. **Size** each leg for equal profit regardless of outcome, capped by executable depth
   and a per‑trade limit.
5. **Execute** both legs (near‑simultaneously) as marketable **fill‑or‑kill** orders, then
   **reconcile** the fills — so you never sit on one unhedged (naked) leg.

The dashboard also shows a **watch board** of near‑arbs (matched markets that aren't
profitable yet) so you can see prices converge/diverge in real time, and a continuous
scan loop that re‑polls venues back‑to‑back to catch short‑lived windows.

### Venues

| Venue | Type | Auth model |
|-------|------|-----------|
| **Kalshi** | Regulated US exchange | RSA‑PSS signed REST API key |
| **Polymarket (international)** | Self‑custody CLOB (Polygon) | **Wallet private key** (derives its own API creds) |
| **Polymarket US** | Regulated US exchange | **Ed25519 API key** (Key ID + secret) |
| **SX.bet** | On‑chain order‑book exchange (SX Network) | **Wallet private key** (EIP‑712 signed fills) |

**Region toggle:** `POLYMARKET_REGION=intl` (default, deep books, self‑custody) or `us`
(regulated, thinner books). International Polymarket has far deeper liquidity — where the
real arbs live — but isn't usable from the US; Polymarket US is the compliant fallback.

---

## Safety / how live trading is armed

Live orders are **off by default** and fail‑closed. A real order only fires when **every**
independent switch is on (any one off → the trade silently downgrades to a simulated
"dry‑run" and reports which switches blocked it):

- the caller requested **live** (the "Live" button, or armed auto‑execute)
- the agent's **Paper/Live** toggle is set to **Live**
- the risk **kill switch** is off
- the trade stake is **under the per‑trade cap** (set in the Risk panel)
- the venue has **credentials** entered and (for on‑chain venues) a **USDC allowance**
- the request is **admin‑authenticated** (`ADMIN_PASSWORD`)

**Credentials live only in your browser** (localStorage), are sent per‑request to sign,
and are **never persisted on the server, logged, or committed**. Arming is entirely
UI‑driven — no live‑trading environment variables.

Optional **auto‑execution** can fire qualifying arbs automatically (no click) once you
deliberately arm it (auto‑trade on + agent Live on + a session admin password).

> Execution paths are structurally complete but should each be **validated with a \$1
> trade** before being trusted with size.

---

## Tech stack

- **Next.js 16** (App Router, React 19), TypeScript (strict), Tailwind 4
- **ethers v6** (on‑chain signing), `@polymarket/clob-client`, `node-cron`
- **vitest** for the pure math / signing / gate logic
- No database; date‑keyed JSON stores under `data/`

> Note: this repo pins a **modified** build of Next.js — see `AGENTS.md`.

---

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Other scripts:

```bash
npm run build        # production build
npm run test         # vitest
npm run lint         # eslint
```

### Configuration (`.env.local`, gitignored)

Most reads are public/no‑auth. For live execution you'll set (as needed):

- `ADMIN_PASSWORD` — required to authorize a live trade
- `POLYMARKET_REGION` — `intl` (default) or `us`
- `POLYGON_RPC_URL` / `SX_RPC_URL` — optional RPC overrides
- Venue credentials are normally entered **in the UI** (Venue → Credentials), not here.

Then, per venue: enter credentials → verify balance → (on‑chain) approve USDC →
paper‑trade → arm Live → validate at **\$1**.

---

## Disclaimer

This is a personal project for research and education. Markets, APIs, and venue rules
change; execution can fail; arbitrage can leave unhedged exposure. The author is not
responsible for any financial loss. Use at your own risk, and only ever with funds you
can afford to lose.
