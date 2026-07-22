const fs = require("fs");
const path = require("path");
const { Wallet, ZeroAddress, ZeroHash, ethers, hexlify, randomBytes } = require("ethers");

const SX_API = "https://api.sx.bet";
const SX_CHAIN_ID = 4162;
const MLB_LEAGUE_ID = 171;
const MONEYLINE_TYPE = 226;
const USDC_DECIMALS = 6;

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

function argValue(name, fallback) {
  const arg = process.argv.find((v) => v.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
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

function bestTakerPrice(orders, outcomeOne) {
  let best = null;
  for (const order of orders || []) {
    const availableWei = BigInt(order.totalBetSize || "0") - BigInt(order.fillAmount || "0");
    if (availableWei <= 0n) continue;
    const makerProb = Number(order.percentageOdds) / 1e20;
    if (makerProb <= 0 || makerProb >= 1) continue;
    const canBuyOutcomeOne = !order.isMakerBettingOutcomeOne;
    if (canBuyOutcomeOne !== outcomeOne) continue;
    const price = 1 - makerProb;
    const row = { price, liquidityUsd: Number(availableWei) / 1e6 };
    if (!best || row.price < best.price) best = row;
  }
  return best;
}

function buildFillTypedData(params) {
  return {
    domain: { name: "SX Bet", version: params.domainVersion, chainId: SX_CHAIN_ID, verifyingContract: params.verifyingContract },
    types: {
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
    },
    message: {
      action: "N/A",
      market: params.marketHash,
      betting: "N/A",
      stake: "N/A",
      worstOdds: "N/A",
      worstReturning: "N/A",
      fills: {
        stakeWei: params.stakeWei,
        marketHash: params.marketHash,
        baseToken: params.baseToken,
        desiredOdds: params.desiredOdds,
        oddsSlippage: params.oddsSlippage,
        isTakerBettingOutcomeOne: params.isTakerBettingOutcomeOne,
        fillSalt: params.fillSalt,
        beneficiary: ZeroAddress,
        beneficiaryType: 0,
        cashOutTarget: ZeroHash,
      },
    },
  };
}

async function main() {
  loadEnvLocal();
  const executeLive = process.argv.includes("--execute-live");
  const spendUsd = Number(argValue("--spend", "2"));
  const maxPrice = Number(argValue("--max-price", "0.55"));
  if (!Number.isFinite(spendUsd) || spendUsd <= 0) throw new Error("--spend must be a positive number");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 1) throw new Error("--max-price must be between 0 and 1");

  const walletKey = process.env.SXBET_WALLET_KEY?.trim();
  if (!walletKey) throw new Error("SXBET_WALLET_KEY is missing from .env.local");
  const wallet = new Wallet(walletKey, new ethers.JsonRpcProvider(process.env.SX_RPC_URL || "https://rpc-rollup.sx.technology"));

  const [metadata, markets] = await Promise.all([
    fetchJson(`${SX_API}/metadata`, { headers: { Accept: "application/json" } }).then((j) => j.data),
    fetchJson(`${SX_API}/markets/active?leagueId=${MLB_LEAGUE_ID}&onlyMainLine=true`, { headers: { Accept: "application/json" } }).then((j) => j.data?.markets || []),
  ]);
  const market = markets.find((m) => m.type === MONEYLINE_TYPE && /phillies|philadelphia/i.test(`${m.teamOneName} ${m.teamTwoName}`) && /dodgers|los angeles/i.test(`${m.teamOneName} ${m.teamTwoName}`));
  if (!market) throw new Error("Could not find live SX.bet Phillies/Dodgers moneyline market");

  const philliesAreOutcomeOne = /phillies|philadelphia/i.test(market.outcomeOneName || market.teamOneName);
  const orders = await fetchJson(`${SX_API}/orders?marketHashes=${market.marketHash}`, { headers: { Accept: "application/json" } }).then((j) => j.data || []);
  const selected = bestTakerPrice(orders, philliesAreOutcomeOne);
  if (!selected) throw new Error("Could not find fillable Phillies liquidity on SX.bet");
  if (selected.price > maxPrice) throw new Error(`Current Phillies price ${selected.price.toFixed(6)} exceeds --max-price ${maxPrice}`);

  const stakeWei = ethers.parseUnits(spendUsd.toFixed(6), USDC_DECIMALS).toString();
  const desiredOdds = ethers.parseUnits(selected.price.toFixed(6), 20).toString();
  const chainAddrs = metadata.addresses?.[String(SX_CHAIN_ID)] || {};
  const baseToken = chainAddrs.USDC || metadata.USDCAddress;
  const verifyingContract = metadata.EIP712FillHasher || metadata.eip712FillHasher;
  const domainVersion = metadata.domainVersion || metadata.EIP712Version;
  const fillSalt = BigInt(hexlify(randomBytes(32))).toString();
  const typed = buildFillTypedData({
    stakeWei,
    marketHash: market.marketHash,
    baseToken,
    desiredOdds,
    oddsSlippage: 0,
    isTakerBettingOutcomeOne: philliesAreOutcomeOne,
    fillSalt,
    domainVersion,
    verifyingContract,
  });
  const takerSig = await wallet.signTypedData(typed.domain, typed.types, typed.message);

  console.log("SX.bet Phillies buy");
  console.log(`mode: ${executeLive ? "LIVE SUBMIT" : "DRY RUN - not submitted"}`);
  console.log(`market: ${market.teamOneName} vs ${market.teamTwoName}`);
  console.log(`marketHash: ${market.marketHash}`);
  console.log(`outcome: ${philliesAreOutcomeOne ? market.outcomeOneName : market.outcomeTwoName}`);
  console.log(`limit price: ${selected.price.toFixed(6)} (${(selected.price * 100).toFixed(3)}c)`);
  console.log(`stake: $${spendUsd.toFixed(6)} USDC`);
  console.log(`approx shares: ${(spendUsd / selected.price).toFixed(6)}`);
  console.log(`liquidity: $${selected.liquidityUsd.toFixed(2)}`);

  if (!executeLive) {
    console.log("Add --execute-live to submit this fill.");
    return;
  }

  const result = await fetchJson(`${SX_API}/orders/fill/v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      marketHash: market.marketHash,
      market: market.marketHash,
      baseToken,
      isTakerBettingOutcomeOne: philliesAreOutcomeOne,
      stakeWei,
      desiredOdds,
      oddsSlippage: 0,
      taker: await wallet.getAddress(),
      takerSig,
      fillSalt,
      message: "N/A",
    }),
  });
  console.log("submitted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
