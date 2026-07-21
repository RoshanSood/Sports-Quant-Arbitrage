"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import type { ArbOpportunity, NormalizedMarket, Venue } from "@/types/arbitrage";
import { Drawer, Toggle, Pill } from "./ui";
import { formatCents, formatEdgePct, formatOdds, venueStatusColor, venueStatusLabel } from "./arbFormat";
import { allAuthHeaders, clearVenueCreds, CREDS_CHANGED_EVENT, emitCredsChanged, loadVenueCreds, onchainAuthHeaders, saveVenueCreds, type PfCreds, type PolyCreds } from "./venueCreds";

type Tab = "status" | "live" | "edges" | "settings" | "credentials";

// Live credential verification for the Status tab — reflects the venue's REAL state
// (a signed balance read via /api/arbitrage/execution/status) rather than the seeded
// venue.status. Forwards the browser-stored creds as headers; re-checks when creds change.
type VenueVerify = { venueId: string; configured: boolean; usdcBalance: number | null; allowance: number | null; status: string; message?: string };

function useVenueVerification(venueId: string): { v: VenueVerify | null; loading: boolean } {
  const [v, setV] = useState<VenueVerify | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/arbitrage/execution/status", { headers: allAuthHeaders() })
        .then((r) => r.json())
        .then((d: { venues?: VenueVerify[] }) => {
          if (cancelled) return;
          setV((d.venues ?? []).find((x) => x?.venueId === venueId) ?? null);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    window.addEventListener(CREDS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(CREDS_CHANGED_EVENT, load);
    };
  }, [venueId]);
  return { v, loading };
}

// Map a live verification to a Status-tab display. Returns null when there's nothing
// verified yet (fall back to the seeded venue.status label).
function liveStatusDisplay(v: VenueVerify | null): { label: string; color: string } | null {
  if (!v || !v.configured) return null;
  switch (v.status) {
    case "verified": return { label: "Connected", color: "#22c55e" };
    case "no_balance": return { label: "Connected · no balance", color: "#f59e0b" };
    case "needs_allowance": return { label: "Needs USDC allowance", color: "#f59e0b" };
    case "error": return { label: "Error", color: "#ef4444" };
    default: return null;
  }
}

export default function VenueDrawer({
  venue,
  markets,
  opportunities,
  onChange,
  onClose,
}: {
  venue: Venue;
  markets: NormalizedMarket[];
  opportunities: ArbOpportunity[];
  onChange: (partial: Partial<Venue>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("status");
  const venueMarkets = markets.filter((m) => m.venueId === venue.id);
  const venueEdges = opportunities.filter((o) => o.legs.some((l) => l.venueId === venue.id));
  const { v: verify } = useVenueVerification(venue.id);
  const liveStatus = liveStatusDisplay(verify);

  return (
    <Drawer
      title={venue.name}
      subtitle={venue.type.replace("_", " ")}
      onClose={onClose}
      header={
        <div className="flex border-b overflow-x-auto" style={{ borderColor: "#2a2d35" }}>
          {(["status", "live", "edges", "settings", "credentials"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs font-semibold capitalize whitespace-nowrap ${
                tab === t ? "text-white border-b-2 border-blue-500" : "text-gray-500"
              }`}
            >
              {t}
              {t === "edges" && venueEdges.length > 0 && <span className="ml-1 text-emerald-400">{venueEdges.length}</span>}
            </button>
          ))}
        </div>
      }
    >
      <div className="p-4 text-xs">
        {tab === "status" && (
          <div className="space-y-2">
            <KV label="Status">
              {liveStatus ? (
                <span className="inline-flex items-center gap-1.5" style={{ color: liveStatus.color }} title={verify?.message}>
                  <span className="w-2 h-2 rounded-full" style={{ background: liveStatus.color }} />
                  {liveStatus.label}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5" style={{ color: venueStatusColor(venue.status) }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: venueStatusColor(venue.status) }} />
                  {venueStatusLabel(venue.status)}
                </span>
              )}
            </KV>
            {verify?.configured && verify.usdcBalance != null && (
              <KV label={venue.id === "kalshi" ? "Balance" : "USDC Balance"}><span className="text-gray-200">${verify.usdcBalance.toFixed(2)}</span></KV>
            )}
            <KV label="Last Update"><span className="text-gray-300">{liveStatus || venue.status === "connected" ? "<1s ago" : "—"}</span></KV>
            <KV label="Active Edges"><span className="text-gray-300">{venueEdges.length}</span></KV>
            <KV label="Cached Tickers"><span className="text-gray-300">{venue.cachedTickers ?? 0}</span></KV>
            <KV label="Freshness"><span className="text-emerald-400">{venue.freshness ?? "unknown"}</span></KV>
            <KV label="Role"><span className="text-gray-300 capitalize">{venue.role}</span></KV>
            <KV label="Currency"><span className="text-gray-300">{venue.currency}</span></KV>
          </div>
        )}

        {tab === "live" && (
          <div className="space-y-2">
            {venueMarkets.map((m) => (
              <div key={m.marketId} className="rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
                <div className="flex items-center justify-between">
                  <span className="text-white font-semibold">{m.teams.join(" v ")}</span>
                  <Pill>{m.marketType}{m.line != null ? ` ${m.line}` : ""}</Pill>
                </div>
                <div className="flex items-center justify-between text-[11px] mt-1 text-gray-400">
                  <span className="capitalize">{m.outcome}</span>
                  <span>{formatCents(m.priceCents)} · {formatOdds(m.decimalOdds)}</span>
                </div>
                <div className="h-1.5 rounded-full mt-1.5 overflow-hidden" style={{ background: "#1e2130" }}>
                  <div className="h-full" style={{ width: `${Math.min(100, m.depth)}%`, background: venue.color ?? "#3b82f6" }} />
                </div>
              </div>
            ))}
            {venueMarkets.length === 0 && <p className="text-gray-500 text-center py-6">No live contracts.</p>}
          </div>
        )}

        {tab === "edges" && (
          <div className="space-y-2">
            {venueEdges.map((o) => (
              <div key={o.id} className="rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
                <div className="flex items-center justify-between">
                  <span className="text-white font-semibold">{o.matchup}</span>
                  <span className="inline-flex items-center gap-1">
                    <Pill color="#f97316" text="#fdba74">Tracked</Pill>
                    <span className="text-emerald-400 font-semibold">{formatEdgePct(o.netEdge)}</span>
                  </span>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">{o.marketType}{o.line != null ? ` ${o.line}` : ""}</div>
              </div>
            ))}
            {venueEdges.length === 0 && <p className="text-gray-500 text-center py-6">No active edges.</p>}
          </div>
        )}

        {tab === "settings" && (
          <div className="space-y-3">
            <KV label="Venue Enabled"><Toggle checked={venue.enabled} onChange={(v) => onChange({ enabled: v })} /></KV>
            <KV label="View Only"><Toggle checked={venue.viewOnly} onChange={(v) => onChange({ viewOnly: v })} /></KV>
            <KV label="Role"><span className="text-gray-300 capitalize">{venue.role}</span></KV>
            <KV label="Currency"><span className="text-gray-300">{venue.currency}</span></KV>
            <KV label="Supports Cancel"><span className="text-gray-300">{venue.supportsCancel ? "Yes" : "No"}</span></KV>
            <KV label="Irreversible Orders"><span className="text-gray-300">{venue.isIrreversible ? "Yes" : "No"}</span></KV>
            <p className="text-[10px] text-gray-600 pt-1">Price reference venue; freshness gate applies for sharp-role venues.</p>
          </div>
        )}

        {tab === "credentials" && <CredentialsTab venueId={venue.id} />}
      </div>
    </Drawer>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      {children}
    </div>
  );
}

const KALSHI_CREDS_KEY = "kalshi_api_creds";

function CredentialsTab({ venueId }: { venueId: string }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border px-3 py-2 flex items-start gap-2 text-[11px]" style={{ borderColor: "#14532d", background: "#0d1a0f", color: "#86efac" }}>
        <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
        Stored only in THIS browser (localStorage) and sent to the venue to sign your own orders. Never committed,
        logged, or shared. Clear them any time.
      </div>
      {venueId === "kalshi" ? <KalshiCredsForm /> : <OnchainStatus venueId={venueId} />}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1 text-[11px] text-gray-400 mb-1">
        <KeyRound className="w-3 h-3" /> {label}
      </label>
      {children}
    </div>
  );
}

function KalshiCredsForm() {
  const [keyId, setKeyId] = useState("");
  const [pem, setPem] = useState("");
  const [saved, setSaved] = useState(false);
  // The credentials tab mounts only after a click (post-hydration), so reading
  // localStorage in the initializer is safe and avoids a set-state-in-effect.
  const [hasStored, setHasStored] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const raw = localStorage.getItem(KALSHI_CREDS_KEY);
      return raw ? Boolean((JSON.parse(raw) as { keyId?: string }).keyId) : false;
    } catch {
      return false;
    }
  });

  function save() {
    if (!keyId.trim() || !pem.trim()) return;
    localStorage.setItem(KALSHI_CREDS_KEY, JSON.stringify({ keyId: keyId.trim(), privateKey: pem }));
    emitCredsChanged();
    setSaved(true);
    setHasStored(true);
    setKeyId("");
    setPem("");
    setTimeout(() => setSaved(false), 1500);
  }
  function clear() {
    localStorage.removeItem(KALSHI_CREDS_KEY);
    emitCredsChanged();
    setHasStored(false);
  }

  const inputStyle = { background: "#0e1014", borderColor: "#2a2d35" } as const;
  return (
    <div className="space-y-2">
      {hasStored && <div className="text-[11px] text-emerald-400">✓ Kalshi credentials saved in this browser.</div>}
      <Labeled label="API Key ID">
        <input
          value={keyId}
          onChange={(e) => setKeyId(e.target.value)}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx"
          className="w-full px-3 py-1.5 rounded text-xs text-gray-200 outline-none border"
          style={inputStyle}
        />
      </Labeled>
      <Labeled label="Private Key (PEM)">
        <textarea
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
          rows={4}
          className="w-full px-3 py-1.5 rounded text-xs text-gray-200 outline-none border font-mono"
          style={inputStyle}
        />
      </Labeled>
      <div className="flex gap-2">
        <button onClick={save} disabled={!keyId.trim() || !pem.trim()} className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40" style={{ background: "#2563eb" }}>
          {saved ? "Saved" : "Save"}
        </button>
        <button onClick={clear} className="px-3 py-1.5 rounded text-xs font-semibold text-gray-300 border" style={{ borderColor: "#2a2d35" }}>
          Clear
        </button>
      </div>
      <p className="text-[10px] text-gray-600">
        Used to sign your real Kalshi orders. Live trading still requires arming the agent&apos;s Live toggle in
        Settings, and stays capped by the Risk panel&apos;s max live stake.
      </p>
    </div>
  );
}

type ExecStatus = {
  venueId: string;
  configured: boolean;
  address: string | null;
  chainId: number | null;
  usdcBalance: number | null;
  allowance: number | null;
  status: string;
  message?: string;
};

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  missing: { color: "#6b7280", label: "Not configured" },
  verified: { color: "#22c55e", label: "Verified" },
  no_balance: { color: "#f59e0b", label: "No USDC balance" },
  needs_allowance: { color: "#f59e0b", label: "Needs USDC allowance" },
  error: { color: "#ef4444", label: "Error" },
};

type ExecGate = { agentLive?: boolean; killSwitch?: boolean; maxLiveStakeUsd?: number; polymarketRegion?: "intl" | "us" };

function SaveRow({ onSave, disabled, hasKey, onCancel }: { onSave: () => void; disabled: boolean; hasKey: boolean; onCancel: () => void }) {
  return (
    <div className="flex gap-2 pt-0.5">
      <button onClick={onSave} disabled={disabled} className="rounded px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-40" style={{ background: "#2563eb" }}>
        Save
      </button>
      {hasKey && <button onClick={onCancel} className="rounded px-2 py-1 text-[11px] text-gray-400 hover:text-white">Cancel</button>}
    </div>
  );
}

function OnchainStatus({ venueId }: { venueId: string }) {
  const isPf = venueId === "predictfun";
  const name = venueId === "polymarket" ? "Polymarket" : venueId === "sxbet" ? "SX.bet" : isPf ? "predict.fun" : venueId;
  const chainName = venueId === "polymarket" ? "Polygon" : isPf ? "BNB Chain" : "SX Network";
  const [status, setStatus] = useState<ExecStatus | null>(null);
  const [gate, setGate] = useState<ExecGate | null>(null);
  const [loading, setLoading] = useState(true);
  const [pw, setPw] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveMsg, setApproveMsg] = useState<string | null>(null);

  // Credential entry (write-only). Polymarket intl = wallet key (+ funder/sigType);
  // Polymarket US = Key ID + Ed25519 secret; SX.bet = wallet key. We track only whether
  // creds are stored — never re-read or display them.
  const isPoly = venueId === "polymarket";
  const polyUs = isPoly && gate?.polymarketRegion === "us"; // defaults to intl until gate loads
  const storedHas = () => {
    if (typeof window === "undefined") return false;
    if (isPf) {
      const c = loadVenueCreds(venueId) as PfCreds | null;
      return Boolean(c?.apiKey && c?.walletKey);
    }
    const c = loadVenueCreds(venueId) as PolyCreds | null;
    return isPoly ? Boolean(c?.key || (c?.keyId && c?.secret)) : Boolean((c as { key?: string } | null)?.key);
  };
  const [hasKey, setHasKey] = useState(storedHas);
  const [f1, setF1] = useState(""); // wallet key (intl poly / sx) | Key ID (us poly) | API key (pf)
  const [f2, setF2] = useState(""); // Ed25519 secret (us poly) | wallet key (pf)
  const [funder, setFunder] = useState(""); // poly funder | pf smart-account address
  const [sigType, setSigType] = useState(() => {
    if (!isPoly) return 0;
    const c = loadVenueCreds(venueId) as PolyCreds | null;
    return typeof c?.sigType === "number" ? c.sigType : 3;
  });
  const [editing, setEditing] = useState(() => !storedHas());

  const load = useCallback(() => {
    let cancelled = false;
    // Forward the UI-entered wallet key (header) so verification reflects it.
    fetch("/api/arbitrage/execution/status", { headers: onchainAuthHeaders() })
      .then((r) => r.json())
      .then((d: { venues?: ExecStatus[]; gate?: ExecGate }) => {
        if (cancelled) return;
        setStatus((d.venues ?? []).find((v) => v.venueId === venueId) ?? null);
        setGate(d.gate ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  useEffect(() => load(), [load]);

  function saveKey() {
    if (isPf) {
      if (!f1.trim() || !f2.trim()) return;
      saveVenueCreds(venueId, { apiKey: f1.trim(), walletKey: f2.trim(), account: funder.trim() || undefined });
    } else if (polyUs) {
      if (!f1.trim() || !f2.trim()) return;
      saveVenueCreds(venueId, { keyId: f1.trim(), secret: f2.trim() });
    } else if (isPoly) {
      if (!f1.trim()) return;
      saveVenueCreds(venueId, { key: f1.trim(), funder: funder.trim() || undefined, sigType });
    } else {
      if (!f1.trim()) return;
      saveVenueCreds(venueId, { key: f1.trim() });
    }
    setF1("");
    setF2("");
    setHasKey(true);
    setEditing(false);
    setLoading(true);
    load();
  }

  function clearKey() {
    clearVenueCreds(venueId);
    setHasKey(false);
    setEditing(true);
    setStatus(null);
    load();
  }

  async function approve() {
    setApproving(true);
    setApproveMsg(null);
    try {
      const res = await fetch("/api/arbitrage/execution/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...onchainAuthHeaders() },
        body: JSON.stringify({ venue: venueId, password: pw }),
      });
      const d = (await res.json()) as {
        error?: string;
        result?: { ok?: boolean; txHash?: string; error?: string };
        spenders?: Record<string, { ok?: boolean; txHash?: string; error?: string }>;
      };
      if (!res.ok) {
        setApproveMsg(d.error || "Approval failed");
        return;
      }
      // Inspect the ACTUAL on-chain approve result (not just that the request went through).
      const results = d.result ? [d.result] : d.spenders ? Object.values(d.spenders) : [];
      const failed = results.find((r) => r?.ok === false);
      if (failed) {
        const gasHint = /gas|insufficient funds/i.test(failed.error || "") ? " — the wallet needs a little native gas token (SX) to send the tx." : "";
        setApproveMsg(`Approval FAILED: ${failed.error || "unknown"}${gasHint}`);
      } else {
        setApproveMsg(`Approved ✓ ${results[0]?.txHash ? `(tx ${results[0].txHash.slice(0, 10)}…)` : ""} — allowance updating.`);
        setTimeout(load, 4000);
      }
    } catch (e) {
      setApproveMsg(String(e).slice(0, 160));
    } finally {
      setApproving(false);
    }
  }

  const s = status ? STATUS_STYLE[status.status] ?? STATUS_STYLE.error : null;
  const armed = gate?.agentLive === true && gate?.killSwitch !== true;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: "#3f2d10", background: "#1a160e", color: "#fbbf24" }}>
        <div className="font-semibold">
          {isPf ? "predict.fun API key + wallet key" : polyUs ? "Polymarket US API credentials" : isPoly ? "Polymarket wallet key" : "SX.bet wallet key"}
        </div>
        <p className="text-gray-400 mt-0.5">
          {isPf ? (
            <>
              Your <strong>API key</strong> (predict.fun developer portal) authorizes order posting; your{" "}
              <strong>wallet private key</strong> signs each order. The optional <strong>smart-account address</strong> is
              your ZeroDev deposit wallet that holds the USDT (leave blank to use the signer address). Kept only in{" "}
              <strong>this browser</strong>, used transiently to sign, never stored on the server or shown again.
            </>
          ) : polyUs ? (
            <>
              Your <strong>Key ID</strong> + <strong>Ed25519 secret</strong> from the Polymarket US developer portal.
              Kept only in <strong>this browser</strong>, sent to sign requests, never stored on the server or shown again.
            </>
          ) : (
            <>
              A wallet private key controls <strong>all</strong> funds in that wallet. Kept only in{" "}
              <strong>this browser</strong>; use a dedicated wallet funded with just your trading USDC.
              {isPoly && " Export it from your Polygon wallet (MetaMask) or from Polymarket → Cash/Settings → Export Private Key."}
            </>
          )}{" "}
          A live order only fires when the agent&apos;s <strong>Live</strong> toggle (Settings) is on, the kill switch is
          off, and the stake is under the Risk cap.
        </p>
      </div>

      {/* Credential entry */}
      <div className="rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        {hasKey && !editing ? (
          <div className="flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <span className="w-2 h-2 rounded-full" style={{ background: "#22c55e" }} /> Credentials stored in this browser
            </span>
            <div className="flex gap-2">
              <button onClick={() => setEditing(true)} className="text-gray-400 hover:text-white">Replace</button>
              <button onClick={clearKey} className="text-red-400 hover:text-red-300">Clear</button>
            </div>
          </div>
        ) : isPf ? (
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-gray-500">API key</label>
            <input value={f1} onChange={(e) => setF1(e.target.value)} placeholder="predict.fun API key" autoComplete="off" className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
            <label className="text-[10px] uppercase tracking-wide text-gray-500">Wallet private key ({chainName})</label>
            <input type="password" value={f2} onChange={(e) => setF2(e.target.value)} placeholder="0x… (64-hex private key)" autoComplete="off" className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
            <label className="text-[10px] uppercase tracking-wide text-gray-500">Smart-account address (optional)</label>
            <input value={funder} onChange={(e) => setFunder(e.target.value)} placeholder="0x… ZeroDev deposit wallet (blank = signer)" className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
            <SaveRow onSave={saveKey} disabled={!f1.trim() || !f2.trim()} hasKey={hasKey} onCancel={() => setEditing(false)} />
          </div>
        ) : polyUs ? (
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-gray-500">Key ID</label>
            <input value={f1} onChange={(e) => setF1(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx" autoComplete="off" className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
            <label className="text-[10px] uppercase tracking-wide text-gray-500">Ed25519 secret (base64)</label>
            <input type="password" value={f2} onChange={(e) => setF2(e.target.value)} placeholder="base64 secret" autoComplete="off" className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
            <SaveRow onSave={saveKey} disabled={!f1.trim() || !f2.trim()} hasKey={hasKey} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-gray-500">{name} wallet private key ({chainName})</label>
            <input type="password" value={f1} onChange={(e) => setF1(e.target.value)} placeholder="0x… (64-hex private key)" autoComplete="off" className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
            {isPoly && (
              <>
                <label className="text-[10px] uppercase tracking-wide text-gray-500">Funder address {sigType === 0 ? "(optional)" : "(required)"}</label>
                <input value={funder} onChange={(e) => setFunder(e.target.value)} placeholder={sigType === 3 ? "0x... Polymarket deposit address" : "0x... blank only for a direct EOA wallet"} className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200 font-mono" style={{ borderColor: "#2a2f3e" }} />
                <label className="text-[10px] uppercase tracking-wide text-gray-500">Signature type</label>
                <select value={sigType} onChange={(e) => setSigType(Number(e.target.value))} className="w-full rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200" style={{ borderColor: "#2a2f3e" }}>
                  <option value={0}>EOA — direct wallet (default)</option>
                  <option value={1}>Polymarket proxy (email/Magic)</option>
                  <option value={2}>Gnosis Safe</option>
                  <option value={3}>Polymarket deposit wallet</option>
                </select>
              </>
            )}
            <SaveRow onSave={saveKey} disabled={!f1.trim() || (isPoly && sigType !== 0 && !funder.trim())} hasKey={hasKey} onCancel={() => setEditing(false)} />
          </div>
        )}
      </div>

      {status?.configured && (
        <div className="rounded-lg border px-3 py-2 text-[11px] flex items-center justify-between" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
          <span className="text-gray-400">Live orders {gate?.maxLiveStakeUsd != null ? `(cap $${gate.maxLiveStakeUsd})` : ""}</span>
          <span className="inline-flex items-center gap-1.5" style={{ color: armed ? "#22c55e" : "#6b7280" }} title={armed ? "Agent Live toggle is on" : "Agent is in paper mode — flip Live in Settings"}>
            <span className="w-2 h-2 rounded-full" style={{ background: armed ? "#22c55e" : "#6b7280" }} />
            {armed ? "Armed (agent live)" : "Paper (default)"}
          </span>
        </div>
      )}

      <div className="rounded-lg border px-3 py-2" style={{ borderColor: "#1e2130", background: "#0e1014" }}>
        {loading ? (
          <div className="text-[11px] text-gray-500">Checking credentials…</div>
        ) : !status || !status.configured ? (
          <div className="text-[11px] text-gray-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: "#6b7280" }} /> No credentials
            </span>
            <p className="mt-1 text-gray-600">Enter your {name} credentials above to verify {isPoly || isPf ? "balance" : "balance + allowance"}.</p>
          </div>
        ) : (
          <div className="space-y-1.5 text-[11px]">
            <KV label="Status">
              <span className="inline-flex items-center gap-1.5" style={{ color: s?.color }}>
                <span className="w-2 h-2 rounded-full" style={{ background: s?.color }} />
                {s?.label}
              </span>
            </KV>
            <KV label={isPf ? "Account" : polyUs ? "Key ID" : "Wallet"}><span className="text-gray-300 font-mono">{status.address ?? "—"}</span></KV>
            {!polyUs && <KV label={isPoly ? "Trading chain" : "Chain"}><span className="text-gray-300">{chainName} ({status.chainId})</span></KV>}
            <KV label={isPf ? "USDT Balance" : polyUs ? "Buying power" : "USDC Balance"}><span className="text-gray-200">{status.usdcBalance != null ? `$${status.usdcBalance.toFixed(2)}` : "—"}</span></KV>
            {venueId === "sxbet" && (
              <KV label="USDC Allowance"><span className="text-gray-200">{status.allowance != null ? `$${status.allowance.toFixed(2)}` : "—"}</span></KV>
            )}
            {status.message && <p className="text-[10px] text-red-400 pt-1">{status.message}</p>}

            {(venueId === "sxbet" || (isPoly && !polyUs)) && (
              <div className="pt-2 mt-1 border-t space-y-1.5" style={{ borderColor: "#1e2130" }}>
                <p className="text-[10px] text-gray-500">
                  {isPoly && sigType === 3
                    ? "Refresh Polymarket CLOB balance/allowance for the deposit wallet. Signed with your key; admin password gates the action."
                    : `One-time: approve the ${name} exchange to spend USDC (required before any fill). Signed with your key; admin password gates the action.`}
                </p>
                <div className="flex gap-1.5">
                  <input
                    type="password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="admin password"
                    className="flex-1 rounded bg-[#0b0d11] border px-2 py-1 text-[11px] text-gray-200"
                    style={{ borderColor: "#2a2f3e" }}
                  />
                  <button
                    onClick={approve}
                    disabled={approving || !pw}
                    className="rounded px-2 py-1 text-[11px] font-medium disabled:opacity-40"
                    style={{ background: "#1e2a1e", color: "#86efac", border: "1px solid #2f4a2f" }}
                  >
                    {approving ? "Approving..." : isPoly && sigType === 3 ? "Refresh" : "Approve USDC"}
                  </button>
                </div>
                {approveMsg && <p className="text-[10px] text-gray-400">{approveMsg}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
