// Chain + collateral config for the on-chain venues (manual §13, §19). RPCs and the
// Polygon USDC address are overridable via env so a bad default can be corrected
// without a code change. SX.bet's USDC address comes from its /metadata (chain 4162).

export const POLYGON_CHAIN_ID = 137;
export const SX_CHAIN_ID = 4162;

// Polymarket collateral on Polygon is bridged USDC.e.
const DEFAULT_POLYGON_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

export function polygonRpcUrl(): string {
  return process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
}

export function sxRpcUrl(): string {
  // SX Network (chain 4162). Override with SX_RPC_URL if the default is wrong.
  return process.env.SX_RPC_URL || "https://rpc.sx-rollup.gelato.digital";
}

export function polygonUsdcAddress(): string {
  return process.env.POLYGON_USDC_ADDRESS || DEFAULT_POLYGON_USDC;
}

export const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI for balance/allowance reads + the approve tx (allowance helper).
export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
