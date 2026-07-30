const fs = require("fs");
const path = require("path");
const { Wallet, ZeroAddress, ZeroHash, hexlify, parseUnits, randomBytes } = require("ethers");

const SX_API = "https://api.sx.bet";
const SX_CHAIN_ID = 4162;
const SX_FILL_URL = `${SX_API}/orders/fill/v2`;
const USDC_DECIMALS = 1e6;
const MLB_LEAGUE_ID = 171;
const TYPE_MONEYLINE = 226;
const TYPE_TWO_WAY = 52;
const TEAM_NAME = "St. Louis Cardinals";
const TEAM_PATTERN = /st\.?\s*louis cardinals|cardinals|\bstl\b/i;

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

function sxGameDate(market) {
  const gameTime = Number(market.gameTime);
  if (!Number.isFinite(gameTime)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(gameTime * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env.local`);
  return value;
}

function privateKey() {
  const raw = requireEnv("SXBET_WALLET_KEY");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
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

async function fetchMetadata() {
  const json = await fetchJson(`${SX_API}/metadata`, { cache: "no-store", headers: { Accept: "application/json" } });
  const data = json.data || {};
  const addresses = data.addresses || {};
  const chain = addresses[String(SX_CHAIN_ID)] || {};
  const meta = {
    usdcAddress: chain.USDC || data.USDCAddress,
    eip712FillHasher: data.EIP712FillHasher || data.eip712FillHasher,
    domainVersion: data.domainVersion || data.EIP712Version,
  };
  if (!meta.usdcAddress || !meta.eip712FillHasher || !meta.domainVersion) {
    throw new Error("SX /metadata missing USDC, EIP712FillHasher, or domain version");
  }
  return meta;
}

async function fetchMarkets() {
  const url = `${SX_API}/markets/active?leagueId=${MLB_LEAGUE_ID}&onlyMainLine=true`;
  const json = await fetchJson(url, { cache: "no-store", headers: { Accept: "application/json" } });
  return json.data?.markets || [];
}

async function fetchOrders(marketHash) {
  const json = await fetchJson(`${SX_API}/orders?marketHashes=${encodeURIComponent(marketHash)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  return json.data || [];
}

function findCubsMoneyline(markets, gameDate) {
  const hits = markets.filter((m) => {
    const typeOk = m.type === TYPE_MONEYLINE || m.type === TYPE_TWO_WAY;
    const teamOk = TEAM_PATTERN.test(String(m.teamOneName || "")) || TEAM_PATTERN.test(String(m.teamTwoName || ""));
    return typeOk && teamOk && sxGameDate(m) === gameDate;
  });
  if (!hits.length) throw new Error(`Could not find a ${TEAM_NAME} SX.bet moneyline for ${gameDate}`);
  return hits.sort((a, b) => String(a.gameTime || "").localeCompare(String(b.gameTime || "")))[0];
}

function bestTakerQuote(orders, takerWantsOutcomeOne, maxPriceCents) {
  let best = null;
  for (const order of orders) {
    if (Boolean(order.isMakerBettingOutcomeOne) === takerWantsOutcomeOne) continue;
    const rawProb = Number(order.percentageOdds);
    const total = Number(order.totalBetSize);
    const filled = Number(order.fillAmount);
    if (!Number.isFinite(rawProb) || !Number.isFinite(total) || !Number.isFinite(filled)) continue;
    const availableMicroUsd = total - filled;
    if (availableMicroUsd <= 0) continue;
    const makerProb = rawProb / 1e20;
    if (makerProb <= 0 || makerProb >= 1) continue;
    const takerPriceCents = (1 - makerProb) * 100;
    if (takerPriceCents > maxPriceCents) continue;
    if (!best || takerPriceCents < best.priceCents) {
      best = {
        priceCents: takerPriceCents,
        availableUsd: availableMicroUsd / USDC_DECIMALS,
      };
    } else if (Math.abs(takerPriceCents - best.priceCents) < 1e-9) {
      best.availableUsd += availableMicroUsd / USDC_DECIMALS;
    }
  }
  return best;
}

function orderbookSummary(orders) {
  const summary = { buyOutcomeOneUsd: 0, buyOutcomeTwoUsd: 0, buyOutcomeOneBestCents: null, buyOutcomeTwoBestCents: null };
  for (const order of orders) {
    const total = Number(order.totalBetSize);
    const filled = Number(order.fillAmount);
    const makerProb = Number(order.percentageOdds) / 1e20;
    if (!Number.isFinite(total) || !Number.isFinite(filled) || !Number.isFinite(makerProb)) continue;
    const availableUsd = (total - filled) / USDC_DECIMALS;
    if (availableUsd <= 0 || makerProb <= 0 || makerProb >= 1) continue;
    const takerPriceCents = (1 - makerProb) * 100;
    if (order.isMakerBettingOutcomeOne) {
      summary.buyOutcomeTwoUsd += availableUsd;
      if (summary.buyOutcomeTwoBestCents == null || takerPriceCents < summary.buyOutcomeTwoBestCents) {
        summary.buyOutcomeTwoBestCents = takerPriceCents;
      }
    } else {
      summary.buyOutcomeOneUsd += availableUsd;
      if (summary.buyOutcomeOneBestCents == null || takerPriceCents < summary.buyOutcomeOneBestCents) {
        summary.buyOutcomeOneBestCents = takerPriceCents;
      }
    }
  }
  return summary;
}

function formatBookSide(usd, cents) {
  if (usd <= 0 || cents == null) return "$0.00";
  return `$${usd.toFixed(2)} at ${cents.toFixed(4)}c`;
}

function desiredOddsFor(limitPriceCents) {
  return parseUnits((limitPriceCents / 100).toFixed(6), 20).toString();
}

function buildFillTypedData({ stakeWei, marketHash, baseToken, desiredOdds, oddsSlippage, isTakerBettingOutcomeOne, fillSalt, domainVersion, verifyingContract }) {
  const domain = {
    name: "SX Bet",
    version: domainVersion,
    chainId: SX_CHAIN_ID,
    verifyingContract,
  };
  const types = {
    Details: [
      { name: "action", type: "string" },
      { name: "market", type: "string" },
      { name: "betting", type: "string" },
      { name: "stake", type: "string" },
      { name: "worstOdds", type: "string" },
      { name: "worstReturning", type: "string" },
      { name: "fills", type: "FillObject" },
    ],
    FillObject: [
      { name: "stakeWei", type: "string" },
      { name: "marketHash", type: "string" },
      { name: "baseToken", type: "string" },
      { name: "desiredOdds", type: "string" },
      { name: "oddsSlippage", type: "uint256" },
      { name: "isTakerBettingOutcomeOne", type: "bool" },
      { name: "fillSalt", type: "uint256" },
      { name: "beneficiary", type: "address" },
      { name: "beneficiaryType", type: "uint8" },
      { name: "cashOutTarget", type: "bytes32" },
    ],
  };
  const message = {
    action: "N/A",
    market: marketHash,
    betting: "N/A",
    stake: "N/A",
    worstOdds: "N/A",
    worstReturning: "N/A",
    fills: {
      stakeWei,
      marketHash,
      baseToken,
      desiredOdds,
      oddsSlippage,
      isTakerBettingOutcomeOne,
      fillSalt,
      beneficiary: ZeroAddress,
      beneficiaryType: 0,
      cashOutTarget: ZeroHash,
    },
  };
  return { domain, types, message };
}

async function main() {
  loadEnvLocal();

  const executeLive = process.argv.includes("--execute-live");
  const gameDate = argValue("--date", localDateStr());
  const spendUsd = Number(argValue("--spend", "1"));
  const maxPriceArg = argValue("--max-price-cents", argValue("--max-price", "99"));
  const maxPriceCents = Number(maxPriceArg) <= 1 ? Number(maxPriceArg) * 100 : Number(maxPriceArg);
  if (!Number.isFinite(spendUsd) || spendUsd < 1) throw new Error("--spend must be at least 1 for SX.bet");
  if (!Number.isFinite(maxPriceCents) || maxPriceCents <= 0 || maxPriceCents >= 100) {
    throw new Error("--max-price-cents must be between 0 and 100");
  }

  const markets = await fetchMarkets();
  const market = findCubsMoneyline(markets, gameDate);
  const cubsAreOutcomeOne = TEAM_PATTERN.test(String(market.teamOneName || ""));
  const orders = await fetchOrders(market.marketHash);
  const quote = bestTakerQuote(orders, cubsAreOutcomeOne, maxPriceCents);
  if (!quote) {
    const book = orderbookSummary(orders);
    const cubsSide = cubsAreOutcomeOne
      ? formatBookSide(book.buyOutcomeOneUsd, book.buyOutcomeOneBestCents)
      : formatBookSide(book.buyOutcomeTwoUsd, book.buyOutcomeTwoBestCents);
    const otherSide = cubsAreOutcomeOne
      ? formatBookSide(book.buyOutcomeTwoUsd, book.buyOutcomeTwoBestCents)
      : formatBookSide(book.buyOutcomeOneUsd, book.buyOutcomeOneBestCents);
    throw new Error(
      [
        `No fillable ${TEAM_NAME} order at ${maxPriceCents.toFixed(2)}c or better.`,
        `Market: ${market.teamOneName} vs ${market.teamTwoName} (${market.marketHash})`,
        `${TEAM_NAME} liquidity: ${cubsSide}`,
        `Other side liquidity: ${otherSide}`,
      ].join("\n")
    );
  }
  if (quote.availableUsd + 1e-9 < spendUsd) {
    throw new Error(`Only $${quote.availableUsd.toFixed(2)} fillable at ${quote.priceCents.toFixed(2)}c; need $${spendUsd.toFixed(2)}`);
  }

  const limitPriceCents = Math.min(maxPriceCents, quote.priceCents);
  const estimatedContracts = spendUsd / (limitPriceCents / 100);

  console.log(`SX.bet ${TEAM_NAME} moneyline buy`);
  console.log(`mode: ${executeLive ? "LIVE SUBMIT" : "DRY RUN - not submitted"}`);
  console.log(`date: ${gameDate}`);
  console.log(`game date: ${sxGameDate(market)}`);
  console.log(`market: ${market.teamOneName} vs ${market.teamTwoName}`);
  console.log(`marketHash: ${market.marketHash}`);
  console.log(`outcome: ${cubsAreOutcomeOne ? market.outcomeOneName : market.outcomeTwoName}`);
  console.log(`side: ${cubsAreOutcomeOne ? "one" : "two"}`);
  console.log(`best taker price: ${quote.priceCents.toFixed(4)}c`);
  console.log(`max price: ${limitPriceCents.toFixed(4)}c`);
  console.log(`available at price: $${quote.availableUsd.toFixed(2)}`);
  console.log(`estimated contracts: ${estimatedContracts.toFixed(5)}`);
  console.log(`stake: $${spendUsd.toFixed(2)} USDC`);

  if (!executeLive) {
    console.log("Add --execute-live to submit this fill.");
    return;
  }

  const wallet = new Wallet(privateKey());
  const meta = await fetchMetadata();
  const stakeWei = parseUnits(spendUsd.toFixed(6), 6).toString();
  const desiredOdds = desiredOddsFor(limitPriceCents);
  const fillSalt = BigInt(hexlify(randomBytes(32))).toString();
  const oddsSlippage = Number(process.env.SXBET_ODDS_SLIPPAGE || 0);
  const isTakerBettingOutcomeOne = cubsAreOutcomeOne;
  const typed = buildFillTypedData({
    stakeWei,
    marketHash: market.marketHash,
    baseToken: meta.usdcAddress,
    desiredOdds,
    oddsSlippage,
    isTakerBettingOutcomeOne,
    fillSalt,
    domainVersion: meta.domainVersion,
    verifyingContract: meta.eip712FillHasher,
  });
  const takerSig = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const body = {
    marketHash: market.marketHash,
    market: market.marketHash,
    baseToken: meta.usdcAddress,
    isTakerBettingOutcomeOne,
    stakeWei,
    desiredOdds,
    oddsSlippage,
    taker: wallet.address,
    takerSig,
    fillSalt,
    message: "N/A",
  };
  const result = await fetchJson(SX_FILL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (result.status === "failure") throw new Error(result.message || "SX fill rejected");
  console.log("submitted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
