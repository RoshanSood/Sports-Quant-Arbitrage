const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "https://sports-api.cloudbet.com";
const COMPETITION = "baseball-usa-mlb";
const MARKET = "baseball.moneyline";
const TERMINAL_STATUSES = new Set([
  "ACCEPTED",
  "WIN",
  "LOSS",
  "PUSH",
  "HALF_WIN",
  "HALF_LOSS",
  "PARTIAL",
  "REJECTED",
  "PRICE_ABOVE_MARKET",
  "STAKE_ABOVE_MAX",
  "STAKE_BELOW_MIN",
  "EVENT_NOT_FOUND",
  "MARKET_NOT_FOUND",
]);

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

function argValue(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env.local`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  return { response, body };
}

async function fetchJson(url, init) {
  const { response, body } = await requestJson(url, init);
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

function allSelections(event) {
  return Object.values(event.markets?.[MARKET]?.submarkets || {}).flatMap((submarket) => submarket.selections || []);
}

function selectionIsExecutable(selection, stake) {
  return (
    selection?.status === "SELECTION_ENABLED" &&
    Number(selection.price) > 1 &&
    stake + 1e-9 >= Number(selection.minStake || 0) &&
    stake <= Number(selection.maxStake || 0) + 1e-9
  );
}

function impliedCents(decimalOdds) {
  return 100 / decimalOdds;
}

function americanOdds(decimalOdds) {
  if (decimalOdds >= 2) return `+${Math.round((decimalOdds - 1) * 100)}`;
  return String(Math.round(-100 / (decimalOdds - 1)));
}

function printLine(line) {
  const odds = Number(line.price);
  console.log(`selection status: ${line.status || "unknown"}`);
  console.log(`decimal odds: ${Number.isFinite(odds) ? odds.toFixed(4) : "n/a"}`);
  console.log(`American odds: ${Number.isFinite(odds) && odds > 1 ? americanOdds(odds) : "n/a"}`);
  console.log(`implied cost: ${Number.isFinite(odds) && odds > 1 ? `${impliedCents(odds).toFixed(3)}c per $1 payout` : "n/a"}`);
  console.log(`stake limits: ${line.minStake ?? "n/a"} to ${line.maxStake ?? "n/a"}`);
}

async function freshLine(apiKey, eventId, marketUrl) {
  return fetchJson(`${API}/pub/v2/odds/lines`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ eventId: String(eventId), marketUrl }),
  });
}

async function pollUntilExecutable(apiKey, eventId, marketUrl, stake, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let line;
  let priorSignature = "";
  do {
    line = await freshLine(apiKey, eventId, marketUrl);
    const signature = `${line.status}|${line.price}|${line.minStake}|${line.maxStake}`;
    if (signature !== priorSignature) {
      console.log(`\nLive line at ${new Date().toISOString()}`);
      printLine(line);
      priorSignature = signature;
    }
    if (selectionIsExecutable(line, stake)) return line;
    if (Date.now() >= deadline) return line;
    await sleep(750);
  } while (true);
}

async function pollBetStatus(apiKey, referenceId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = { referenceId, status: "PENDING_ACCEPTANCE" };
  do {
    await sleep(500);
    const { response, body } = await requestJson(`${API}/pub/v3/bets/${referenceId}/status`, {
      // Cloudbet's status endpoint accepts GET. Do not use the old adapter's empty POST,
      // which receives HTTP 405 and loses the final acceptance/rejection state.
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    if (response.ok) {
      last = body;
      const status = String(body.status || "").toUpperCase();
      if (TERMINAL_STATUSES.has(status) || (status && status !== "PENDING_ACCEPTANCE")) return body;
    }
  } while (Date.now() < deadline);
  return last;
}

function printHelp() {
  console.log(`Cloudbet Chicago Cubs moneyline test

Dry run (default):
  node scripts/cloudbet-buy-cubs.cjs

Submit one live $1.01 bet:
  node scripts/cloudbet-buy-cubs.cjs --execute-live

Options:
  --stake=1.01             Stake in CLOUDBET_CURRENCY (default 1.01)
  --min-odds=1.01          Lowest acceptable decimal odds
  --opponent=nationals     Opponent name pattern
  --event-id=35811301      Pin an exact Cloudbet event
  --wait-seconds=0         Wait for a suspended live line to reopen
  --status-timeout=30      Maximum pending-status polling time

The script never retries bet placement. A pending bet keeps the same reference ID.`);
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  loadEnvLocal();
  const executeLive = process.argv.includes("--execute-live");
  const apiKey = requireEnv("CLOUDBET_API_KEY");
  const currency = process.env.CLOUDBET_CURRENCY?.trim() || "USDC";
  const stake = Number(argValue("--stake", "1.01"));
  const minOdds = Number(argValue("--min-odds", "1.01"));
  const opponent = argValue("--opponent", "nationals");
  const eventIdArg = argValue("--event-id", "");
  const waitSeconds = Number(argValue("--wait-seconds", "0"));
  const statusTimeout = Number(argValue("--status-timeout", "30"));

  if (!Number.isFinite(stake) || stake <= 0) throw new Error("--stake must be a positive number");
  if (!Number.isFinite(minOdds) || minOdds <= 1) throw new Error("--min-odds must be greater than 1.00");
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error("--wait-seconds must be zero or greater");
  if (!Number.isFinite(statusTimeout) || statusTimeout < 1) throw new Error("--status-timeout must be at least 1 second");

  const authHeaders = { "X-API-Key": apiKey, Accept: "application/json" };
  const [balanceBody, oddsBody] = await Promise.all([
    fetchJson(`${API}/pub/v1/account/currencies/${encodeURIComponent(currency)}/balance`, { headers: authHeaders }),
    fetchJson(`${API}/pub/v2/odds/competitions/${COMPETITION}?markets=${MARKET}`, { headers: authHeaders }),
  ]);

  const balance = Number(balanceBody.amount);
  if (!Number.isFinite(balance)) throw new Error(`Could not read ${currency} balance`);
  if (balance < stake) throw new Error(`Insufficient ${currency}: balance ${balance}, stake ${stake}`);

  const opponentPattern = new RegExp(opponent, "i");
  const candidates = (oddsBody.events || []).filter((event) => {
    const teams = `${event.home?.name || ""} ${event.away?.name || ""}`;
    return /cubs|chicago cubs|chc/i.test(teams) && opponentPattern.test(teams) && (!eventIdArg || String(event.id) === eventIdArg);
  });
  if (candidates.length !== 1) {
    const ids = candidates.map((event) => `${event.id}: ${event.away?.name} @ ${event.home?.name}`).join(", ");
    throw new Error(`Expected one Cubs event; found ${candidates.length}${ids ? ` (${ids})` : ""}. Use --event-id or --opponent.`);
  }

  const event = candidates[0];
  const cubsAreHome = /cubs|chicago cubs|chc/i.test(event.home?.name || "");
  const cubsOutcome = cubsAreHome ? "home" : "away";
  const feedSelection = allSelections(event).find((selection) => selection.outcome === cubsOutcome && selection.side === "BACK");
  if (!feedSelection) throw new Error("Could not find the Cubs BACK moneyline selection");
  const marketUrl = feedSelection.marketUrl || `${MARKET}/${cubsOutcome}`;

  console.log("Cloudbet Chicago Cubs moneyline");
  console.log(`mode: ${executeLive ? "LIVE — one submission" : "DRY RUN — not submitted"}`);
  console.log(`event: ${event.away?.name || "Away"} @ ${event.home?.name || "Home"} (${event.id})`);
  console.log(`event status: ${event.status || "unknown"}`);
  console.log(`marketUrl: ${marketUrl}`);
  console.log(`stake: ${stake.toFixed(6)} ${currency}`);
  console.log(`balance: ${balance.toFixed(6)} ${currency}`);

  const line = await pollUntilExecutable(apiKey, event.id, marketUrl, stake, waitSeconds);
  if (!selectionIsExecutable(line, stake)) {
    throw new Error(`Cubs line is not executable: status=${line.status}, price=${line.price}, limits=${line.minStake}-${line.maxStake}`);
  }
  const price = Number(line.price);
  if (price < minOdds) throw new Error(`Current odds ${price.toFixed(4)} are below --min-odds ${minOdds.toFixed(4)}`);

  if (!executeLive) {
    console.log("\nDry run complete. Add --execute-live to submit exactly one bet at this line or better.");
    return;
  }

  const referenceId = crypto.randomUUID();
  const body = {
    referenceId,
    currency,
    eventId: String(event.id),
    marketUrl,
    price: price.toFixed(4),
    stake: stake.toFixed(6),
    acceptPriceChange: "BETTER",
  };
  const submittedAt = Date.now();
  const { response, body: placed } = await requestJson(`${API}/pub/v3/bets/place`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`\nSubmission HTTP ${response.status} in ${Date.now() - submittedAt}ms`);
  console.log(`referenceId: ${referenceId}`);
  console.log(JSON.stringify(placed, null, 2));
  if (!response.ok) throw new Error(`Cloudbet placement failed with HTTP ${response.status}; do not resubmit this reference ID`);

  const initialStatus = String(placed.status || "").toUpperCase();
  const final = initialStatus === "PENDING_ACCEPTANCE"
    ? await pollBetStatus(apiKey, referenceId, statusTimeout)
    : placed;
  console.log("\nFinal Cloudbet status:");
  console.log(JSON.stringify(final, null, 2));

  const afterBalance = await fetchJson(`${API}/pub/v1/account/currencies/${encodeURIComponent(currency)}/balance`, { headers: authHeaders });
  console.log(`balance after: ${Number(afterBalance.amount).toFixed(6)} ${currency}`);
}

main().catch((error) => {
  console.error(`Cloudbet Cubs bet not submitted/confirmed: ${error.message || String(error)}`);
  process.exitCode = 1;
});
