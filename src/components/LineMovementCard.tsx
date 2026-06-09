import { GameMovement, PriceHistory, MarketType } from "@/types/snapshots";
import Link from "next/link";
import { ExternalLink, TrendingUp, TrendingDown, Minus } from "lucide-react";
import Sparkline from "./Sparkline";

type Props = {
  movement: GameMovement;
  snapshotCount: number;
};

function centsChange(delta: number): string {
  const c = Math.round(Math.abs(delta) * 100);
  const sign = delta > 0.004 ? "+" : delta < -0.004 ? "-" : "±";
  return `${sign}${c}¢`;
}

function MovementBadge({ delta }: { delta: number }) {
  const c = Math.round(Math.abs(delta) * 100);
  if (c === 0) return <Minus className="w-3.5 h-3.5 text-gray-500" />;
  if (delta > 0) return <TrendingUp className="w-3.5 h-3.5 text-green-400" />;
  return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
}

function deltaColor(delta: number): string {
  const c = Math.round(Math.abs(delta) * 100);
  if (c === 0) return "text-gray-500";
  return delta > 0 ? "text-green-400" : "text-red-400";
}

function MarketRows({ histories, label }: { histories: PriceHistory[]; label: string }) {
  if (histories.length === 0) return null;

  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-1.5">
        {label}
      </div>
      <div className="flex flex-col gap-1.5">
        {histories.map((h) => {
          const prices = h.history.map((s) => s.price);
          const openCents = Math.round((h.open.price ?? 0) * 100);
          const curCents = Math.round((h.current.price ?? 0) * 100);
          const hasMoved = Math.abs(h.changeFromOpen) >= 0.005;

          return (
            <div key={h.key} className="flex items-center gap-3">
              {/* Label */}
              <div className="w-24 flex-shrink-0">
                <div className="text-xs font-semibold text-white truncate">{h.outcomeLabel}</div>
              </div>

              {/* Open → Current */}
              <div className="flex items-center gap-1.5 text-xs text-gray-400 min-w-[100px]">
                <span className="text-gray-600">{openCents}¢</span>
                <span className="text-gray-700">→</span>
                <span className={hasMoved ? "text-white font-semibold" : "text-gray-400"}>{curCents}¢</span>
              </div>

              {/* Change */}
              <div className={`flex items-center gap-1 text-xs font-bold min-w-[48px] ${deltaColor(h.changeFromOpen)}`}>
                <MovementBadge delta={h.changeFromOpen} />
                <span>{centsChange(h.changeFromOpen)}</span>
              </div>

              {/* Recent move */}
              {h.recentChange !== 0 && (
                <div className={`text-[10px] ${deltaColor(h.recentChange)} hidden sm:block`}>
                  recent: {centsChange(h.recentChange)}
                </div>
              )}

              {/* Sparkline */}
              <div className="ml-auto">
                <Sparkline prices={prices} width={72} height={24} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MARKET_ORDER: MarketType[] = ["moneyline", "spread", "total"];
const MARKET_LABELS: Record<MarketType, string> = {
  moneyline: "Moneyline",
  spread: "Spread",
  total: "Total",
};

export default function LineMovementCard({ movement, snapshotCount }: Props) {
  const gameRoute =
    movement.league === "MLB"
      ? `/game/${movement.gameId}`
      : `/wnba/game/${movement.gameId}`;

  // Find any meaningful movement across all markets
  const allHistories = MARKET_ORDER.flatMap((m) => movement.markets[m]);
  const maxMove = Math.max(...allHistories.map((h) => Math.abs(h.changeFromOpen)));
  const hasBigMove = maxMove >= 0.05; // 5¢+ move is notable

  return (
    <div
      className={`bg-[#1a1d24] border rounded-2xl px-4 py-3 transition-colors ${
        hasBigMove ? "border-blue-800/50 hover:border-blue-700/60" : "border-[#2a2d35] hover:border-[#3a3d45]"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold tracking-widest text-gray-500 uppercase">
              {movement.league}
            </span>
            {movement.startTime && (
              <>
                <span className="text-gray-700">·</span>
                <span className="text-[10px] text-gray-500">{movement.startTime}</span>
              </>
            )}
            {hasBigMove && (
              <span className="text-[10px] font-bold text-blue-400 bg-blue-900/30 px-2 py-0.5 rounded-full border border-blue-800/40">
                Moving
              </span>
            )}
          </div>
          <div className="text-sm font-bold text-white mt-0.5">{movement.matchup}</div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] text-gray-600">Snapshots</div>
            <div className="text-xs font-semibold text-gray-400">{snapshotCount}</div>
          </div>
          <Link
            href={gameRoute}
            className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {/* Markets */}
      <div className="flex flex-col gap-4">
        {MARKET_ORDER.map((mt) => {
          const hs = movement.markets[mt];
          if (!hs || hs.length === 0) return null;
          return (
            <MarketRows
              key={mt}
              histories={hs}
              label={MARKET_LABELS[mt]}
            />
          );
        })}
      </div>

      {snapshotCount === 1 && (
        <p className="text-[10px] text-gray-700 mt-3">
          Only 1 snapshot — revisit the Games page to build movement history.
        </p>
      )}
    </div>
  );
}
