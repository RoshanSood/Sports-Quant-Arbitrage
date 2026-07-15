// Server-side wallet signer (manual §4, §5, §23). Private keys are read ONLY from
// the server environment (POLYMARKET_WALLET_KEY / SXBET_WALLET_KEY) — never the
// browser, never logged. Provides EOA derivation and USDC balance/allowance reads
// used by the verification flow; signing for orders is added in the order phase.

import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import { ERC20_ABI, USDC_DECIMALS, polygonRpcUrl, sxRpcUrl } from "./chains";

export type OnchainVenue = "polymarket" | "sxbet";

export function walletKey(venue: OnchainVenue): string | undefined {
  const raw = venue === "polymarket" ? process.env.POLYMARKET_WALLET_KEY : process.env.SXBET_WALLET_KEY;
  return raw?.trim() || undefined;
}

export function hasWalletKey(venue: OnchainVenue): boolean {
  return Boolean(walletKey(venue));
}

// Derive the public EOA address from the configured key, offline. Returns null if
// the key is missing or malformed (never throws the key into a stack trace).
export function deriveEoa(venue: OnchainVenue): string | null {
  const key = walletKey(venue);
  if (!key) return null;
  try {
    return new Wallet(key).address;
  } catch {
    return null;
  }
}

export function providerFor(venue: OnchainVenue): JsonRpcProvider {
  return new JsonRpcProvider(venue === "polymarket" ? polygonRpcUrl() : sxRpcUrl());
}

// A signer connected to the venue's chain (for reads + later order signing).
export function signerFor(venue: OnchainVenue): Wallet | null {
  const key = walletKey(venue);
  if (!key) return null;
  try {
    return new Wallet(key, providerFor(venue));
  } catch {
    return null;
  }
}

export async function usdcBalance(provider: JsonRpcProvider, usdcAddress: string, owner: string): Promise<number> {
  const c = new Contract(usdcAddress, ERC20_ABI, provider);
  const raw = (await c.balanceOf(owner)) as bigint;
  return Number(formatUnits(raw, USDC_DECIMALS));
}

export async function usdcAllowance(
  provider: JsonRpcProvider,
  usdcAddress: string,
  owner: string,
  spender: string
): Promise<number> {
  const c = new Contract(usdcAddress, ERC20_ABI, provider);
  const raw = (await c.allowance(owner, spender)) as bigint;
  return Number(formatUnits(raw, USDC_DECIMALS));
}
