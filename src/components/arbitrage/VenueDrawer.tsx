"use client";

import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import type { ArbOpportunity, NormalizedMarket, Venue } from "@/types/arbitrage";
import { Drawer, Toggle, Pill } from "./ui";
import { formatCents, formatEdgePct, formatOdds, venueStatusColor, venueStatusLabel } from "./arbFormat";

type Tab = "status" | "live" | "edges" | "settings" | "credentials";

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
              <span className="inline-flex items-center gap-1.5" style={{ color: venueStatusColor(venue.status) }}>
                <span className="w-2 h-2 rounded-full" style={{ background: venueStatusColor(venue.status) }} />
                {venueStatusLabel(venue.status)}
              </span>
            </KV>
            <KV label="Last Update"><span className="text-gray-300">{venue.status === "connected" ? "<1s ago" : "—"}</span></KV>
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
      {venueId === "kalshi" ? <KalshiCredsForm /> : <OnchainCredsNote venueId={venueId} />}
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
    setSaved(true);
    setHasStored(true);
    setKeyId("");
    setPem("");
    setTimeout(() => setSaved(false), 1500);
  }
  function clear() {
    localStorage.removeItem(KALSHI_CREDS_KEY);
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
        Used to sign your real Kalshi orders. Live trading still requires the server&apos;s execution gate to be
        enabled (ARB_EXECUTION_MODE=live + allowlist), and starts capped at a few dollars.
      </p>
    </div>
  );
}

function OnchainCredsNote({ venueId }: { venueId: string }) {
  const name = venueId === "polymarket" ? "Polymarket" : venueId === "sxbet" ? "SX.bet" : venueId;
  return (
    <div className="rounded-lg border px-3 py-2 text-[11px] space-y-1" style={{ borderColor: "#3f2d10", background: "#1a160e", color: "#fbbf24" }}>
      <div className="font-semibold">On-chain venue — no key entry here</div>
      <p className="text-gray-400">
        {name} orders are signed with a wallet private key that controls all funds in the wallet. For safety that
        key is configured <strong>server-side by the operator</strong> (an environment variable on the host), never
        typed into a browser. On-chain live execution is not yet enabled.
      </p>
    </div>
  );
}
