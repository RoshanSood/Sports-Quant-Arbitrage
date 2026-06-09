import Image from "next/image";
import { WNBATeamInfo } from "@/types/wnba";
import { GameMarket, OddsOption } from "@/types";
import OddsButton from "./OddsButton";
import InjuryReport from "./InjuryReport";

type Props = {
  team: WNBATeamInfo;
  isAway: boolean;
  market: GameMarket | null;
  side: "away" | "home";
};

function getOption(options: OddsOption[], index: number): OddsOption | null {
  if (!options || options.length === 0) return null;
  return options[index] ?? null;
}

export default function WNBATeamRow({ team, isAway, market, side }: Props) {
  const rowIndex = isAway ? 0 : 1;
  const moneylineOpt = getOption(market?.moneyline ?? [], rowIndex);
  const variant = side === "away" ? "away" : "home";

  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
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
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-white text-sm">{team.shortName}</span>
              <span className="text-xs text-gray-400 whitespace-nowrap">{team.record}</span>
            </div>
            {team.injuries.length > 0 && (
              <InjuryReport injuries={team.injuries} teamName={team.shortName} />
            )}
          </div>
        </div>

        {/* Moneyline only */}
        <div className="w-[90px] flex justify-center flex-shrink-0">
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
      </div>
    </div>
  );
}
