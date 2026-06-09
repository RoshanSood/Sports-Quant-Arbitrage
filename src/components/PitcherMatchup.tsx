"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { ChevronDown, ChevronUp, Loader2, AlertCircle } from "lucide-react";
import { MLBGame } from "@/types";
import {
  PitcherMatchupData,
  PitcherBasicInfo,
  PitcherSeasonStats,
  PitcherRecentForm,
  PitcherMatchupAnalysis,
  FormLabel,
} from "@/types/pitcherMatchup";

type Props = { game: MLBGame; gameDate: string };

const cache = new Map<string, PitcherMatchupData>();

// ── Sub-components ────────────────────────────────────────────────────────────

const FORM_STYLES: Record<FormLabel, string> = {
  Strong:   "text-green-400 bg-green-900/20 border-green-800/30",
  Solid:    "text-blue-400 bg-blue-900/20 border-blue-800/30",
  Average:  "text-gray-400 bg-gray-800/30 border-gray-700/30",
  Volatile: "text-yellow-400 bg-yellow-900/20 border-yellow-800/30",
  Risky:    "text-red-400 bg-red-900/20 border-red-800/30",
  Unknown:  "text-gray-500 bg-gray-800/20 border-gray-700/20",
};

function StatRow({ label, value, highlight }: { label: string; value?: string | number | null; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[11px] text-gray-500">{label}</span>
      <span className={`text-[11px] font-semibold tabular-nums ${highlight ? "text-white" : "text-gray-300"}`}>
        {value ?? <span className="text-gray-600 font-normal">Unavailable</span>}
      </span>
    </div>
  );
}

function PitcherCard({
  info,
  stats,
  form,
  side,
}: {
  info: PitcherBasicInfo | null;
  stats: PitcherSeasonStats | null;
  form: PitcherRecentForm | null;
  side: "away" | "home";
}) {
  const name = info?.fullName ?? "TBD";
  const formLabel = form?.formLabel ?? "Unknown";
  const borderSide = side === "away" ? "border-[#7f1d1d]/30" : "border-[#1e3a5f]/30";
  const headerBg = side === "away" ? "bg-[#7f1d1d]/10" : "bg-[#1e3a5f]/10";

  return (
    <div className={`flex-1 min-w-0 border ${borderSide} rounded-xl overflow-hidden`}>
      {/* Header */}
      <div className={`${headerBg} px-3 py-2 flex items-center gap-2`}>
        {info?.headshot && (
          <Image
            src={info.headshot}
            alt={name}
            width={36}
            height={36}
            className="w-9 h-9 rounded-full object-cover flex-shrink-0 bg-[#1a1d24]"
            unoptimized
          />
        )}
        <div className="min-w-0">
          <div className="text-xs font-bold text-white truncate">{name}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-gray-500">{info?.throws ?? "?"}</span>
            {info?.age && <span className="text-[10px] text-gray-600">· Age {info.age}</span>}
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${FORM_STYLES[formLabel]}`}>
              {formLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Season stats */}
      <div className="px-3 py-2">
        <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1.5">
          2026 Season
        </div>
        {stats ? (
          <>
            <div className="grid grid-cols-2 gap-x-3">
              <StatRow label="ERA"  value={stats.era}  highlight />
              <StatRow label="WHIP" value={stats.whip} highlight />
              <StatRow label="K/9"  value={stats.strikeoutsPer9} />
              <StatRow label="BB/9" value={stats.walksPer9} />
              <StatRow label="HR/9" value={stats.homeRunsPer9} />
              <StatRow label="K/BB" value={stats.strikeoutWalkRatio} />
              <StatRow label="BAA"  value={stats.battingAverageAgainst} />
              <StatRow label="IP"   value={`${stats.inningsPitched ?? "?"} (${stats.gamesStarted ?? "?"} GS)`} />
            </div>
            <div className="mt-1 pt-1 border-t border-[#22252d]">
              <StatRow label="Record" value={`${stats.wins ?? "?"}W - ${stats.losses ?? "?"}L`} />
            </div>
          </>
        ) : (
          <p className="text-[11px] text-gray-600 italic">Season stats unavailable</p>
        )}
      </div>

      {/* Recent form */}
      {form && form.last3Starts.length > 0 && (
        <div className="px-3 pb-2 border-t border-[#22252d] pt-2">
          <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1.5">
            Last 3 Starts
          </div>
          <div className="space-y-1">
            {form.last3Starts.map((g, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px]">
                <span className="text-gray-600 w-16 flex-shrink-0">{g.date.slice(5)}</span>
                <span className="text-gray-500 flex-shrink-0">vs {g.opponent.split(" ").pop()}</span>
                <span className="ml-auto text-gray-400 tabular-nums">
                  {g.inningsPitched ?? "?"} IP
                </span>
                <span className={`tabular-nums ${(g.earnedRuns ?? 0) <= 1 ? "text-green-400" : (g.earnedRuns ?? 0) <= 3 ? "text-gray-300" : "text-red-400"}`}>
                  {g.earnedRuns ?? "?"}ER
                </span>
                <span className="text-gray-500 tabular-nums">{g.strikeouts ?? "?"}K</span>
                {g.decision && (
                  <span className={`font-bold ${g.decision === "W" ? "text-green-400" : "text-red-400"}`}>
                    {g.decision}
                  </span>
                )}
              </div>
            ))}
          </div>
          {form.last3Summary.era && (
            <div className="mt-1.5 pt-1 border-t border-[#22252d] flex gap-3 text-[10px]">
              <span className="text-gray-600">L3 ERA: <span className="text-white font-semibold">{form.last3Summary.era}</span></span>
              <span className="text-gray-600">WHIP: <span className="text-white font-semibold">{form.last3Summary.whip}</span></span>
              <span className="text-gray-600">K: <span className="text-white font-semibold">{form.last3Summary.strikeouts}</span></span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnalysisSection({ analysis, awayAbbr, homeAbbr }: {
  analysis: PitcherMatchupAnalysis;
  awayAbbr: string;
  homeAbbr: string;
}) {
  const edgeName = analysis.edge === "away" ? awayAbbr : analysis.edge === "home" ? homeAbbr : "Push";
  const edgeColor = analysis.edge === "push"
    ? "text-gray-400 bg-gray-800/30 border-gray-700/40"
    : "text-blue-300 bg-blue-900/20 border-blue-800/40";

  const IMPACT_LABELS: Record<string, string> = {
    away: `↑ ${awayAbbr}`,
    home: `↑ ${homeAbbr}`,
    neutral: "Neutral",
    over: "↑ Over",
    under: "↓ Under",
  };

  const IMPACT_COLORS: Record<string, string> = {
    away: "text-red-400", home: "text-blue-400", neutral: "text-gray-500",
    over: "text-orange-400", under: "text-teal-400",
  };

  return (
    <div className="mt-4 pt-3 border-t border-[#2a2d35]">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[9px] font-bold uppercase tracking-widest text-gray-500">
          Claude Analysis
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${edgeColor}`}>
          Edge: {analysis.edgeLabel || edgeName}
        </span>
      </div>

      <p className="text-xs text-gray-300 leading-relaxed mb-3">{analysis.edgeSummary}</p>

      {/* Market impact table */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { label: "Moneyline", val: analysis.moneylineImpact },
          { label: "Spread", val: analysis.spreadImpact },
          { label: "Total", val: analysis.totalImpact },
        ].map(({ label, val }) => (
          <div key={label} className="bg-[#0e1016] rounded-lg px-2 py-1.5 text-center">
            <div className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</div>
            <div className={`text-xs font-bold mt-0.5 ${IMPACT_COLORS[val]}`}>
              {IMPACT_LABELS[val]}
            </div>
          </div>
        ))}
      </div>

      {/* Total reason */}
      {analysis.totalImpactReason && (
        <p className="text-[11px] text-gray-500 italic mb-2">{analysis.totalImpactReason}</p>
      )}

      {/* Key factors */}
      {analysis.keyFactors?.length > 0 && (
        <div className="mb-2">
          <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-1">
            Key Factors
          </div>
          <ul className="space-y-0.5">
            {analysis.keyFactors.map((f, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] text-gray-400">
                <span className="text-gray-700 mt-0.5">·</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Betting conclusion */}
      {analysis.bettingConclusion && (
        <div className="bg-[#0e1016] border border-[#2a2d35] rounded-lg px-3 py-2 mt-2">
          <div className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mb-0.5">
            Betting Conclusion
          </div>
          <p className="text-xs text-gray-300">{analysis.bettingConclusion}</p>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PitcherMatchup({ game, gameDate }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PitcherMatchupData | null>(
    cache.get(game.id) ?? null
  );

  const load = useCallback(async () => {
    if (cache.has(game.id)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pitcher-matchup/${game.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, gameDate }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const d = await res.json();
      const matchup: PitcherMatchupData = d.matchup;
      cache.set(game.id, matchup);
      setData(matchup);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [game, gameDate]);

  const handleToggle = () => {
    if (!open && !data) load();
    setOpen((v) => !v);
  };

  const awayName = game.awayTeam.pitcher ?? "TBD";
  const homeName = game.homeTeam.pitcher ?? "TBD";

  return (
    <div className="mt-2 border-t border-[#22252d] pt-2">
      <button
        onClick={handleToggle}
        className={`flex items-center justify-between w-full text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
          open
            ? "bg-[#1a1e30] text-blue-300"
            : "text-gray-500 hover:text-gray-300 hover:bg-[#1a1d24]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          ⚾ Pitcher Matchup
          <span className="text-gray-600 font-normal">
            {awayName !== "TBD" ? ` ${awayName.split(" ").pop()} vs ${homeName.split(" ").pop()}` : ""}
          </span>
        </span>
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
        ) : open ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
      </button>

      {open && (
        <div className="mt-2 bg-[#0e1016] border border-[#252840] rounded-xl px-3 py-3">
          {loading && !data && (
            <div className="flex items-center gap-2 text-xs text-blue-400 py-4 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Fetching pitcher stats from MLB Stats API...</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400 py-2">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>{error}</span>
            </div>
          )}

          {data && (
            <>
              {/* Side-by-side pitcher cards */}
              <div className="flex gap-3">
                <PitcherCard
                  info={data.awayTeam.pitcher}
                  stats={data.awayPitcherStats}
                  form={data.awayPitcherRecentForm}
                  side="away"
                />
                <PitcherCard
                  info={data.homeTeam.pitcher}
                  stats={data.homePitcherStats}
                  form={data.homePitcherRecentForm}
                  side="home"
                />
              </div>

              {/* Claude analysis */}
              {data.analysis && (
                <AnalysisSection
                  analysis={data.analysis}
                  awayAbbr={game.awayTeam.abbreviation}
                  homeAbbr={game.homeTeam.abbreviation}
                />
              )}

              {!data.analysis && (
                <p className="text-[11px] text-gray-600 mt-3 text-center">
                  Analysis unavailable — Claude API may not be configured.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
