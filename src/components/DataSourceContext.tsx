"use client";

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";

export type DataSource = "polymarket" | "kalshi";

type Ctx = {
  source: DataSource;
  setSource: (s: DataSource) => void;
};

const STORAGE_KEY = "dataSource";

const DataSourceCtx = createContext<Ctx>({
  source: "polymarket",
  setSource: () => {},
});

export function DataSourceProvider({ children }: { children: ReactNode }) {
  const [source, setSourceState] = useState<DataSource>("polymarket");

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "kalshi" || stored === "polymarket") setSourceState(stored);
    } catch {
      // localStorage unavailable — fine
    }
  }, []);

  const setSource = useCallback((s: DataSource) => {
    setSourceState(s);
    try {
      localStorage.setItem(STORAGE_KEY, s);
    } catch {
      // ignore
    }
  }, []);

  return (
    <DataSourceCtx.Provider value={{ source, setSource }}>{children}</DataSourceCtx.Provider>
  );
}

export function useDataSource(): Ctx {
  return useContext(DataSourceCtx);
}
