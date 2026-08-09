# Sports Trading Bot

**Important:** Must use app with VPN not based in USA. ie. Mexico, Canada, etc.

Sports Trading Bot is a personal sports trading webapp built with Next.js. Its main workflow is the **Claw Arbs** scanner: it scans multiple sportsbooks, prediction markets, and exchange books; normalizes their prices into one comparable format; finds price differences across venues; and can place two-sided arbitrage trades when the safety gates allow it.

This is not a picks app. It is a trading and execution dashboard for watching markets, comparing books, finding cross-venue mispricings, tracking paper/live trades, and reviewing execution logs.

> **Important:** This is a personal research tool provided as-is. Nothing here is financial advice. Live trading is off by default and requires manual setup, credentials, an admin password, and risk controls. You trade at your own risk.

---

## What The Webapp Does

The app is centered on cross-venue sports arbitrage:

1. **Scans different books and venues.** The scanner pulls markets from supported venues such as Kalshi, Polymarket, SX.bet, predict.fun, CloudBet, and other configured data sources.
2. **Normalizes market data.** It converts venue-specific markets into shared fields: sport, league, teams, market type, line, outcome, price, depth, fees, and native venue identifiers.
3. **Matches the same game across venues.** It tries to identify when two or more venues are quoting the same game and the same market, such as moneyline, spread/run line, or total.
4. **Finds price differences.** It compares the cost of buying opposite sides across books. An arbitrage exists when both sides can be bought for less than $1.00 total after fees and slippage reserve.
5. **Builds a trade plan.** For qualifying opportunities, it sizes each leg so the payoff is balanced and the expected profit is similar regardless of which side wins.
6. **Places trades when armed.** In paper mode it simulates orders. In live mode it sends orders to the venue adapters, then reconciles fills so you can see whether the trade filled, partially filled, failed, or left naked exposure.

The scanner also shows near-arbs and rejected matches so you can understand where opportunities almost appeared and why the engine filtered them out.

---

## Getting Started

Install dependencies and run the local app:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Useful commands:

```bash
npm run test
npm run lint
npm run build
```

The main scanner lives at:

```text
http://localhost:3000/arbitrage
```

Data is stored locally as date-keyed JSON under `data/`, which is gitignored. Venue credentials entered in the webapp are stored only in your browser localStorage and are forwarded per request when needed.

---

## Environment Setup

Create or update `.env.local` for app-level settings. Do not commit this file.

Common settings:

```env
ADMIN_PASSWORD=your-local-admin-password
POLYMARKET_REGION=intl
POLYGON_RPC_URL=
SX_RPC_URL=
```

`ADMIN_PASSWORD` is required for live execution and approval actions. `POLYMARKET_REGION` controls which Polymarket adapter the app uses:

- `intl`: international Polymarket CLOB / deposit-wallet flow.
- `us`: Polymarket US API flow.

Most venue credentials should be entered through the venue drawer in the webapp rather than hard-coded in `.env.local`.

---

## Setting Up API Keys

Open the Claw Arbs page, click a venue node, then open the venue's **Credentials** tab. Save credentials there first, then verify balance/status from the same drawer. For on-chain venues, use a dedicated wallet funded only with the amount you are willing to trade.

### Kalshi

Kalshi needs:

- **API Key ID**
- **Full RSA private key in PEM format**

Paste the complete RSA private key, including the `BEGIN` and `END` lines. The key is used to sign Kalshi REST requests. After saving, the venue status should show whether the credentials can read account balance and whether live orders are available.

### Polymarket

Polymarket setup depends on `POLYMARKET_REGION`.

For international Polymarket deposit-wallet trading, you need:

- **Owner wallet private key**
- **Signature type**
- **Funder address**
- **Deposit wallet address**
- **Relayer API key**
- **Relayer API key address**
- **Builder code**
- **Builder address**

In the webapp credential form, the most important fields are the owner wallet private key, the funder/deposit wallet address, and the signature type. For the deposit-wallet flow, use signature type `3`.

Typical environment names used by helper scripts and server fallbacks:

**Strongly recommended to use in .env.local file**

```env
POLYMARKET_SIG_TYPE=3
POLYMARKET_FUNDER=0x...
POLYMARKET_DEPOSIT_WALLET=0x...
POLYMARKET_WALLET_KEY=0x...
RELAYER_API_KEY=...
RELAYER_API_KEY_ADDRESS=0x...
BUILDER_CODE=...
BUILDER_ADDRESS=...
POLYMARKET_CLOB_HOST=https://clob.polymarket.com
POLYMARKET_RELAYER_URL=https://relayer-v2.polymarket.com
```

For Polymarket US, set `POLYMARKET_REGION=us` and use the Polymarket US credentials form. It needs:

- **Key ID**
- **Ed25519 secret**

### SX.bet

SX.bet needs:

- **SX.bet wallet private key**
- **USDC balance on SX Network**
- **USDC allowance/approval for the SX.bet exchange**
- Optional `SX_RPC_URL` if you want to override the default SX Network RPC

The wallet private key signs SX.bet EIP-712 fill requests. The app checks balance and allowance in the venue drawer. Before live fills, run the approval flow from the Credentials tab with the admin password. SX.bet taker fills must also satisfy the minimum stake and top-of-book liquidity checks.

Typical environment names used by helpers/server fallback:

```env
SXBET_WALLET_KEY=0x...
SX_RPC_URL=https://rpc-rollup.sx.technology
SXBET_ODDS_SLIPPAGE=0
```

### predict.fun

predict.fun needs:

- **predict.fun API key**
- **Wallet private key**
- **Smart-account / predict account address**, optional but usually needed when your funds live in a ZeroDev deposit account
- **USDT balance on BNB Chain / predict.fun account**
- **One-time approvals** for the protocol contracts before first live order

The API key authorizes predict.fun requests. The wallet key signs orders. The optional account field tells the app which predict.fun smart account holds the funds; if it is blank, the signer address is used.

Typical environment names used by helpers/server fallback:

```env
PREDICTFUN_API_KEY=...
PREDICTFUN_WALLET_KEY=0x...
PREDICTFUN_ACCOUNT=0x...
```

### CloudBet

CloudBet needs:

- **CloudBet API key**
- **Settlement currency**, optional, defaulting to `USDC`

The API key authorizes odds reads and bet placement. CloudBet is a sportsbook, not an exchange order book, so placed bets are final and cannot be cancelled.

Typical environment names:

```env
CLOUDBET_API_KEY=...
CLOUDBET_CURRENCY=USDC
```

---

## Using The Scanner

The Claw Arbs scanner is the main operating screen. The top bar opens the major panels: **Arbs**, **Portfolio**, **Match Map**, **Risk**, **Log**, **Analytics**, and **Settings**.

### Arbs Tab

The **Arbs** tab shows current arbitrage opportunities and near-arbs.

Use it to see:

- Matched games and market type, such as moneyline, spread/run line, or total.
- The venues involved in each trade.
- Net edge after fees and safety buffers.
- Stake sizing and expected profit.
- Whether an opportunity is playable, already executed, halted, partial, or naked.
- The play button for opening the execution modal.

This is where you decide whether a detected price difference is worth playing. In paper mode, pressing play records a simulated trade. In live mode, pressing play attempts real execution only if all safety gates pass.

### Portfolio Tab

The **Portfolio** tab shows trades that have been opened by the app.

Use it to track:

- Paper and live positions.
- Each trade's legs, venue prices, order IDs, stake, and expected profit.
- Fill status: filled, partial, failed, or naked.
- Open and closed positions.
- Settlement and realized P&L when a trade can be graded.
- Post-fill verification, which checks whether the edge disappeared after execution.

Open this tab after trading to confirm whether both legs filled and whether any position needs attention.

### Match Map Tab

The **Match Map** tab explains how the scanner is matching markets.

Use it to inspect:

- Which games were successfully matched across venues.
- Which venues are quoting each game.
- Moneyline, spread/run line, and total markets grouped under the same game.
- The individual venue legs and prices used by the matching engine.
- Rejected matches and the reason they were filtered out.

This tab is useful when you expect an arb but do not see one. It can show whether the app failed to match the teams, rejected a line mismatch, removed a self-edge, or filtered out an event because confidence was too low.

### Risk Tab

The **Risk** tab controls the guardrails for execution.

Use it to manage:

- Maximum live stake per trade.
- Minimum liquidity requirement.
- Minimum expected profit requirement.
- Depth buffer settings.
- Maximum open positions.
- Auto-trade readiness.

Live trading will not happen just because an arb exists. The Risk tab settings are part of the execution gate, and the app blocks or downgrades trades when the stake, liquidity, or safety state is not acceptable.

### Log Tab

The **Log** tab is the audit trail for the scanner and executor.

Use it to review:

- Detected arbs.
- Played trades.
- Halted trades.
- Live-blocked trades.
- Partial fills.
- Naked exposure warnings.
- Reason codes and execution pipeline details.
- Venue pairs and edge values at the time of action.

When something does not trade, the Log tab is usually the fastest place to find out why.

### Analytics Tab

The **Analytics** tab summarizes trading performance.

Use it to understand:

- Paper performance.
- Trade count and execution outcomes.
- Realized P&L where available.
- Win/loss or open/closed summaries.
- How the strategy is behaving over time.

Open this tab after a session to evaluate whether the scanner is finding meaningful opportunities or only noisy ones.

### Settings Tab

The **Settings** area controls the agent rather than a single venue.

Use it to configure:

- Paper versus Live mode.
- Auto-trade behavior.
- Agent strategy settings.
- Whether live execution is armed.
- Activity for the agent.

The app defaults to paper behavior. For a real order to fire, the agent must be in Live mode, the admin password must be supplied where required, and every venue in the route must have valid credentials.

---

## Venue Drawers

Clicking a venue node opens a venue-specific drawer with its own tabs:

- **Status:** connection state, balance, freshness, role, and cached market count.
- **Live:** markets currently visible for that venue.
- **Edges:** arbs or tracked edges involving that venue.
- **Settings:** enable/disable, view-only mode, role, currency, cancel support, and irreversible-order status.
- **Credentials:** venue-specific API keys, wallet keys, balance checks, and approvals.

Use venue drawers when a venue shows `Credentials needed`, stale data, no balance, or missing allowance.

---

## Live Trading Safety

Live orders fail closed. A real trade only fires when all of these are true:

- You requested live execution.
- The agent is switched to Live in Settings.
- The stake is under the Risk tab's live stake cap.
- Each venue supports live execution for that route.
- Credentials are present for every live venue.
- Balance and allowance checks pass where applicable.
- The admin password is supplied for protected actions.

If any check fails, the app reports the blocker instead of silently sending an unsafe order.

Naked positions are recorded and surfaced for review, but they do not pause the scanner or stop subsequent opportunities from executing.

Validate each venue with a very small trade before increasing size.

---

## Tech Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- ethers v6
- Polymarket CLOB clients
- Vitest
- Local JSON persistence under `data/`

This repo pins a modified build of Next.js. See `AGENTS.md` before changing Next.js-specific code.

---

## Disclaimer

Markets, APIs, venue rules, liquidity, and execution behavior can change. Orders can fail, partially fill, or leave unhedged exposure. Use this app only for research or with funds you can afford to lose.
