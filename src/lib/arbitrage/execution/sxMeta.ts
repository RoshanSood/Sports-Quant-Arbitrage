// SX.bet metadata bootstrap (manual §13.1). Never hardcode contract addresses — pull
// them from /metadata and cache. Feeds balance/allowance verification now and EIP-712
// fill signing in the order phase.

import { SX_CHAIN_ID } from "./chains";

const SX_API = "https://api.sx.bet";

export type SxMetadata = {
  executorAddress: string | null;
  tokenTransferProxy: string | null;
  eip712FillHasher: string | null;
  usdcAddress: string | null; // chain 4162 collateral
  domainVersion: string | null;
  chainId: number;
  oddsLadderStepSize: number | null;
  bettingEnabled: boolean;
};

let cache: { at: number; meta: SxMetadata } | null = null;
const TTL_MS = 5 * 60 * 1000;

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export async function getSxMetadata(force = false): Promise<SxMetadata | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.meta;
  try {
    const res = await fetch(`${SX_API}/metadata`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!res.ok) return cache?.meta ?? null;
    const json = (await res.json()) as { data?: Record<string, unknown> };
    const d = json.data ?? {};
    const addresses = (d.addresses as Record<string, Record<string, unknown>>) ?? {};
    const chainAddrs = addresses[String(SX_CHAIN_ID)] ?? {};
    const meta: SxMetadata = {
      executorAddress: str(d.executorAddress),
      tokenTransferProxy: str(d.TokenTransferProxy) ?? str(d.tokenTransferProxy),
      eip712FillHasher: str(d.EIP712FillHasher) ?? str(d.eip712FillHasher),
      usdcAddress: str(chainAddrs.USDC) ?? str(d.USDCAddress),
      domainVersion: str(d.domainVersion) ?? str(d.EIP712Version),
      chainId: SX_CHAIN_ID,
      oddsLadderStepSize: typeof d.oddsLadderStepSize === "number" ? d.oddsLadderStepSize : null,
      bettingEnabled: d.bettingEnabled !== false,
    };
    cache = { at: Date.now(), meta };
    return meta;
  } catch (e) {
    console.error("[exec/sx] metadata fetch failed:", e);
    return cache?.meta ?? null;
  }
}
