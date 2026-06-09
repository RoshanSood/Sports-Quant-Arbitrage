"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { MLBGame } from "@/types";
import TeamRow from "./TeamRow";
import MLBAnalysis from "./MLBAnalysis";
import PitcherMatchup from "./PitcherMatchup";

type GameCardProps = {
  game: MLBGame;
  gameDate: string;
};

export default function GameCard({ game, gameDate }: GameCardProps) {
  const volumeText = game.market?.volume ?? "Vol. unavailable";

  return (
    <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl px-4 py-3 hover:border-[#3a3d45] transition-colors">
      {/* Card header: time, volume, game view */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="font-medium text-gray-300">{game.startTime}</span>
          <span className="text-gray-500">{volumeText}</span>
          {game.status !== "Scheduled" && game.status !== "STATUS_SCHEDULED" && (
            <span className="text-yellow-400 font-medium">{game.status}</span>
          )}
        </div>
        <Link
          href={`/game/${game.id}`}
          className="flex items-center gap-1 bg-[#252a3a] hover:bg-[#2d3348] text-gray-300 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        >
          <span className="text-gray-500 mr-1">4</span>
          Game View
          <ChevronRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Column headers — desktop only */}
      <div className="hidden md:flex items-center mt-2 mb-1">
        <div className="flex-1" />
        <div className="w-[90px] text-center text-[10px] font-semibold tracking-widest text-gray-500 uppercase">
          Moneyline
        </div>
        <div className="w-[90px] text-center text-[10px] font-semibold tracking-widest text-gray-500 uppercase">
          Spread
        </div>
        <div className="w-[90px] text-center text-[10px] font-semibold tracking-widest text-gray-500 uppercase">
          Total
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-[#2a2d35] my-1" />

      {/* Away team row */}
      <TeamRow
        team={game.awayTeam}
        isAway={true}
        market={game.market}
        side="away"
      />

      {/* Separator */}
      <div className="border-t border-[#22252d] mx-0" />

      {/* Home team row */}
      <TeamRow
        team={game.homeTeam}
        isAway={false}
        market={game.market}
        side="home"
      />

      {/* Pitcher Matchup — MLB only, lazy, uses MLB Stats API + Claude */}
      {(game.awayTeam.pitcher || game.homeTeam.pitcher) && (
        <PitcherMatchup game={game} gameDate={gameDate} />
      )}

      {/* AI Analysis — lazy, session-cached, SSE streaming */}
      <MLBAnalysis game={game} gameDate={gameDate} />
    </div>
  );
}
