const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");
const { ClobClient, OrderType, Side, SignatureTypeV2 } = require("@polymarket/clob-client-v2");

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;
const TEAM_NAME = "Washington Nationals";
const TEAM_PATTERN = /washington nationals|nationals|\bwas\b|\bwsn\b/i;
const EVENT_PATTERN = /washington nationals|nationals|\bwas\b|\bwsn\b/i;

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

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateOnly(value) {
  return String(value || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
}

function slugDate(slug) {
  return String(slug || "").match(/(\d{4}-\d{2}-\d{2})(?:$|-)/)?.[1] || null;
}

function polymarketGameDate(event) {
  return (
    dateOnly(event.eventDate) ||
    dateOnly(event.startTime) ||
    slugDate(event.slug) ||
    (event.markets || []).map((m) => dateOnly(m.gameStartTime)).find(Boolean) ||
    (event.markets || []).map((m) => slugDate(m.slug)).find(Boolean) ||
    null
  );
}

function eventMatchesDate(event, gameDate) {
  return polymarketGameDate(event) === gameDate;
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

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeQuestion(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function classifyMoneyline(event, market) {
  const question = String(market.question || "").toLowerCase();
  const outcomes = parseJsonArray(market.outcomes);
  return (
    normalizeQuestion(market.question) === normalizeQuestion(event.title) &&
    outcomes.length === 2 &&
    !question.includes("inning") &&
    !question.includes("run") &&
    !question.includes("hit") &&
    !question.includes("strikeout") &&
    !question.includes("score") &&
    !/spread|o\/u|over|under/.test(question)
  );
}

function marketHasLivePrices(market) {
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  return prices.some((p) => Number.isFinite(p) && p > 0 && p < 1) || Number(market.bestAsk) > 0;
}

async function findNationalsMoneyline(gameDate) {
  const params = new URLSearchParams({ tag_slug: "mlb", closed: "false", limit: "200" });
  const eventsBody = await fetchJson(`${GAMMA_API}/events?${params}`, { headers: { Accept: "application/json" } });
  const events = (Array.isArray(eventsBody) ? eventsBody : eventsBody.events || [])
    .filter((event) => EVENT_PATTERN.test(String(event.title || "")))
    .filter((event) => eventMatchesDate(event, gameDate))
    .filter((event) => (event.markets || []).some(marketHasLivePrices));
  if (!events.length) throw new Error(`Could not find a live ${TEAM_NAME} Polymarket event for ${gameDate}`);

  const event = events
    .slice()
    .sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")))[0];
  const market = (event.markets || []).find((m) => classifyMoneyline(event, m));
  if (!market) throw new Error(`Could not find moneyline market in event: ${event.title}`);

  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  let tokenIds = parseJsonArray(market.clobTokenIds);
  if (!tokenIds.length && Array.isArray(market.tokens)) tokenIds = market.tokens.map((token) => token.token_id);

  const index = outcomes.findIndex((outcome) => TEAM_PATTERN.test(String(outcome)));
  if (index < 0) throw new Error(`Could not identify ${TEAM_NAME} outcome. Outcomes: ${outcomes.join(", ")}`);

  const bestAsk = Number(market.bestAsk);
  const bestBid = Number(market.bestBid);
  let price;
  if (index === 0 && Number.isFinite(bestAsk) && bestAsk > 0) price = bestAsk;
  else if (index === 1 && Number.isFinite(bestBid) && bestBid > 0) price = 1 - bestBid;
  else price = prices[index];

  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error(`Could not read a live ${TEAM_NAME} ask price from ${market.question}`);
  }
  const tokenID = tokenIds[index];
  if (!tokenID) throw new Error(`Could not read ${TEAM_NAME} CLOB token id`);

  return { event, market, outcome: outcomes[index], tokenID, price };
}

function signatureType() {
  const v = Number(process.env.POLYMARKET_SIG_TYPE);
  if (v === 1) return SignatureTypeV2.POLY_PROXY;
  if (v === 2) return SignatureTypeV2.POLY_GNOSIS_SAFE;
  if (v === 3) return SignatureTypeV2.POLY_1271;
  return SignatureTypeV2.EOA;
}

function clobSignerShim(wallet) {
  return {
    _signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
    getAddress: () => wallet.getAddress(),
  };
}

function funderFor(wallet) {
  const raw = process.env.POLYMARKET_FUNDER?.trim() || process.env.POLYMARKET_DEPOSIT_WALLET?.trim();
  const match = raw?.match(/^0x[a-fA-F0-9]{40}/);
  if (match) return match[0];
  if (raw) console.log(`Ignoring invalid POLYMARKET_FUNDER/POLYMARKET_DEPOSIT_WALLET value: ${raw}`);
  return wallet.address;
}

async function buildClient(walletKey) {
  const wallet = new Wallet(walletKey);
  const signer = clobSignerShim(wallet);
  const funderAddress = funderFor(wallet);
  const signatureTypeValue = signatureType();
  console.log(`funder: ${funderAddress}`);
  console.log(`signatureType: ${signatureTypeValue}`);
  const l1 = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID,
    signer,
    signatureType: signatureTypeValue,
    funderAddress,
  });
  const creds = await l1.createOrDeriveApiKey();
  return new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID,
    signer,
    creds,
    signatureType: signatureTypeValue,
    funderAddress,
  });
}

function friendlyPolymarketError(result) {
  const message = String(result?.error || result?.errorMsg || "");
  if (/maker address not allowed|deposit wallet flow/i.test(message)) {
    return [
      "Polymarket rejected direct EOA/MetaMask CLOB order placement.",
      "Use POLYMARKET_SIG_TYPE=3 with POLYMARKET_FUNDER/POLYMARKET_DEPOSIT_WALLET set to the deposit wallet.",
    ].join(" ");
  }
  return message || `Polymarket order failed (${result?.status || "unknown"})`;
}

function privateKey() {
  const raw = requireEnv("POLYMARKET_WALLET_KEY");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function floorTo(value, decimals) {
  const scale = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * scale) / scale;
}

async function main() {
  loadEnvLocal();

  if (process.env.POLYMARKET_REGION === "us") {
    throw new Error("This helper is for international Polymarket CLOB. POLYMARKET_REGION=us uses different credentials/API.");
  }

  const executeLive = process.argv.includes("--execute-live");
  const spendUsd = Number(argValue("--spend", "1"));
  const gameDate = argValue("--date", localDateStr());
  const maxPriceArg = argValue("--max-price", null);
  const maxPrice = maxPriceArg == null ? null : Number(maxPriceArg);
  if (!Number.isFinite(spendUsd) || spendUsd <= 0) throw new Error("--spend must be a positive number");
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice >= 1)) {
    throw new Error("--max-price must be between 0 and 1");
  }

  const { event, market, outcome, tokenID, price } = await findNationalsMoneyline(gameDate);
  if (maxPrice != null && price > maxPrice) throw new Error(`Current ${TEAM_NAME} ask ${price} exceeds --max-price ${maxPrice}`);

  const limitPrice = maxPrice ?? price;
  const amount = floorTo(spendUsd, 2);
  const estimatedShares = floorTo(amount / limitPrice, 5);
  const walletKey = privateKey();

  console.log(`Polymarket ${TEAM_NAME} moneyline buy`);
  console.log(`mode: ${executeLive ? "LIVE SUBMIT" : "DRY RUN - not submitted"}`);
  console.log(`event: ${event.title}`);
  console.log(`event date: ${polymarketGameDate(event)}`);
  console.log(`requested date: ${gameDate}`);
  console.log(`market: ${market.question} (${market.id})`);
  console.log(`outcome: ${outcome}`);
  console.log(`tokenID: ${tokenID}`);
  console.log(`current ask: ${price.toFixed(4)}`);
  console.log(`max price: ${limitPrice.toFixed(4)}`);
  console.log(`estimated shares: ${estimatedShares.toFixed(5)}`);
  console.log(`max cost: $${amount.toFixed(2)} USDC`);

  if (!executeLive) {
    console.log("Add --execute-live to submit this FOK order.");
    return;
  }

  const client = await buildClient(walletKey);
  const signed = await client.createMarketOrder({
    tokenID,
    amount,
    price: limitPrice,
    side: Side.BUY,
    orderType: OrderType.FOK,
  });
  const result = await client.postOrder(signed, OrderType.FOK);
  if (result?.error || result?.errorMsg || result?.success === false) {
    throw new Error(friendlyPolymarketError(result));
  }
  console.log("submitted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
