// On-chain venue execution adapters. Balance reads are LIVE once a server-side wallet
// key is set; order placement is implemented in the per-venue adapters and stays gated
// behind ARB_ONCHAIN_ORDERS_ENABLED (default off) AND the execution gate — no live order
// fires until the operator deliberately enables it after $1 validation (manual §2).

export { PolymarketExecutionAdapter } from "./polymarketAdapter";
export { SxBetExecutionAdapter } from "./sxbetAdapter";
