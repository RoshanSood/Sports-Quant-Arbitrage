"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { ValuePlay } from "@/types/analysis";

type Props = { play: ValuePlay };

const RATING_STYLES = {
  safe: { bg: "bg-green-900/30", text: "text-green-400", border: "border-green-800/40" },
  lean: { bg: "bg-blue-900/30", text: "text-blue-400", border: "border-blue-800/40" },
  risky: { bg: "bg-yellow-900/30", text: "text-yellow-400", border: "border-yellow-800/40" },
  avoid: { bg: "bg-red-900/30", text: "text-red-400", border: "border-red-800/40" },
};

const MARKET_LABELS = {
  moneyline: "Moneyline",
  spread: "Spread",
  total: "Total",
};

function ConfidenceBar({ value }: { value: number }) {
  const filled = Math.min(10, Math.max(0, Math.round(value)));
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className={`w-2.5 h-2 rounded-sm ${
              i < filled
                ? filled >= 8 ? "bg-green-500" : filled >= 6 ? "bg-blue-500" : "bg-yellow-500"
                : "bg-[#2a2d35]"
            }`}
          />
        ))}
      </div>
      <span className="text-xs text-gray-400 font-medium">{value}/10</span>
    </div>
  );
}

export default function ValuePlayCard({ play }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { analysis, fullAnalysis } = play;
  const rating = RATING_STYLES[analysis.rating] ?? RATING_STYLES.lean;

  const gameRoute = play.league === "MLB"
    ? `/game/${play.gameId}`
    : `/wnba/game/${play.gameId}`;

  return (
    <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl px-4 py-3 hover:border-[#3a3d45] transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold tracking-widest text-gray-500 uppercase">
              {play.league}
            </span>
            <span className="text-[10px] text-gray-600">·</span>
            <span className="text-xs text-gray-400">{play.startTime}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${rating.bg} ${rating.text} ${rating.border}`}>
              {analysis.rating}
            </span>
          </div>
          <div className="text-sm font-bold text-white mt-0.5">
            {play.awayAbbr} @ {play.homeAbbr}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {play.awayTeam} @ {play.homeTeam}
          </div>
        </div>

        {/* Market badge */}
        <div className="flex-shrink-0 text-right">
          <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            {MARKET_LABELS[play.market]}
          </div>
          <div className="text-sm font-bold text-white">{analysis.recommendedPick}</div>
        </div>
      </div>

      {/* Confidence row */}
      <div className="mb-2">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Confidence</div>
        <ConfidenceBar value={analysis.confidence} />
      </div>

      {/* Edge summary */}
      <div className="mb-2">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Edge</div>
        <p className="text-xs text-blue-300 font-medium">{analysis.edgeSummary}</p>
      </div>

      {/* Why Claude likes it */}
      <div className="mb-2">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Why Claude likes it</div>
        <p className="text-xs text-gray-300 leading-relaxed">{analysis.reasoning}</p>
      </div>

      {/* Main risk */}
      {analysis.risks.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Main risk</div>
          <p className="text-xs text-yellow-400/80">{analysis.risks[0]}</p>
        </div>
      )}

      {/* Expanded: full analysis context */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-[#2a2d35] space-y-3">
          {fullAnalysis.keyFactors.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Key Factors</div>
              <ul className="space-y-0.5">
                {fullAnalysis.keyFactors.map((f, i) => (
                  <li key={i} className="text-xs text-gray-400 flex gap-1.5">
                    <span className="text-gray-600 mt-0.5">·</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fullAnalysis.injuryNotes.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Injury Notes</div>
              <ul className="space-y-0.5">
                {fullAnalysis.injuryNotes.map((n, i) => (
                  <li key={i} className="text-xs text-red-400/80 flex gap-1.5">
                    <span className="text-gray-600 mt-0.5">·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fullAnalysis.pitcherNotes.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Pitcher Notes</div>
              <ul className="space-y-0.5">
                {fullAnalysis.pitcherNotes.map((n, i) => (
                  <li key={i} className="text-xs text-gray-400 flex gap-1.5">
                    <span className="text-gray-600 mt-0.5">·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fullAnalysis.playerNotes.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Player Notes</div>
              <ul className="space-y-0.5">
                {fullAnalysis.playerNotes.map((n, i) => (
                  <li key={i} className="text-xs text-gray-400 flex gap-1.5">
                    <span className="text-gray-600 mt-0.5">·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fullAnalysis.finalTakeaway && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Final Takeaway</div>
              <p className="text-xs text-gray-300">{fullAnalysis.finalTakeaway}</p>
            </div>
          )}

          {/* Additional risks */}
          {analysis.risks.length > 1 && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">All Risks</div>
              <ul className="space-y-0.5">
                {analysis.risks.map((r, i) => (
                  <li key={i} className="text-xs text-yellow-400/70 flex gap-1.5">
                    <span className="text-gray-600 mt-0.5">·</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-[#22252d]">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-300 transition-colors"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {expanded ? "Hide details" : "Full analysis"}
        </button>
        <div className="flex-1" />
        <Link
          href={gameRoute}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Open Game
          <ExternalLink className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}
