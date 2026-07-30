// One-off: place a REAL $1 live bet on the Arizona Diamondbacks via Cloudbet.
//
// During live play Cloudbet suspends the full-game moneyline, so this uses the live
// "which team wins the rest of the match" market (continuously open). It reads the D-backs
// side + current score param + live price straight from the feed right before placing, so
// we always bet the right team at a current, enabled price. Places $1 USDC, all-or-nothing.
//
//   node scripts/cloudbet-buy-diamondbacks-live.cjs [eventId] [stakeUsd]
//
// Real money. Cannot be cancelled once matched.

const fs = require("fs");
const crypto = require("crypto");

const env = fs.readFileSync("c:/Users/seema/Documents/GitHub/Sports-Trading-Bot/.env.local", "utf8");
const val = (n) => (env.match(new RegExp("^" + n + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const KEY = val("CLOUDBET_API_KEY");
const CUR = val("CLOUDBET_CURRENCY") || "USDC";
if (!KEY) { console.error("no CLOUDBET_API_KEY"); process.exit(1); }

const EVENT = process.argv[2] || "35527188";
const STAKE = Number(process.argv[3] || "1"); // USDC
const MARKET = "baseball.which_team_wins_the_rest_of_the_match";
const TEAM = /diamondbacks|\bARI\b/i;
const FEED = "https://sports-api.cloudbet.com/pub/v2/odds";
const TRADE = "https://sports-api.cloudbet.com/pub/v3";
const H = { "X-API-Key": KEY, Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url) {
  const r = await fetch(url, { headers: H, cache: "no-store" });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { ok: r.ok, status: r.status, body: b };
}

// Find the D-backs' enabled selection in the rest-of-match market: returns
// { outcome, params, price } read fresh, or null if currently suspended.
async function findDbacksSelection() {
  const { ok, body } = await jget(`${FEED}/events/${EVENT}?markets=${MARKET}`);
  if (!ok) return { err: `feed HTTP ${body?.message || ""}` };
  const home = body.home?.name || "", away = body.away?.name || "";
  const side = TEAM.test(away) ? "away" : TEAM.test(home) ? "home" : null;
  if (!side) return { err: `Diamondbacks not found in event (${away} @ ${home})` };
  const subs = body.markets?.[MARKET]?.submarkets || {};
  for (const sub of Object.values(subs)) {
    const sel = (sub.selections || []).find((s) => s.outcome === side);
    if (sel && (!sel.status || sel.status === "SELECTION_ENABLED") && sel.price > 1) {
      return { side, teams: `${away} @ ${home}`, price: sel.price, params: sel.params || "", minStake: sel.minStake || 0 };
    }
  }
  return { suspended: true, side, teams: `${away} @ ${home}` };
}

(async () => {
  // 1) balance
  const bal = await jget(`${FEED.replace("/pub/v2/odds", "")}/pub/v1/account/currencies/${CUR}/balance`);
  console.log(`Balance: ${bal.ok ? bal.body.amount + " " + CUR : "ERROR " + JSON.stringify(bal.body)}`);
  if (bal.ok && Number(bal.body.amount) < STAKE) { console.error(`Insufficient ${CUR} balance for $${STAKE}`); process.exit(1); }

  // Statuses that mean the stake is committed (a real, live bet). Anything else is a
  // rejection with no money taken and is safe to retry.
  const PLACED = new Set(["ACCEPTED", "WIN", "LOSS", "PUSH", "HALF_WIN", "HALF_LOSS", "PARTIAL"]);
  const MAX_ATTEMPTS = 8;

  // Each attempt is fully resolved (terminal status) before the next, so at most ONE bet
  // can ever be accepted — live legs keep suspending mid-acceptance, so we retry.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const sel = await findDbacksSelection();
    if (sel.err) { console.error(sel.err); process.exit(1); }
    if (!sel.price) { process.stdout.write("s"); await sleep(700); attempt--; continue; }

    const marketUrl = `${MARKET}/${sel.side}${sel.params ? "?" + sel.params : ""}`;
    const reqPrice = (sel.price * 0.97).toFixed(4); // accept a small live tick against us
    const referenceId = crypto.randomUUID();
    const body = { referenceId, currency: CUR, eventId: String(EVENT), marketUrl, price: reqPrice, stake: STAKE.toFixed(6), acceptPriceChange: "BETTER" };

    console.log(`\n[attempt ${attempt}] D-backs (${sel.side}) rest-of-match ${sel.teams} | live ${sel.price} req>=${reqPrice} $${STAKE} ${CUR}`);
    const r = await fetch(`${TRADE}/bets/place`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let b; try { b = JSON.parse(await r.text()); } catch { b = {}; }
    let status = (b.status || "").toUpperCase();
    console.log(`  place HTTP ${r.status} status=${status}`);

    // GET (not POST) the status until terminal.
    for (let i = 0; status === "PENDING_ACCEPTANCE" && i < 12; i++) {
      await sleep(1000);
      const s = await fetch(`${TRADE}/bets/${referenceId}/status`, { headers: H });
      const sb = await s.json().catch(() => ({}));
      status = (sb.status || status).toUpperCase();
      if (sb.price) b.price = sb.price;
      console.log(`  poll ${i}: ${status}`);
    }

    if (PLACED.has(status)) {
      console.log(`\n✅ LIVE BET PLACED — D-backs rest-of-match @ ${b.price} for $${STAKE}. status=${status} refId=${referenceId}`);
      return;
    }
    console.log(`  rejected (${status || "no status"}) — no money taken; retrying`);
    await sleep(800);
  }
  console.log(`\n❌ Could not land the live bet in ${MAX_ATTEMPTS} attempts — market kept suspending. No money taken.`);
})();
