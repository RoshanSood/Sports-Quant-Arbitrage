const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "https://sports-api.cloudbet.com";
const COMPETITION = "baseball-usa-mlb";
const MARKET = "baseball.moneyline";

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
  const arg = process.argv.find((v) => v.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env.local`);
  return value;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

function allSelections(event) {
  const market = event.markets?.[MARKET];
  return Object.values(market?.submarkets || {}).flatMap((sub) => sub.selections || []);
}

function enabled(selection) {
  return (!selection.status || selection.status === "SELECTION_ENABLED") && Number(selection.price) > 1;
}

function eventMatches(event, opponentPattern) {
  const teams = `${event.home?.name || ""} ${event.away?.name || ""}`;
  return /cardinals|stl|st\. louis/i.test(teams) && opponentPattern.test(teams);
}

async function main() {
  loadEnvLocal();
  const executeLive = process.argv.includes("--execute-live");
  const apiKey = requireEnv("CLOUDBET_API_KEY");
  const currency = process.env.CLOUDBET_CURRENCY?.trim() || "USDC";
  const stake = Number(argValue("--stake", "2"));
  const minOdds = Number(argValue("--min-odds", "1.01"));
  const opponent = argValue("--opponent", "angels");
  const opponentPattern = new RegExp(opponent, "i");
  if (!Number.isFinite(stake) || stake <= 0) throw new Error("--stake must be a positive number");
  if (!Number.isFinite(minOdds) || minOdds < 1.01) throw new Error("--min-odds must be at least 1.01");

  const [balanceBody, oddsBody] = await Promise.all([
    fetchJson(`${API}/pub/v1/account/currencies/${encodeURIComponent(currency)}/balance`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    }),
    fetchJson(`${API}/pub/v2/odds/competitions/${COMPETITION}?markets=${MARKET}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    }),
  ]);
  const balance = Number(balanceBody.amount);
  if (!Number.isFinite(balance)) throw new Error(`Could not read ${currency} balance`);
  if (balance < stake) throw new Error(`Insufficient ${currency}: balance ${balance}, stake ${stake}`);

  const event = (oddsBody.events || []).find((e) => eventMatches(e, opponentPattern));
  if (!event) throw new Error(`Could not find Cloudbet Cardinals event matching opponent "${opponent}"`);

  const cardsAreHome = /cardinals|stl|st\. louis/i.test(event.home?.name || "");
  const cardsOutcome = cardsAreHome ? "home" : "away";
  const selection = allSelections(event).find((s) => s.outcome === cardsOutcome && s.side === "BACK");
  if (!selection) throw new Error("Could not find Cardinals BACK moneyline selection");
  if (!enabled(selection)) {
    throw new Error(
      `Cloudbet Cardinals moneyline is not currently bettable: status=${selection.status || "unknown"}, price=${selection.price || 0}`
    );
  }
  const price = Number(selection.price);
  if (price < minOdds) throw new Error(`Current odds ${price} are below --min-odds ${minOdds}`);
  if (selection.minStake && stake < Number(selection.minStake)) throw new Error(`Stake ${stake} is below minStake ${selection.minStake}`);

  const referenceId = crypto.randomUUID();
  const body = {
    referenceId,
    currency,
    eventId: String(event.id),
    marketUrl: `${MARKET}/${cardsOutcome}`,
    price: price.toFixed(4),
    stake: stake.toFixed(6),
    acceptPriceChange: "BETTER",
  };

  console.log("Cloudbet Cardinals moneyline");
  console.log(`mode: ${executeLive ? "LIVE SUBMIT" : "DRY RUN - not submitted"}`);
  console.log(`event: ${event.away?.name || "Away"} @ ${event.home?.name || "Home"} (${event.id})`);
  console.log(`event status: ${event.status || "unknown"}`);
  console.log(`marketUrl: ${body.marketUrl}`);
  console.log(`odds: ${price.toFixed(4)}`);
  console.log(`stake: ${stake.toFixed(6)} ${currency}`);
  console.log(`balance: ${balance.toFixed(6)} ${currency}`);
  console.log(`referenceId: ${referenceId}`);

  if (!executeLive) {
    console.log("Add --execute-live to submit this bet.");
    return;
  }

  const result = await fetchJson(`${API}/pub/v3/bets/place`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  console.log("submitted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
