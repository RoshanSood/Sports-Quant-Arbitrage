"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Wallet as WalletIcon, RefreshCw, ChevronDown } from "lucide-react";
import type { Trade } from "@/types/arbitrage";
import { allAuthHeaders } from "./venueCreds";
import { pacificTodayDateStr } from "@/lib/arbitrage/date";
import { formatDollars, formatSignedDollars, venueDisplayName, venueStyle } from "./arbFormat";

type WalletBalance = { venueId: string; usdcBalance: number | null; status: string };

// Balance reads hit each venue's chain/API, so keep the poll gentle. A placement also
// triggers a refetch (via the trades prop growing), so this is just the idle heartbeat.
const BALANCE_POLL_MS = 60000;

// Top-right wallet widget: total balance across all connected venue wallets, a per-wallet
// balance breakdown, and the day's profit (a SEPARATE total — not split into the wallets).
// Daily profit counts LIVE trades placed today and credits each trade's EXPECTED profit the
// moment it's placed (refined to realized P&L once the game settles), so it updates without
// waiting for settlement.
export default function WalletBalances({ trades }: { trades: Trade[] }) {
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const tradeCount = trades.length;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/arbitrage/execution/status", { headers: allAuthHeaders() })
        .then((r) => r.json())
        .catch(() => null);
      if (Array.isArray(res?.venues)) {
        setBalances(
          res.venues.map((v: { venueId: string; usdcBalance?: number | null; status?: string }) => ({
            venueId: v.venueId,
            usdcBalance: typeof v.usdcBalance === "number" ? v.usdcBalance : null,
            status: v.status ?? "unknown",
          }))
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Idle heartbeat.
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, BALANCE_POLL_MS);
    return () => clearInterval(iv);
  }, [refresh]);

  // A newly placed trade grows the list → re-read balances (money just left a wallet).
  useEffect(() => {
    if (tradeCount > 0) refresh();
  }, [tradeCount, refresh]);

  // Day profit (LIVE trades placed today): expected profit at placement, realized once settled.
  const dailyProfit = useMemo(() => {
    const today = pacificTodayDateStr();
    let total = 0;
    for (const t of trades) {
      if (t.mode !== "live" || t.date !== today) continue;
      if (t.status === "failed" || t.status === "cancelled") continue;
      total += t.realizedPnl ?? t.expectedProfit;
    }
    return total;
  }, [trades]);

  const configured = balances.filter((b) => b.usdcBalance != null);
  const totalBalance = configured.reduce((s, b) => s + (b.usdcBalance ?? 0), 0);

  return (
    <div className="shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold"
        style={{ background: "#12151d", border: "1px solid #1e2130" }}
        title="Wallet balances & daily profit"
      >
        <WalletIcon className="w-3 h-3 text-emerald-400" />
        <span className="text-white">{configured.length ? formatDollars(totalBalance) : "—"}</span>
        <span className="text-gray-600">·</span>
        <span style={{ color: dailyProfit >= 0 ? "#34d399" : "#f87171" }}>
          {formatSignedDollars(dailyProfit)}
        </span>
        <ChevronDown className="w-3 h-3 text-gray-500" />
      </button>

      {open && (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* fixed so the panel escapes the top bar's horizontal-scroll clipping */}
          <div
            className="fixed z-50 top-12 right-2 w-72 rounded-lg border shadow-xl p-3"
            style={{ background: "#0e1014", borderColor: "#1e2130" }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">Wallets</span>
              <button
                onClick={refresh}
                className="text-gray-500 hover:text-gray-300"
                title="Refresh balances"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>

            {/* Totals: balance across all wallets + the day's profit (a separate figure). */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="rounded-lg border p-2" style={{ borderColor: "#1e2130", background: "#0b0d12" }}>
                <div className="text-[10px] text-gray-500">Total balance</div>
                <div className="text-white text-sm font-bold">
                  {configured.length ? formatDollars(totalBalance) : "—"}
                </div>
              </div>
              <div className="rounded-lg border p-2" style={{ borderColor: "#1e2130", background: "#0b0d12" }}>
                <div className="text-[10px] text-gray-500">Profit today · live</div>
                <div className="text-sm font-bold" style={{ color: dailyProfit >= 0 ? "#34d399" : "#f87171" }}>
                  {formatSignedDollars(dailyProfit)}
                </div>
              </div>
            </div>

            {/* Per-wallet balance breakdown (balances only — profit is the separate total above). */}
            <div className="space-y-0.5">
              {configured.length === 0 && (
                <div className="text-[11px] text-gray-500 py-2 text-center">
                  No wallets connected. Add credentials in the Venue drawer.
                </div>
              )}
              {configured.map((b) => {
                const s = venueStyle(b.venueId);
                return (
                  <div
                    key={b.venueId}
                    className="flex items-center justify-between py-1.5 border-b"
                    style={{ borderColor: "#15171e" }}
                  >
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                      style={{ background: `${s.color}22`, color: s.text }}
                    >
                      {venueDisplayName(b.venueId)}
                    </span>
                    <span className="text-white text-xs font-semibold">
                      {formatDollars(b.usdcBalance ?? 0)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="mt-2 text-[10px] text-gray-600">
              Profit credits each live arb&apos;s expected profit at placement (realized once settled).
            </div>
          </div>
        </>
      )}
    </div>
  );
}
