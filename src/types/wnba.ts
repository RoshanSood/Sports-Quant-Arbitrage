import { GameMarket } from "@/types";

export type InjuredPlayer = {
  name: string;
  position: string;
  status: string;
};

export type WNBATeamInfo = {
  id: string;
  name: string;
  shortName: string;
  abbreviation: string;
  logo: string;
  record: string;
  injuries: InjuredPlayer[];
};

export type WNBAGame = {
  id: string;
  date: string;
  startTimeIso: string;
  startTime: string;
  status: string;
  awayTeam: WNBATeamInfo;
  homeTeam: WNBATeamInfo;
  market: GameMarket | null;
};

export type WNBAGamesResponse = {
  games: WNBAGame[];
  date: string;
  error?: string;
};
