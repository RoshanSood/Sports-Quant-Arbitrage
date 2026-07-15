// On-chain venue execution adapters. Balance reads are LIVE once a wallet key is set
// (entered in the UI or via env); order placement is implemented in the per-venue
// adapters and gated by the execution gate — a fresh agent seeds paper:true/live:false,
// so no live order fires until the user arms live in the UI and validates at $1.

export { PolymarketExecutionAdapter } from "./polymarketAdapter";
export { SxBetExecutionAdapter } from "./sxbetAdapter";
