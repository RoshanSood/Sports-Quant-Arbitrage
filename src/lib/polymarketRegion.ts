// Which Polymarket the app trades: "intl" = international self-custody CLOB (wallet
// private key, deep books) — the default; "us" = regulated Polymarket US (Ed25519 API
// key, thinner books). Set POLYMARKET_REGION=us when in the US. Single source of truth
// for ingest (read provider), execution (adapter + verify), and the credentials UI.

export type PolymarketRegion = "intl" | "us";

export function polymarketRegion(): PolymarketRegion {
  return process.env.POLYMARKET_REGION === "us" ? "us" : "intl";
}
