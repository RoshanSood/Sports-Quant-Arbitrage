import { describe, expect, it } from "vitest";
import type { Trade } from "@/types/arbitrage";
import { MOCK_OPPORTUNITIES } from "./mockData";
import { DEFAULT_RISK } from "./seed";
import { checkPortfolioRisk } from "./riskGuards";

function trade(overrides: Partial<Trade>): Trade {
  return {
    id: "trade-1",
    mode: "paper",
    opportunityId: "other",
    agentId: "kalshi-mlb",
    matchup: "A v B",
    legs: MOCK_OPPORTUNITIES[0].legs,
    orderIds: [],
    fillStatus: "filled",
    totalCost: 50,
    expectedProfit: 1,
    realizedPnl: null,
    netEdge: 0.02,
    clvDrift: null,
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
    date: "20260714",
    ...overrides,
  };
}

describe("portfolio risk guards", () => {
  const opportunity = MOCK_OPPORTUNITIES[0];

  it("enforces open-position, daily-loss, and naked-position limits", () => {
    expect(checkPortfolioRisk({ ...DEFAULT_RISK, maxOpenPositions: 1 }, [trade({})], opportunity)?.reasonCode).toBe("open_positions_exceeded");
    expect(checkPortfolioRisk({ ...DEFAULT_RISK, pauseOnNaked: true, maxOpenPositions: 10 }, [trade({ status: "naked" })], opportunity)?.reasonCode).toBe("naked_position");
    expect(checkPortfolioRisk({ ...DEFAULT_RISK, maxDailyLoss: 10, maxOpenPositions: 10 }, [trade({ status: "settled", realizedPnl: -10 })], opportunity)?.reasonCode).toBe("daily_loss_exceeded");
  });

  it("enforces aggregate and per-venue exposure", () => {
    expect(checkPortfolioRisk({ ...DEFAULT_RISK, maxExposure: 60, maxOpenPositions: 10 }, [trade({ totalCost: 50 })], opportunity)?.reasonCode).toBe("exposure_exceeded");
    expect(checkPortfolioRisk({ ...DEFAULT_RISK, maxExposure: 1000, maxOpenPositions: 10, perVenueCap: { kalshi: 10 } }, [], opportunity)?.reasonCode).toBe("exposure_exceeded");
    expect(checkPortfolioRisk({ ...DEFAULT_RISK, currentExposure: 55, maxExposure: 60, maxOpenPositions: 10 }, [], opportunity)?.reasonCode).toBe("exposure_exceeded");
  });
});
