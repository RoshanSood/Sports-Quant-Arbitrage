"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { WNBAGame } from "@/types/wnba";
import WNBATeamRow from "./WNBATeamRow";
import WNBAAnalysis from "./WNBAAnalysis";

type Props = {
  game: WNBAGame;
  gameDate: string;
};

export default function WNBAGameCard({ game, gameDate }: Props) {
  const volumeText = game.market?.volume ?? "Vol. unavailable";
  const totalInjuries = game.awayTeam.injuries.length + game.homeTeam.injuries.length;

  return (
    <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl px-4 py-3 hover:border-[#3a3d45] transition-colors">
      {/* Header: time, volume, injury count, game view */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="font-medium text-gray-300">{game.startTime}</span>
          <span className="text-gray-500">{volumeText}</span>
          {totalInjuries > 0 && (
            <span className="text-red-400 font-medium">
              {totalInjuries} injury report{totalInjuries !== 1 ? "s" : ""}
            </span>
          )}
          {game.status !== "Scheduled" && game.status !== "STATUS_SCHEDULED" && (
            <span className="text-yellow-400 font-medium">{game.status}</span>
          )}
        </div>
        <Link
          href={`/wnba/game/${game.id}`}
          className="flex items-center gap-1 bg-[#252a3a] hover:bg-[#2d3348] text-gray-300 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        >
          <span className="text-gray-500 mr-1">4</span>
          Game View
          <ChevronRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Column header — desktop only */}
      <div className="hidden md:flex items-center mt-2 mb-1">
        <div className="flex-1" />
        <div className="w-[90px] text-center text-[10px] font-bold tracking-widest text-gray-500 uppercase">
          Moneyline
        </div>
      </div>

      <div className="border-t border-[#2a2d35] my-1" />

      <WNBATeamRow team={game.awayTeam} isAway side="away" market={game.market} />

      <div className="border-t border-[#22252d]" />

      <WNBATeamRow team={game.homeTeam} isAway={false} side="home" market={game.market} />

      {/* AI Analysis — lazy, session-cached, streams from Claude + web search */}
      <WNBAAnalysis game={game} gameDate={gameDate} />
    </div>
  );
}
