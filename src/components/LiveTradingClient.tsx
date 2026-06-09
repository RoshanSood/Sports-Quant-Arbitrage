"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Zap,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  Shield,
  KeyRound,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ── Credentials helpers ───────────────────────────────────────────────────────

const CREDS_KEY = "kalshi_api_creds";

type StoredCreds = { keyId: string; privateKey: string };

function loadStoredCreds(): StoredCreds | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    return raw ? (JSON.parse(raw) as StoredCreds) : null;
  } catch {
    return null;
  }
}

function buildCredsHeaders(creds: StoredCreds | null): Record<string, string> {
  if (!creds) return {};
  return {
    "x-kalshi-key-id": creds.keyId,
    // base64-encode the PEM so newlines don't break HTTP headers
    "x-kalshi-private-key": btoa(creds.privateKey),
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

type TradeTarget = {
  ticker: string;
  side: "yes" | "no";
  askCents: number;
  contracts: number;
  estimatedCost: number;
};

type Rec = {
  id: string;
  gameId: string;
  league: string;
  awayTeam: { name: string; abbreviation: string };
  homeTeam: { name: string; abbreviation: string };
  marketType: string;
  recommendedPick: string;
  pickSide: string;
  price: number | null;
  displayPrice: string | null;
  confidence: number;
  rating: string;
  valueScore?: number | null;
  reasoningSummary: string;
  risks: string[];
  startTime: string;
};

type Proposal = {
  rec: Rec;
  target: TradeTarget | null;
  alreadyTraded?: boolean;
  error?: string;
};

type LiveTrade = {
  id: string;
  orderId: string | null;
  recId: string;
  date: string;
  ticker: string;
  side: "yes" | "no";
  contracts: number;
  limitPriceCents: number;
  estimatedCost: number;
  game: string;
  pick: string;
  marketType: string;
  placedAt: string;
  status: string;
  errorMessage?: string | null;
};

type ExecuteResult = {
  recId: string;
  success: boolean;
  orderId?: string;
  status?: string;
  error?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const RATING_COLOR: Record<string, string> = {
  safe: "text-green-400",
  lean: "text-blue-400",
  risky: "text-yellow-400",
  avoid: "text-red-400",
};

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; icon: React.ReactNode }
> = {
  open: { label: "Pending Fill", color: "text-yellow-400", icon: <Clock className="w-3.5 h-3.5" /> },
  filled: { label: "Filled", color: "text-green-400", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  partially_filled: { label: "Partial Fill", color: "text-blue-400", icon: <Clock className="w-3.5 h-3.5" /> },
  cancelled: { label: "Cancelled", color: "text-gray-400", icon: <XCircle className="w-3.5 h-3.5" /> },
  error: { label: "Error", color: "text-red-400", icon: <XCircle className="w-3.5 h-3.5" /> },
};

function fmt(d: string) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function marketLabel(t: string) {
  return t === "moneyline" ? "ML" : t === "spread" ? "Spread" : "Total";
}

function unitLabel(confidence: number): string {
  if (confidence >= 9) return "1.5u · $15";
  if (confidence >= 7) return "1u · $10";
  if (confidence >= 5) return "0.75u · $7.50";
  return "0.5u · $5";
}

// ── Component ────────────────────────────────────────────────────────────────

export default function LiveTradingClient() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [history, setHistory] = useState<LiveTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [executeResults, setExecuteResults] = useState<ExecuteResult[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Credentials state
  const [savedCreds, setSavedCreds] = useState<StoredCreds | null>(null);
  const [showCredsForm, setShowCredsForm] = useState(false);
  const [formKeyId, setFormKeyId] = useState("");
  const [formPrivateKey, setFormPrivateKey] = useState("");
  const [credsSaved, setCredsSaved] = useState(false);

  // Load credentials from localStorage on mount; only fetch data if creds exist
  useEffect(() => {
    const creds = loadStoredCreds();
    setSavedCreds(creds);
    if (!creds) {
      setShowCredsForm(true);
      setLoading(false);
    } else {
      loadData(creds);
    }
  }, [loadData]);

  const saveCreds = () => {
    if (!formKeyId.trim() || !formPrivateKey.trim()) return;
    const creds: StoredCreds = {
      keyId: formKeyId.trim(),
      privateKey: formPrivateKey.trim(),
    };
    localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
    setSavedCreds(creds);
    setShowCredsForm(false);
    setCredsSaved(true);
    setTimeout(() => setCredsSaved(false), 3000);
    loadData(creds);
  };

  const clearCreds = () => {
    localStorage.removeItem(CREDS_KEY);
    setSavedCreds(null);
    setFormKeyId("");
    setFormPrivateKey("");
    setShowCredsForm(true);
    setProposals([]);
  };

  const loadData = useCallback(async (creds?: StoredCreds | null) => {
    const activeCreds = creds !== undefined ? creds : loadStoredCreds();
    setLoading(true);
    setLoadError(null);
    try {
      const headers = {
        "Content-Type": "application/json",
        ...buildCredsHeaders(activeCreds),
      };
      const [propRes, histRes] = await Promise.all([
        fetch("/api/live-trading/proposals", { headers }),
        fetch("/api/live-trading/history"),
      ]);

      if (!propRes.ok) {
        const err = await propRes.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error ?? "Failed to load proposals");
      }
      const { proposals: p } = await propRes.json();
      setProposals(p ?? []);

      if (histRes.ok) {
        const { trades } = await histRes.json();
        setHistory(trades ?? []);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const eligibleTrades = proposals.filter(
    (p) => p.target && !p.alreadyTraded
  );

  const totalCost = eligibleTrades.reduce(
    (s, p) => s + (p.target?.estimatedCost ?? 0),
    0
  );

  const executeAll = async () => {
    if (!eligibleTrades.length) return;
    setExecuting(true);
    setConfirmOpen(false);
    setExecuteResults([]);
    try {
      const tradePayload = eligibleTrades.map((p) => ({
        recId: p.rec.id,
        game: `${p.rec.awayTeam.abbreviation} @ ${p.rec.homeTeam.abbreviation}`,
        pick: p.rec.recommendedPick,
        marketType: p.rec.marketType,
        ticker: p.target!.ticker,
        side: p.target!.side,
        contracts: p.target!.contracts,
        limitPriceCents: p.target!.askCents,
        estimatedCost: p.target!.estimatedCost,
      }));

      const res = await fetch("/api/live-trading/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildCredsHeaders(savedCreds),
        },
        body: JSON.stringify({ trades: tradePayload }),
      });

      const data = await res.json();
      setExecuteResults(data.results ?? []);
      await loadData(undefined);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Execute failed");
    } finally {
      setExecuting(false);
    }
  };

  // ── Loading / Error ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "#0e1014" }}
      >
        <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (loadError && !loadError.toLowerCase().includes("not configured")) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-3"
        style={{ background: "#0e1014" }}
      >
        <AlertTriangle className="w-8 h-8 text-red-400" />
        <p className="text-red-400 font-medium">{loadError}</p>
        <button
          onClick={() => loadData(undefined)}
          className="mt-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Summary stats ────────────────────────────────────────────────────────

  const todayTrades = history.filter((t) => {
    const today = new Date();
    const d = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    return t.date === d;
  });
  const todayInvested = todayTrades.reduce((s, t) => s + t.estimatedCost, 0);
  const todayFilled = todayTrades.filter((t) => t.status === "filled" || t.status === "open").length;

  return (
    <div className="min-h-screen" style={{ background: "#0e1014" }}>
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-yellow-400" />
              <h1 className="text-xl font-bold text-white">Live Trading</h1>
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ background: "#1e2130", color: "#94a3b8" }}
              >
                Kalshi · MLB Only
              </span>
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              Automatically places limit orders for top value plays
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadData(undefined)}
              className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            {eligibleTrades.length > 0 && (
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={executing}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-bold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Zap className="w-4 h-4" />
                Execute {eligibleTrades.length} Trade{eligibleTrades.length !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>

        {/* ── Credentials Panel ───────────────────────────────────────────── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: "1px solid #1e2130" }}
        >
          {/* Header row */}
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/5"
            style={{ background: "#13161e" }}
            onClick={() => setShowCredsForm((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-gray-400" />
              <span className="text-sm font-medium text-gray-300">
                Kalshi API Credentials
              </span>
              {savedCreds ? (
                <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">
                  <CheckCircle2 className="w-3 h-3" />
                  {savedCreds.keyId.slice(0, 8)}…
                </span>
              ) : (
                <span className="text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full">
                  Not set
                </span>
              )}
              {credsSaved && (
                <span className="text-xs text-green-400">Saved!</span>
              )}
            </div>
            {showCredsForm ? (
              <ChevronUp className="w-4 h-4 text-gray-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-500" />
            )}
          </button>

          {/* Form body */}
          {showCredsForm && (
            <div
              className="px-4 pb-4 pt-3 space-y-3"
              style={{ background: "#0e1014", borderTop: "1px solid #1e2130" }}
            >
              <p className="text-xs text-gray-500">
                Credentials are saved in your browser only and never sent to our
                servers except to sign Kalshi API requests.
              </p>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    Key ID
                  </label>
                  <input
                    type="text"
                    value={formKeyId}
                    onChange={(e) => setFormKeyId(e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="w-full rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:ring-1 focus:ring-blue-500"
                    style={{ background: "#13161e", border: "1px solid #2e3347" }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    Private Key (full PEM)
                  </label>
                  <textarea
                    value={formPrivateKey}
                    onChange={(e) => setFormPrivateKey(e.target.value)}
                    placeholder={"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"}
                    rows={5}
                    className="w-full rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 font-mono outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                    style={{ background: "#13161e", border: "1px solid #2e3347" }}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={saveCreds}
                  disabled={!formKeyId.trim() || !formPrivateKey.trim()}
                  className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save Credentials
                </button>
                {savedCreds && (
                  <button
                    onClick={clearCreds}
                    className="px-4 py-2 rounded-lg text-red-400 hover:text-red-300 text-sm transition-colors"
                    style={{ border: "1px solid #2e3347" }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Inline error (e.g. bad creds after saving) ──────────────────── */}
        {loadError && (
          <div className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-red-400"
            style={{ background: "#1a0e0e", border: "1px solid #3d1515" }}>
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {loadError}
          </div>
        )}

        {/* ── Summary Cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Today's Orders", value: todayFilled.toString() },
            {
              label: "Today Invested",
              value: `$${todayInvested.toFixed(2)}`,
            },
            {
              label: "Ready to Trade",
              value: eligibleTrades.length.toString(),
            },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-xl p-4"
              style={{ background: "#13161e", border: "1px solid #1e2130" }}
            >
              <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">
                {card.label}
              </p>
              <p className="text-white text-2xl font-bold mt-1">{card.value}</p>
            </div>
          ))}
        </div>

        {/* ── Execute Results Banner ───────────────────────────────────────── */}
        {executeResults.length > 0 && (
          <div
            className="rounded-xl p-4 space-y-2"
            style={{ background: "#13161e", border: "1px solid #1e2130" }}
          >
            <p className="text-sm font-semibold text-white">Execution Results</p>
            {executeResults.map((r) => (
              <div key={r.recId} className="flex items-center gap-2 text-sm">
                {r.success ? (
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                )}
                <span className={r.success ? "text-green-400" : "text-red-400"}>
                  {r.success
                    ? `Order placed — ID: ${r.orderId} (${r.status})`
                    : `Failed: ${r.error}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Proposals ───────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Today&apos;s Value Plays
          </h2>

          {proposals.length === 0 ? (
            <div
              className="rounded-xl p-8 text-center"
              style={{ background: "#13161e", border: "1px solid #1e2130" }}
            >
              <TrendingUp className="w-8 h-8 text-gray-600 mx-auto mb-2" />
              <p className="text-gray-400 font-medium">No value plays for today</p>
              <p className="text-gray-600 text-sm mt-1">
                Run Value Plays with the Kalshi toggle on to generate proposals.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {proposals.map((p, idx) => (
                <ProposalCard
                  key={p.rec.id}
                  proposal={p}
                  rank={idx + 1}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Trade History ────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Trade History
          </h2>

          {history.length === 0 ? (
            <div
              className="rounded-xl p-6 text-center"
              style={{ background: "#13161e", border: "1px solid #1e2130" }}
            >
              <p className="text-gray-500 text-sm">No trades executed yet.</p>
            </div>
          ) : (
            <div
              className="rounded-xl overflow-hidden"
              style={{ border: "1px solid #1e2130" }}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "#13161e", borderBottom: "1px solid #1e2130" }}>
                    {["Time", "Game", "Market", "Pick", "Side", "Contracts", "Price", "Cost", "Status"].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((t, i) => {
                    const sc = STATUS_CONFIG[t.status] ?? STATUS_CONFIG.open;
                    return (
                      <tr
                        key={t.id}
                        style={{
                          background: i % 2 === 0 ? "#0e1014" : "#13161e",
                          borderBottom: "1px solid #1e2130",
                        }}
                      >
                        <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                          {fmt(t.placedAt)}
                        </td>
                        <td className="px-4 py-3 text-white font-medium">{t.game}</td>
                        <td className="px-4 py-3 text-gray-300">{marketLabel(t.marketType)}</td>
                        <td className="px-4 py-3 text-white font-semibold">{t.pick}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded font-bold uppercase ${
                              t.side === "yes"
                                ? "text-green-400 bg-green-400/10"
                                : "text-orange-400 bg-orange-400/10"
                            }`}
                          >
                            {t.side}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-300">{t.contracts}</td>
                        <td className="px-4 py-3 text-gray-300">{t.limitPriceCents}¢</td>
                        <td className="px-4 py-3 text-gray-300">${t.estimatedCost.toFixed(2)}</td>
                        <td className="px-4 py-3">
                          <span className={`flex items-center gap-1 ${sc.color}`}>
                            {sc.icon}
                            <span className="text-xs">{sc.label}</span>
                          </span>
                          {t.errorMessage && (
                            <p className="text-red-400 text-xs mt-0.5 max-w-xs truncate">
                              {t.errorMessage}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ── Confirm Modal ────────────────────────────────────────────────────── */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="rounded-2xl p-6 max-w-md w-full space-y-4"
            style={{ background: "#13161e", border: "1px solid #2e3347" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-400/10">
                <AlertTriangle className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <h3 className="text-white font-bold text-lg">Confirm Live Orders</h3>
                <p className="text-gray-500 text-sm">Real money will be spent on Kalshi</p>
              </div>
            </div>

            <div className="space-y-2">
              {eligibleTrades.map((p) => (
                <div
                  key={p.rec.id}
                  className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: "#0e1014", border: "1px solid #1e2130" }}
                >
                  <div>
                    <p className="text-white text-sm font-medium">{p.rec.recommendedPick}</p>
                    <p className="text-gray-500 text-xs">
                      {p.rec.awayTeam.abbreviation} @ {p.rec.homeTeam.abbreviation} ·{" "}
                      {marketLabel(p.rec.marketType)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-white text-sm font-bold">
                      ${p.target!.estimatedCost.toFixed(2)}
                    </p>
                    <p className="text-gray-500 text-xs">
                      {p.target!.contracts} × {p.target!.askCents}¢
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div
              className="flex items-center justify-between rounded-lg px-3 py-2"
              style={{ background: "#0e1014" }}
            >
              <span className="text-gray-400 text-sm">Total estimated cost</span>
              <span className="text-white font-bold">${totalCost.toFixed(2)}</span>
            </div>

            <div className="flex items-start gap-2 text-xs text-gray-500">
              <Shield className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-600" />
              <span>
                Limit orders at current ask price. Orders may partially fill or rest
                in the book until the market closes.
              </span>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2.5 rounded-lg text-gray-400 hover:text-white transition-colors font-medium"
                style={{ border: "1px solid #2e3347" }}
              >
                Cancel
              </button>
              <button
                onClick={executeAll}
                disabled={executing}
                className="flex-1 py-2.5 rounded-lg bg-yellow-500 hover:bg-yellow-400 text-black font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {executing ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                {executing ? "Placing Orders…" : "Place Orders"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Proposal Card ─────────────────────────────────────────────────────────────

function ProposalCard({ proposal, rank }: { proposal: Proposal; rank: number }) {
  const { rec, target, alreadyTraded, error } = proposal;

  const hasTarget = !!target && !alreadyTraded;
  const confidenceColor =
    rec.confidence >= 8
      ? "text-green-400"
      : rec.confidence >= 6
      ? "text-blue-400"
      : "text-yellow-400";

  return (
    <div
      className={`rounded-xl p-4 transition-all ${
        alreadyTraded ? "opacity-50" : hasTarget ? "" : "opacity-60"
      }`}
      style={{
        background: "#13161e",
        border: `1px solid ${hasTarget && !alreadyTraded ? "#2e3347" : "#1e2130"}`,
      }}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: game + pick info */}
        <div className="flex items-start gap-3 min-w-0">
          <div
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: "#1e2130", color: "#94a3b8" }}
          >
            {rank}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white font-bold text-base">
                {rec.awayTeam.abbreviation} @ {rec.homeTeam.abbreviation}
              </span>
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: "#1e2130", color: "#94a3b8" }}
              >
                {marketLabel(rec.marketType)}
              </span>
              {alreadyTraded && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-400/10 text-green-400">
                  Already traded
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm flex-wrap">
              <span className="text-white font-semibold">{rec.recommendedPick}</span>
              {rec.displayPrice && (
                <span className="text-gray-400">@ {rec.displayPrice}</span>
              )}
              <span className={`font-medium ${RATING_COLOR[rec.rating] ?? "text-gray-400"}`}>
                {rec.rating}
              </span>
              <span className={`${confidenceColor}`}>
                {rec.confidence}/10 confidence
              </span>
            </div>
            <p className="text-gray-500 text-xs mt-1.5 line-clamp-2">
              {rec.reasoningSummary}
            </p>
          </div>
        </div>

        {/* Right: order details */}
        <div className="shrink-0 text-right">
          {target && !alreadyTraded ? (
            <div className="space-y-0.5">
              <p className="text-white font-bold text-lg">
                ${target.estimatedCost.toFixed(2)}
              </p>
              <p className="text-gray-400 text-xs">
                {target.contracts} contracts × {target.askCents}¢
              </p>
              <p className="text-gray-500 text-xs">
                {unitLabel(rec.confidence)} · {target.side.toUpperCase()}
              </p>
            </div>
          ) : alreadyTraded ? (
            <div className="flex items-center gap-1 text-green-400 text-sm">
              <CheckCircle2 className="w-4 h-4" />
              <span>Traded</span>
            </div>
          ) : (
            <div className="text-gray-500 text-xs max-w-[140px] text-right">
              {error ?? "No Kalshi market found"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
