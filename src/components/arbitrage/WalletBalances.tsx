"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw, Wallet as WalletIcon } from "lucide-react";
import type { Trade } from "@/types/arbitrage";
import { pacificTodayDateStr } from "@/lib/arbitrage/date";
import { allAuthHeaders, CREDS_CHANGED_EVENT } from "./venueCreds";
import { formatDollars, formatSignedDollars, venueDisplayName, venueStyle } from "./arbFormat";

type WalletBalance = {
  venueId: string;
  usdcBalance: number | null;
  status: string;
};

const BALANCE_POLL_MS = 60_000;

export default function WalletBalances({ trades }: { trades: Trade[] }) {
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const tradeCount = trades.length;

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const response = await fetch("/api/arbitrage/execution/status", { headers: allAuthHeaders() })
        .then((r) => r.json())
        .catch(() => null);
      if (requestId !== requestIdRef.current || !Array.isArray(response?.venues)) return;
      setBalances(
        response.venues.map((venue: { venueId: string; usdcBalance?: number | null; status?: string }) => ({
          venueId: venue.venueId,
          usdcBalance: typeof venue.usdcBalance === "number" && Number.isFinite(venue.usdcBalance)
            ? venue.usdcBalance
            : null,
          status: venue.status ?? "unknown",
        }))
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), BALANCE_POLL_MS);
    const credentialsChanged = () => void refresh();
    window.addEventListener(CREDS_CHANGED_EVENT, credentialsChanged);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener(CREDS_CHANGED_EVENT, credentialsChanged);
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (tradeCount === 0) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [tradeCount, refresh]);

  const dailyProfit = useMemo(() => {
    const today = pacificTodayDateStr();
    return trades.reduce((total, trade) => {
      if (trade.mode !== "live" || trade.date !== today) return total;
      if (trade.status === "failed" || trade.status === "cancelled") return total;
      return total + (trade.realizedPnl ?? trade.expectedProfit);
    }, 0);
  }, [trades]);

  const configured = balances.filter((balance) => balance.usdcBalance != null);
  const totalBalance = configured.reduce((total, balance) => total + (balance.usdcBalance ?? 0), 0);

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold"
        style={{ background: "#12151d", border: "1px solid #1e2130" }}
        title="Wallet balances and daily live P&L"
      >
        <WalletIcon className="w-3 h-3 text-emerald-400" />
        <span className="text-white">{configured.length ? formatDollars(totalBalance) : "—"}</span>
        <span className="text-gray-600">·</span>
        <span style={{ color: dailyProfit >= 0 ? "#34d399" : "#f87171" }}>
          {formatSignedDollars(dailyProfit)}
        </span>
        <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <button type="button" aria-label="Close wallet balances" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 top-12 right-2 w-72 rounded-lg border shadow-xl p-3"
            style={{ background: "#0e1014", borderColor: "#1e2130" }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">Wallet balances</span>
              <button type="button" onClick={() => void refresh()} className="text-gray-500 hover:text-gray-300" title="Refresh balances">
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="rounded-lg border p-2" style={{ borderColor: "#1e2130", background: "#0b0d12" }}>
                <div className="text-[10px] text-gray-500">Total balance</div>
                <div className="text-white text-sm font-bold">{configured.length ? formatDollars(totalBalance) : "—"}</div>
              </div>
              <div className="rounded-lg border p-2" style={{ borderColor: "#1e2130", background: "#0b0d12" }}>
                <div className="text-[10px] text-gray-500">P&amp;L today · live</div>
                <div className="text-sm font-bold" style={{ color: dailyProfit >= 0 ? "#34d399" : "#f87171" }}>
                  {formatSignedDollars(dailyProfit)}
                </div>
              </div>
            </div>

            <div className="space-y-0.5">
              {configured.length === 0 && (
                <div className="text-[11px] text-gray-500 py-2 text-center">
                  No wallet balances available. Add credentials in each Venue drawer.
                </div>
              )}
              {configured.map((balance) => {
                const style = venueStyle(balance.venueId);
                return (
                  <div key={balance.venueId} className="flex items-center justify-between py-1.5 border-b" style={{ borderColor: "#15171e" }}>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: `${style.color}22`, color: style.text }}>
                      {venueDisplayName(balance.venueId)}
                    </span>
                    <span className="text-white text-xs font-semibold">{formatDollars(balance.usdcBalance ?? 0)}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-2 text-[10px] text-gray-600">
              Open live trades use expected profit; settled trades use realized P&amp;L.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
