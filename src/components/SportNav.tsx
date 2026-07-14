"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TrendingUp, Activity, Trophy, Zap, BarChart2, GitCompareArrows, Grid3x3 } from "lucide-react";
import DataSourceToggle from "./DataSourceToggle";

const NAV = [
  { label: "MLB", href: "/" },
  { label: "WNBA", href: "/wnba" },
  { label: "Value Plays",   href: "/value-plays",    icon: "value"   as const },
  { label: "Line Movement", href: "/line-movement",  icon: "lines"   as const },
  { label: "Performance",   href: "/performance",    icon: "perf"    as const },
  { label: "Live Trading",  href: "/live-trading",   icon: "trade"   as const },
  { label: "Markets",       href: "/markets",        icon: "markets" as const },
  { label: "Arbitrage",     href: "/arbitrage",      icon: "arb"     as const },
  { label: "Player Props",  href: "/props",          icon: "props"   as const },
];

export default function SportNav() {
  const pathname = usePathname();

  // The arbitrage module is a standalone full-screen "Claw Arbs" experience with its
  // own top bar — hide the shared app nav on its route.
  if (pathname.startsWith("/arbitrage")) return null;

  function isActive(href: string) {
    if (href === "/") return pathname === "/" || pathname.startsWith("/game/");
    return pathname.startsWith(href);
  }

  return (
    <div
      className="sticky top-0 z-40 border-b overflow-x-auto"
      style={{ background: "#0e1014", borderColor: "#1e2130" }}
    >
      <div className="max-w-5xl mx-auto px-4">
        <div className="flex items-center justify-between gap-3 h-12 min-w-max">
          <div className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold transition-colors whitespace-nowrap ${
                    active
                      ? item.icon
                        ? "bg-blue-600 text-white"
                        : "bg-[#1e2130] text-white"
                      : "text-gray-500 hover:text-gray-300 hover:bg-[#1a1d24]"
                  }`}
                >
                  {item.icon === "value"   && <TrendingUp className="w-3.5 h-3.5" />}
                  {item.icon === "lines"   && <Activity className="w-3.5 h-3.5" />}
                  {item.icon === "perf"    && <Trophy className="w-3.5 h-3.5" />}
                  {item.icon === "trade"   && <Zap className="w-3.5 h-3.5" />}
                  {item.icon === "markets" && <BarChart2 className="w-3.5 h-3.5" />}
                  {item.icon === "arb"     && <GitCompareArrows className="w-3.5 h-3.5" />}
                  {item.icon === "props"   && <Grid3x3 className="w-3.5 h-3.5" />}
                  {item.label}
                </Link>
              );
            })}
          </div>
          <DataSourceToggle />
        </div>
      </div>
    </div>
  );
}
