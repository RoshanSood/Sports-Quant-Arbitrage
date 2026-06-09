"use client";

type OddsButtonProps = {
  label: string;
  displayPrice: string;
  variant?: "away" | "home" | "neutral";
  compact?: boolean;
};

const VARIANT_CLASSES = {
  away: "bg-[#7f1d1d] hover:bg-[#991b1b] text-white",
  home: "bg-[#1e3a5f] hover:bg-[#1e40af] text-white",
  neutral: "bg-[#1e2130] hover:bg-[#252a3a] text-gray-200",
};

export default function OddsButton({ label, displayPrice, variant = "neutral", compact }: OddsButtonProps) {
  return (
    <button
      className={`
        flex flex-col items-center justify-center rounded-xl
        transition-colors duration-150 cursor-pointer select-none
        ${compact ? "px-3 py-1.5 min-w-[68px]" : "px-4 py-2 min-w-[80px]"}
        ${VARIANT_CLASSES[variant]}
      `}
    >
      <span className={`font-semibold leading-tight ${compact ? "text-xs" : "text-sm"}`}>
        {label}
      </span>
      <span className={`font-bold leading-tight ${compact ? "text-sm" : "text-base"}`}>
        {displayPrice}
      </span>
    </button>
  );
}
