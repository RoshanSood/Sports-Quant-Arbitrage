"use client";

import { createContext, useCallback, useContext, useState, ReactNode } from "react";

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
  const [source, setSourceState] = useState<DataSource>(() => {
    if (typeof window === "undefined") return "polymarket";
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === "kalshi" || stored === "polymarket" ? stored : "polymarket";
    } catch {
      return "polymarket";
    }
  });

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
