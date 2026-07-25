const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { ChainId, OrderBuilder, Side } = require("@predictdotfun/sdk");

const API = "https://api.predict.fun";
const SPORTS_VARIANT = "SPORTS_TEAM_MATCH";
const TEAM_PATTERN = /^(KC|Kansas City Royals)$/i;

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

function pickString(body, paths) {
  for (const parts of paths) {
    let current = body;
    for (const part of parts) current = current && typeof current === "object" ? current[part] : undefined;
    if (typeof current === "string" && current.trim()) return current.trim();
  }
  return null;
}

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, cache: "no-store" });
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

async function predictJwt(apiKey, signer, predictAccount, builder) {
  const msgBody = await fetchJson(`${API}/v1/auth/message`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  const message = pickString(msgBody, [["data", "message"], ["message"], ["data"]]);
  if (!message) throw new Error("predict.fun auth message missing");

  const signature = predictAccount ? await builder.signPredictAccountMessage(message) : await signer.signMessage(message);
  const attempts = predictAccount
    ? [
        { signer: predictAccount, signature, message },
        { signer: signer.address, account: predictAccount, signature, message },
      ]
    : [{ signer: signer.address, signature, message }];

  let lastError = "auth failed";
  for (const data of attempts) {
    try {
      const authBody = await fetchJson(`${API}/v1/auth`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      });
      const token = pickString(authBody, [["data", "token"], ["token"]]);
      if (token) return token;
      lastError = "predict.fun auth response missing token";
    } catch (e) {
      lastError = String(e).slice(0, 200);
    }
  }
  throw new Error(lastError);
}

function isTargetMarket(market, opponentPattern) {
  const title = String(market.title || "");
  return /Kansas City Royals/i.test(title) && opponentPattern.test(title);
}

async function findMarket(apiKey, opponent) {
  const body = await fetchJson(`${API}/v1/markets?status=OPEN&first=200&marketVariant=${SPORTS_VARIANT}`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  const opponentPattern = new RegExp(opponent, "i");
  const markets = (body.data || []).filter((m) => isTargetMarket(m, opponentPattern));
  if (!markets.length) throw new Error(`No open predict.fun KC moneyline market found for opponent "${opponent}"`);

  // Prefer the tightest/current-looking market: lowest KC ask, then highest available ask size.
  markets.sort((a, b) => {
    const aKc = (a.outcomes || []).find((o) => TEAM_PATTERN.test(o.name || ""));
    const bKc = (b.outcomes || []).find((o) => TEAM_PATTERN.test(o.name || ""));
    const aPrice = Number(aKc?.bestAsk?.price ?? Infinity);
    const bPrice = Number(bKc?.bestAsk?.price ?? Infinity);
    if (aPrice !== bPrice) return aPrice - bPrice;
    return Number(bKc?.bestAsk?.size ?? 0) - Number(aKc?.bestAsk?.size ?? 0);
  });

  return markets[0];
}

function normalizeBook(marketId, body) {
  const data = body?.data && typeof body.data === "object" ? body.data : body;
  if (!Array.isArray(data?.asks) || !Array.isArray(data?.bids)) return null;
  const toLevels = (levels) =>
    levels
      .map((level) => {
        if (!Array.isArray(level) || level.length < 2) return null;
        const price = Number(level[0]);
        const qty = Number(level[1]);
        return Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0 ? [price, qty] : null;
      })
      .filter(Boolean);
  return {
    marketId: Number(marketId),
    updateTimestampMs: Number(data.updateTimestampMs ?? Date.now()),
    asks: toLevels(data.asks).sort((a, b) => a[0] - b[0]),
    bids: toLevels(data.bids).sort((a, b) => b[0] - a[0]),
  };
}

async function orderbook(apiKey, marketId) {
  const body = await fetchJson(`${API}/v1/markets/${marketId}/orderbook`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  const book = normalizeBook(marketId, body);
  if (!book || !book.asks.length) throw new Error("predict.fun orderbook has no ask liquidity");
  return book;
}

async function main() {
  loadEnvLocal();

  const executeLive = process.argv.includes("--execute-live");
  const spendUsd = Number(argValue("--spend", "1"));
  const sharesArg = argValue("--shares", null);
  const fixedShares = sharesArg == null ? null : Number(sharesArg);
  const maxPrice = Number(argValue("--max-price", "0.45"));
  const opponent = argValue("--opponent", "Detroit");
  const predictAccount = argValue("--account", process.env.PREDICTFUN_ACCOUNT || "").trim() || undefined;

  if (!Number.isFinite(spendUsd) || spendUsd <= 0) throw new Error("--spend must be a positive number");
  if (fixedShares != null && (!Number.isFinite(fixedShares) || fixedShares <= 0)) throw new Error("--shares must be a positive number");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 1) throw new Error("--max-price must be between 0 and 1");

  const apiKey = requireEnv("PREDICTFUN_API_KEY");
  const walletKey = requireEnv("PREDICTFUN_WALLET_KEY");
  const provider = new ethers.JsonRpcProvider(process.env.BNB_RPC_URL || "https://bsc-dataseed.binance.org");
  const signer = new ethers.Wallet(walletKey, provider);
  const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer, predictAccount ? { predictAccount } : undefined);

  const market = await findMarket(apiKey, opponent);
  if (!market || market.tradingStatus !== "OPEN") throw new Error(`Market ${market?.id || "unknown"} is not OPEN`);

  const outcome = (market.outcomes || []).find((o) => TEAM_PATTERN.test(o.name || ""));
  if (!outcome?.onChainId || !outcome.bestAsk?.price) throw new Error("Could not find a live KC ask");

  const price = Number(outcome.bestAsk.price);
  const availableShares = Number(outcome.bestAsk.size ?? 0);
  if (!Number.isFinite(price) || price <= 0 || price > maxPrice) {
    throw new Error(`Current KC ask ${price} exceeds --max-price ${maxPrice}`);
  }

  const shares = fixedShares ?? Number((spendUsd / price).toFixed(6));
  if (shares < 2) throw new Error(`predict.fun minimum order is 2 shares; $${spendUsd} buys only ${shares}`);
  if (availableShares > 0 && shares > availableShares) {
    throw new Error(`Only ${availableShares} KC shares are available at the current ask; requested ${shares}`);
  }

  const balance = Number(ethers.formatUnits(await builder.balanceOf(), 18));
  const maxCost = Number((price * shares).toFixed(6));
  if (balance < maxCost) throw new Error(`Insufficient predict.fun USDT: balance ${balance}, needed ${maxCost}`);

  const book = await orderbook(apiKey, market.id);
  const amounts = builder.getMarketOrderAmounts(
    {
      side: Side.BUY,
      quantityWei: ethers.parseUnits(String(shares), 18),
    },
    book
  );
  const lastPrice = Number(ethers.formatUnits(amounts.lastPrice, 18));
  if (!Number.isFinite(lastPrice) || lastPrice > maxPrice) {
    throw new Error(`Current KC ask ladder ends at ${lastPrice}; exceeds --max-price ${maxPrice}`);
  }

  const order = builder.buildOrder("MARKET", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    feeRateBps: BigInt(market.feeRateBps ?? 200),
  });

  const typed = builder.buildTypedData(order, {
    isNegRisk: Boolean(market.isNegRisk),
    isYieldBearing: market.isYieldBearing !== false,
  });
  const signed = await builder.signTypedDataOrder(typed);
  const hash = builder.buildTypedDataHash(typed);
  const jwt = await predictJwt(apiKey, signer, predictAccount, builder);

  console.log("predict.fun Kansas City Royals moneyline buy");
  console.log(`mode: ${executeLive ? "LIVE SUBMIT" : "DRY RUN - not submitted"}`);
  console.log(`signer: ${signer.address}`);
  console.log(`predict account: ${predictAccount || signer.address}`);
  console.log(`market: ${market.title} (${market.id})`);
  console.log(`outcome: ${outcome.name}`);
  console.log(`limit price: ${price}`);
  console.log(`available shares at ask: ${availableShares}`);
  console.log(`shares: ${shares}`);
  console.log(`max cost: $${maxCost.toFixed(6)} USDT`);
  console.log(`account balance: $${balance.toFixed(6)} USDT`);
  console.log(`order hash: ${hash}`);

  if (!executeLive) {
    console.log("Add --execute-live to submit this order.");
    return;
  }

  const result = await fetchJson(`${API}/v1/orders`, {
    method: "POST",
    headers: { "x-api-key": apiKey, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      data: {
        order: { ...signed, hash },
        pricePerShare: amounts.pricePerShare.toString(),
        strategy: "MARKET",
        isFillOrKill: true,
        slippageBps: Number(amounts.slippageBps),
      },
    }),
  });
  console.log("submitted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
