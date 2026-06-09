import Image from "next/image";
import { TeamInfo, GameMarket, OddsOption } from "@/types";
import OddsButton from "./OddsButton";

type TeamRowProps = {
  team: TeamInfo;
  isAway: boolean;
  market: GameMarket | null;
  side: "away" | "home";
};

function getOption(options: OddsOption[], index: number): OddsOption | null {
  if (!options || options.length === 0) return null;
  return options[index] ?? null;
}

export default function TeamRow({ team, isAway, market, side }: TeamRowProps) {
  const rowIndex = isAway ? 0 : 1;

  const moneylineOpt = getOption(market?.moneyline || [], rowIndex);
  const spreadOpt = getOption(market?.spread || [], rowIndex);
  const totalOpt = getOption(market?.total || [], rowIndex);

  const variant = side === "away" ? "away" : "home";

  return (
    <div className="flex items-center gap-2 py-2">
      {/* Team identity */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-8 h-8 flex-shrink-0">
          <Image
            src={team.logo}
            alt={team.name}
            width={32}
            height={32}
            className="w-8 h-8 object-contain"
            unoptimized
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-white text-sm truncate">{team.shortName}</span>
            <span className="text-xs text-gray-400 whitespace-nowrap">{team.record}</span>
          </div>
          <div className="text-xs text-gray-500 truncate">
            {team.pitcher || "Pitcher TBD"}
          </div>
        </div>
      </div>

      {/* Moneyline */}
      <div className="w-[90px] flex justify-center">
        {moneylineOpt ? (
          <OddsButton
            label={moneylineOpt.label}
            displayPrice={moneylineOpt.displayPrice}
            variant={variant}
            compact
          />
        ) : (
          <span className="text-gray-600 text-xs">—</span>
        )}
      </div>

      {/* Spread */}
      <div className="w-[90px] flex justify-center">
        {spreadOpt ? (
          <OddsButton
            label={spreadOpt.label}
            displayPrice={spreadOpt.displayPrice}
            variant="neutral"
            compact
          />
        ) : (
          <span className="text-gray-600 text-xs">—</span>
        )}
      </div>

      {/* Total */}
      <div className="w-[90px] flex justify-center">
        {totalOpt ? (
          <OddsButton
            label={totalOpt.label}
            displayPrice={totalOpt.displayPrice}
            variant="neutral"
            compact
          />
        ) : (
          <span className="text-gray-600 text-xs">—</span>
        )}
      </div>
    </div>
  );
}
