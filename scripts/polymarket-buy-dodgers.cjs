const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");
const {
  ClobClient,
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
} = require("@polymarket/clob-client-v2");

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;
const TEAM_PATTERN = /dodgers|lad\b|la dodgers|los angeles dodgers/i;
const GAME_PATTERN = /dodgers.*phillies|phillies.*dodgers/i;

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

function eventMatchesDate(event, gameDate) {
  const start = String(event.startDate || "").slice(0, 10);
  const end = String(event.endDate || "").slice(0, 10);
  if (!start && !end) return false;
  return (!start || start <= gameDate) && (!end || end >= gameDate);
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

function classifyMoneyline(market) {
  const question = String(market.question || "").toLowerCase();
  const outcomes = parseJsonArray(market.outcomes);
  return (
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

async function findDodgersMoneyline(gameDate) {
  const params = new URLSearchParams({ tag_slug: "mlb", closed: "false", limit: "200" });
  const eventsBody = await fetchJson(`${GAMMA_API}/events?${params}`, { headers: { Accept: "application/json" } });
  const events = (Array.isArray(eventsBody) ? eventsBody : eventsBody.events || [])
    .filter((event) => GAME_PATTERN.test(String(event.title || "")))
    .filter((event) => eventMatchesDate(event, gameDate))
    .filter((event) => (event.markets || []).some(marketHasLivePrices));
  if (!events.length) throw new Error(`Could not find a live Dodgers/Phillies Polymarket event for ${gameDate}`);

  const event = events
    .slice()
    .sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")))[0];
  const market = (event.markets || []).find(classifyMoneyline);
  if (!market) throw new Error(`Could not find moneyline market in event: ${event.title}`);

  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  let tokenIds = parseJsonArray(market.clobTokenIds);
  if (!tokenIds.length && Array.isArray(market.tokens)) tokenIds = market.tokens.map((token) => token.token_id);

  const index = outcomes.findIndex((outcome) => TEAM_PATTERN.test(String(outcome)));
  if (index < 0) throw new Error(`Could not identify Dodgers outcome. Outcomes: ${outcomes.join(", ")}`);

  const bestAsk = Number(market.bestAsk);
  const bestBid = Number(market.bestBid);
  let price;
  if (index === 0 && Number.isFinite(bestAsk) && bestAsk > 0) price = bestAsk;
  else if (index === 1 && Number.isFinite(bestBid) && bestBid > 0) price = 1 - bestBid;
  else price = prices[index];

  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error(`Could not read a live Dodgers ask price from ${market.question}`);
  }
  const tokenID = tokenIds[index];
  if (!tokenID) throw new Error("Could not read Dodgers CLOB token id");

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
  const raw = process.env.POLYMARKET_FUNDER?.trim();
  const match = raw?.match(/^0x[a-fA-F0-9]{40}/);
  if (match) return match[0];
  if (raw) console.log(`Ignoring invalid POLYMARKET_FUNDER value: ${raw}`);
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
      "The current CLOB API is asking for the deposit-wallet flow instead of signatureType=0.",
      "You will not get an insufficient-funds error until this account is configured as a Polymarket deposit wallet/POLY_1271 flow.",
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
  const spendUsd = Number(argValue("--spend", "2"));
  const gameDate = argValue("--date", localDateStr());
  const maxPriceArg = argValue("--max-price", null);
  const maxPrice = maxPriceArg == null ? null : Number(maxPriceArg);
  if (!Number.isFinite(spendUsd) || spendUsd <= 0) throw new Error("--spend must be a positive number");
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice >= 1)) {
    throw new Error("--max-price must be between 0 and 1");
  }

  const { event, market, outcome, tokenID, price } = await findDodgersMoneyline(gameDate);
  if (maxPrice != null && price > maxPrice) throw new Error(`Current Dodgers ask ${price} exceeds --max-price ${maxPrice}`);

  const limitPrice = maxPrice ?? price;
  const amount = floorTo(spendUsd, 2);
  const estimatedShares = floorTo(amount / limitPrice, 5);
  const walletKey = privateKey();

  console.log("Polymarket Dodgers moneyline buy");
  console.log(`mode: ${executeLive ? "LIVE SUBMIT" : "DRY RUN - not submitted"}`);
  console.log(`event: ${event.title}`);
  console.log(`date: ${gameDate}`);
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
