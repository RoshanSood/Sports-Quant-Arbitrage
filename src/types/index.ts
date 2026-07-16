export type TeamInfo = {
  id: string;
  name: string;
  shortName: string;
  abbreviation: string;
  logo: string;
  record: string;
  pitcher: string | null;
  pitcherStats: string | null; // e.g. "2-2, 3.97 ERA"
};

export type OddsOption = {
  label: string;
  price: number | null;
  displayPrice: string;
};

export type GameMarket = {
  moneyline: OddsOption[];
  spread: OddsOption[];
  total: OddsOption[];
  volume?: string | null;
};

export type MLBGame = {
  id: string;
  date: string;
  startTimeIso?: string;
  startTime: string;
  status: string;
  awayTeam: TeamInfo;
  homeTeam: TeamInfo;
  market: GameMarket | null;
};

export type GamesResponse = {
  games: MLBGame[];
  date: string;
  error?: string;
};
