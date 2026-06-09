"use client";

import { useDataSource } from "./DataSourceContext";

export default function DataSourceToggle() {
  const { source, setSource } = useDataSource();
  return (
    <div className="inline-flex items-center bg-[#1a1d24] border border-[#2a2d35] rounded-full p-0.5">
      <button
        onClick={() => setSource("polymarket")}
        className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
          source === "polymarket"
            ? "bg-blue-600 text-white"
            : "text-gray-400 hover:text-gray-200"
        }`}
      >
        Polymarket
      </button>
      <button
        onClick={() => setSource("kalshi")}
        className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
          source === "kalshi"
            ? "bg-emerald-600 text-white"
            : "text-gray-400 hover:text-gray-200"
        }`}
      >
        Kalshi
      </button>
    </div>
  );
}
