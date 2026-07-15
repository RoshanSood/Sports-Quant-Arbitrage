import { InjuredPlayer } from "@/types/wnba";

type Props = {
  injuries: InjuredPlayer[];
};

const STATUS_STYLES: Record<string, string> = {
  "out": "text-red-400",
  "doubtful": "text-orange-400",
  "questionable": "text-yellow-400",
  "day-to-day": "text-yellow-400",
  "probable": "text-green-400",
};

function statusStyle(status: string): string {
  return STATUS_STYLES[status.toLowerCase()] ?? "text-gray-400";
}

export default function InjuryReport({ injuries }: Props) {
  if (injuries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
      {injuries.map((p, i) => (
        <span key={i} className="text-[11px] leading-tight">
          <span className="text-gray-400">{p.name}</span>
          <span className="text-gray-600 mx-0.5">({p.position})</span>
          <span className={`font-semibold ${statusStyle(p.status)}`}>{p.status}</span>
          {i < injuries.length - 1 && <span className="text-gray-700 ml-1">·</span>}
        </span>
      ))}
    </div>
  );
}

// Compact badge used in team row
export function InjuryBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 text-[10px] font-semibold text-red-400 bg-red-900/25 px-1.5 py-0.5 rounded-full leading-none">
      {count} inj
    </span>
  );
}
