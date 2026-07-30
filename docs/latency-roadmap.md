# Latency & Fill-Rate Roadmap (Phases 1 & 2)

Context: on 2026-07-29 the live path executed **1 of 486** attempts. Two rounds of
optimization landed (targeted refresh, adaptive Polymarket cushion, preflight→retry
routing, freshness fast-path, per-venue timeouts, async reconciliation, JSONL logs,
concurrent pre-checks). Those cut the *self-inflicted* latency. The remaining gap is
structural: the bot still **polls** quotes and detects arbs at **top-of-book** rather than
at executable depth, so it keeps racing faster market makers and attempting arbs that
can't fill. Phases 1 and 2 address the structure.

> Status: **planned** (not started). Owners/dates TBD.

---

## Phase 1 — Streaming (WebSocket) quotes instead of polling

### Problem
Every venue reader fetches the **whole league/slate** over HTTP and we re-ingest every
~1–3s (`ingest.ts`, `ArbitrageClient` scan loop). Even with the freshness fast-path, quotes
are 1–3s stale at fire time, which is most of the "opportunity no longer exists" losses.
`seed.ts` already notes: *"Real-time WebSocket streaming (later phase)."*

### Target design
A push-based quote layer that keeps `marketStore` continuously fresh, so the pre-trade
refresh becomes a no-op for streamed markets.

- **New module** `src/lib/arbitrage/stream/` with one adapter per venue implementing a
  common `QuoteStream` interface: `subscribe(marketIds[])`, `onQuote(cb)`, `reconnect`,
  `health()`. Each pushes normalized `NormalizedMarket` deltas into `marketStore` (reuse
  the existing normalize functions from `ingest.ts`).
- **Venue endpoints:**
  - **Kalshi** — WS `wss://api.elections.kalshi.com/trade-api/ws/v2`, channels
    `orderbook_delta` / `ticker_v2`. Auth via the same RSA-PSS key.
  - **Polymarket (intl CLOB)** — WS `wss://ws-subscriptions-clob.polymarket.com/ws/market`,
    `book`/`price_change` per token id. (US: `api.polymarket.us` — confirm WS availability
    before switching `POLYMARKET_REGION=us`.)
  - **SX.bet** — Ably-based realtime (`order_book` channel per market hash) per SX docs.
  - **CloudBet** — no public WS; keep polling (already has a single-event fetch), or poll
    only the in-play markets at higher cadence.
  - **predict.fun** — poll (no WS) unless one appears.
- **Subscription scope:** only games within ~2h of tip-off and only the market types with
  live arbs, to bound connection/CPU. Fall back to polling for everything else.
- **Freshness:** with streaming, `refreshMarketsForOpportunity` is skipped entirely for
  streamed legs (extend the existing `canSkipLiveRefresh` fast-path to trust stream age).
  Keep polling as the cold-start + fallback path; the stale-quote gate stays the backstop.
- **Health/reconnect:** per-stream heartbeat + exponential-backoff reconnect; on stream
  loss, that venue automatically reverts to polling and the venue-diagnostics `status`
  reflects `stream_down`.

### Expected impact
Eliminates the 1–3s polling staleness → the dominant "opportunity no longer exists"
bucket; sub-100ms quote-to-detection; removes the pre-trade network refresh from the hot
path for streamed venues.

### Risk / effort
Largest effort (per-venue WS auth, delta bookkeeping, reconnect). Ship venue-by-venue
behind a flag (`ARB_STREAM_VENUES=kalshi,polymarket`), starting with the highest-volume
pair (Polymarket + Kalshi for MLB), polling everything else.

---

## Phase 2 — Depth-aware arb detection

### Problem
`arbEngine.ts` prices each leg at the **top-of-book ask** and its own comment admits
"depth-aware sizing is a later phase." That is exactly why 245/486 attempts died at the
Polymarket preflight: the detected ask had no depth at the traded size. We *attempt*
phantom arbs, burning latency and skewing the fill ratio.

### Target design
- Carry **book depth** (price/size levels), not just top-of-book, on `NormalizedMarket`
  (streaming from Phase 1 makes full books cheap; until then, fetch top-N levels).
- In `detectArbs`, size each leg by **walking the book** to the intended stake and price
  the arb at the **volume-weighted fill price** for that size, not the top level. Only emit
  an opportunity if it clears (`sum < 100c` net of fees) **at executable depth**.
- Emit the executable size on the opportunity so the executor doesn't need its preflight
  resize round-trip (the preflight becomes a cheap re-confirm, or is dropped for streamed
  books).
- Add a rejected-opportunity reason `no_executable_depth` (reuse the enriched `ArbReject`
  fields already shipped: equation / cost / liquidity / requiredLiquidity).

### Expected impact
Stops attempting arbs that can't fill → far fewer preflight/FOK-kill failures, higher
fill ratio, less wasted latency per attempt. Complements Phase 1 (streaming supplies the
depth cheaply).

### Risk / effort
Medium. Pure-function change in `arbEngine.ts` + carrying depth on the market model; guard
with tests (extend `arbEngine.test.ts`). Can land before full streaming using top-N levels
from the existing REST reads.

---

## Hosting / colocation plan (supports Phases 1 & 2)

Network RTT to each venue is a large share of both poll and order latency. Deploy the
quote-stream + execution workers **regionally, one deployment per venue, each close to that
venue's exchange/API**, on AWS or GCP:

| Venue | API / exchange locality | Target region |
|---|---|---|
| **Kalshi** | US-regulated, US-East infra | **AWS us-east-1** (or GCP us-east4) — colocate here first |
| **Polymarket (intl CLOB)** | Polygon + CLOB infra (largely EU/US edge) | Region nearest the CLOB gateway — benchmark us-east-1 vs eu-central-1 and pick the lower-RTT one |
| **Polymarket US** | `api.polymarket.us` (US) | US-East (only if `POLYMARKET_REGION=us`) |
| **SX.bet** | SX Network (offshore) + Ably realtime edge | Region nearest the Ably edge / SX API — an **out-of-country** region (e.g. eu-west or an APAC/edge PoP) per measured RTT |
| **CloudBet** | Offshore sportsbook (EU/UK-leaning) | **eu-west-1 / eu-central-1** |
| **predict.fun** | BNB chain infra (APAC-leaning) | Region nearest its API per measured RTT |

Design notes:
- **Per-venue worker, shared brain.** Each regional worker owns *only* its venue's stream +
  order placement (lowest RTT to that venue). A central coordinator (or a shared
  low-latency store — e.g. Redis/Elasticache, or a lightweight message bus) holds the
  merged book and runs `detectArbs`; it dispatches each leg to the worker colocated with
  that venue so the order leaves from the nearest point. This directly shrinks the
  detection→placement window that Phases 1 & 2 target.
- **Cross-region hedge timing.** For a 2-venue arb the two legs fire from two regions; keep
  the existing fragile-venue-first sequencing and the naked-kill safety, and account for the
  inter-region hop when setting the anchor's fill window.
- **Measure before placing.** Before committing a region per venue, run an RTT benchmark
  (TCP connect + a lightweight authenticated read) from candidate regions to each venue and
  pick the lowest; document the numbers here.
- **Keep-alive + HTTP/2** on all venue clients regardless of region (avoids per-call TLS
  handshakes) — this is a quick win to land even before regional deployment.
- **Secrets** stay per-region in the platform secret manager (AWS Secrets Manager / GCP
  Secret Manager); never in `.env.local` in the deployed image.

### Sequencing
1. Land keep-alive/HTTP-2 on venue clients (quick win, any host).
2. Phase 2 depth-aware detection (works on current REST, immediate fill-ratio win).
3. Phase 1 streaming, venue-by-venue (Polymarket + Kalshi first).
4. Regional/colocated deployment, starting with **Kalshi in us-east-1**, then SX.bet /
   CloudBet / Polymarket in their nearest regions per the RTT benchmark.
