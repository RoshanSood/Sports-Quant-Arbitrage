"use client";

import { X } from "lucide-react";

// Shared presentational atoms for the arbitrage module.

export function FloatingPanel({
  title,
  subtitle,
  onClose,
  children,
  width = "max-w-4xl",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center p-4 sm:p-8" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className={`relative w-full ${width} rounded-xl border shadow-2xl max-h-[88vh] flex flex-col`}
        style={{ background: "#12151d", borderColor: "#2a2d35" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b" style={{ borderColor: "#2a2d35" }}>
          <div>
            <h2 className="text-sm font-bold text-white">{title}</h2>
            {subtitle && <p className="text-[11px] text-gray-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="ml-auto text-gray-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  header,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  header?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-30" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="absolute top-0 right-0 h-full w-full max-w-md border-l shadow-2xl flex flex-col"
        style={{ background: "#12151d", borderColor: "#2a2d35" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: "#2a2d35" }}>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-white truncate">{title}</h2>
            {subtitle && <p className="text-[11px] text-gray-500 truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="ml-auto text-gray-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        {header}
        <div className="overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
      }`}
      style={{ background: checked ? "#22c55e" : "#374151" }}
    >
      <span
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
        style={{ left: 2, transform: checked ? "translateX(16px)" : "translateX(0)" }}
      />
    </button>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ background: "#0e1014", borderColor: "#1e2130" }}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-xl font-bold" style={{ color: accent ?? "#f0f0f0" }}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Pill({
  children,
  color = "#374151",
  text = "#e5e7eb",
}: {
  children: React.ReactNode;
  color?: string;
  text?: string;
}) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
      style={{ background: `${color}22`, color: text, border: `1px solid ${color}55` }}
    >
      {children}
    </span>
  );
}
