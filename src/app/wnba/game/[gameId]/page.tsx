import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { WNBAGame } from "@/types/wnba";
import { OddsOption } from "@/types";

async function getGame(gameId: string): Promise<WNBAGame | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/wnba-game/${gameId}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.game ?? null;
  } catch {
    return null;
  }
}

function MarketSection({ title, options }: { title: string; options: OddsOption[] }) {
  if (!options || options.length === 0) {
    return (
      <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl p-4">
        <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">{title}</h3>
        <p className="text-gray-600 text-sm">Market data unavailable</p>
      </div>
    );
  }
  return (
    <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl p-4">
      <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">{title}</h3>
      <div className="flex flex-wrap gap-3">
        {options.map((opt, i) => (
          <div
            key={i}
            className={`flex-1 min-w-[100px] flex flex-col items-center justify-center rounded-xl px-4 py-3 ${
              i === 0 ? "bg-[#7f1d1d]" : i === 1 ? "bg-[#1e3a5f]" : "bg-[#1e2130]"
            }`}
          >
            <span className="text-xs text-gray-300 font-medium truncate max-w-full">{opt.label}</span>
            <span className="text-xl font-bold text-white mt-1">{opt.displayPrice}</span>
            {opt.price != null && (
              <span className="text-xs text-gray-500 mt-0.5">{(opt.price * 100).toFixed(1)}%</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function WNBAGameDetailPage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  const game = await getGame(gameId);

  if (!game) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ background: "#111318" }}>
        <p className="text-gray-400 text-lg font-medium">Game not found</p>
        <Link href="/wnba" className="mt-4 text-blue-400 hover:text-blue-300 text-sm">
          ← Back to WNBA
        </Link>
      </div>
    );
  }

  const teams = [game.awayTeam, game.homeTeam];

  return (
    <div className="min-h-screen" style={{ background: "#111318" }}>
      <div className="max-w-3xl mx-auto px-4 pt-8 pb-16">
        <Link
          href="/wnba"
          className="inline-flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to WNBA
        </Link>

        {/* Matchup header */}
        <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl p-6 mb-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs text-gray-500 font-medium uppercase tracking-wider">
              {game.startTime} PT
            </span>
            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
              game.status === "Scheduled" || game.status === "STATUS_SCHEDULED"
                ? "bg-green-900/30 text-green-400"
                : "bg-yellow-900/30 text-yellow-400"
            }`}>
              {game.status}
            </span>
          </div>

          <div className="flex items-center justify-around gap-4">
            {teams.map((team, i) => (
              <div key={team.id} className={`flex flex-col items-center gap-3 flex-1 ${i === 0 ? "" : ""}`}>
                <Image
                  src={team.logo}
                  alt={team.name}
                  width={80}
                  height={80}
                  className="w-20 h-20 object-contain"
                  unoptimized
                />
                <div className="text-center">
                  <div className="text-white font-bold text-lg">{team.shortName}</div>
                  <div className="text-gray-400 text-sm">{team.record}</div>
                </div>
              </div>
            ))}
          </div>

          {game.market?.volume && (
            <div className="text-center mt-3">
              <span className="text-xs text-gray-500">{game.market.volume} Polymarket vol.</span>
            </div>
          )}
        </div>

        {/* Injury Reports */}
        {(game.awayTeam.injuries.length > 0 || game.homeTeam.injuries.length > 0) && (
          <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl p-4 mb-4">
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">
              Injury Report
            </h3>
            <div className="flex flex-col gap-3">
              {[game.awayTeam, game.homeTeam].map((team) =>
                team.injuries.length > 0 ? (
                  <div key={team.id}>
                    <div className="text-xs font-semibold text-gray-400 mb-1">{team.name}</div>
                    <div className="flex flex-col gap-1">
                      {team.injuries.map((p, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <span className="text-white">{p.name}</span>
                          <span className="text-gray-500 text-xs">({p.position})</span>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            p.status.toLowerCase() === "out"
                              ? "bg-red-900/30 text-red-400"
                              : p.status.toLowerCase() === "doubtful"
                              ? "bg-orange-900/30 text-orange-400"
                              : p.status.toLowerCase() === "questionable"
                              ? "bg-yellow-900/30 text-yellow-400"
                              : "bg-gray-800 text-gray-400"
                          }`}>
                            {p.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null
              )}
            </div>
          </div>
        )}

        {/* Market sections — WNBA only tracks moneyline on Polymarket */}
        {game.market ? (
          <div className="flex flex-col gap-4">
            <MarketSection title="Moneyline" options={game.market.moneyline} />
          </div>
        ) : (
          <div className="bg-[#1a1d24] border border-[#2a2d35] rounded-2xl p-8 text-center">
            <p className="text-gray-500 font-medium">No Polymarket data available for this game</p>
            <p className="text-gray-600 text-sm mt-1">Markets may not exist yet or may have closed</p>
          </div>
        )}
      </div>
    </div>
  );
}
