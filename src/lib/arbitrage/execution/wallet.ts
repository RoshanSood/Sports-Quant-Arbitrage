// Server-side wallet signer (manual §4, §5, §23). Private keys are read ONLY from
// the server environment (POLYMARKET_WALLET_KEY / SXBET_WALLET_KEY) — never the
// browser, never logged. Provides EOA derivation and USDC balance/allowance reads
// used by the verification flow; signing for orders is added in the order phase.

import { Contract, JsonRpcProvider, MaxUint256, Wallet, formatUnits, parseUnits } from "ethers";
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

export type ApproveResult = { ok: boolean; txHash?: string; error?: string };

// Approve `spender` to pull USDC from the venue wallet (one-time on-chain tx before
// the exchange can fill an order). `amountUsd` omitted → unlimited (MaxUint256), the
// common approve-once pattern. Signs with the server-side key; never exposes it.
export async function approveUsdc(
  venue: OnchainVenue,
  usdcAddress: string,
  spender: string,
  amountUsd?: number
): Promise<ApproveResult> {
  const signer = signerFor(venue);
  if (!signer) return { ok: false, error: `no wallet key for ${venue}` };
  try {
    const c = new Contract(usdcAddress, ERC20_ABI, signer);
    const amount = amountUsd != null ? parseUnits(String(amountUsd), USDC_DECIMALS) : MaxUint256;
    const tx = await c.approve(spender, amount);
    const receipt = await tx.wait();
    return { ok: receipt?.status === 1, txHash: tx.hash };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

// Adapts an ethers v6 Wallet to the signer shape the Polymarket CLOB SDK expects
// (an ethers-v5-style `_signTypedData` + `getAddress`). ethers v6 renamed the method
// to `signTypedData`, so we bridge it. The private key never leaves this process.
export function clobSignerShim(wallet: Wallet): {
  _signTypedData: (domain: unknown, types: unknown, value: unknown) => Promise<string>;
  getAddress: () => Promise<string>;
} {
  return {
    _signTypedData: (domain, types, value) =>
      // ethers v6 Wallet.signTypedData(domain, types, value)
      (wallet as unknown as { signTypedData: (d: unknown, t: unknown, v: unknown) => Promise<string> }).signTypedData(
        domain,
        types,
        value
      ),
    getAddress: () => wallet.getAddress(),
  };
}
