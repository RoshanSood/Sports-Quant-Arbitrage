type Props = {
  prices: (number | null)[];
  width?: number;
  height?: number;
};

export default function Sparkline({ prices, width = 80, height = 28 }: Props) {
  const valid = prices.filter((p): p is number => p !== null);
  if (valid.length < 2) {
    // Single dot or empty
    return (
      <svg width={width} height={height}>
        {valid.length === 1 && (
          <circle cx={width / 2} cy={height / 2} r={2.5} fill="#6b7280" />
        )}
      </svg>
    );
  }

  const minP = Math.min(...valid);
  const maxP = Math.max(...valid);
  const range = maxP - minP || 0.01; // avoid div/0

  const pts = valid.map((p, i) => {
    const x = (i / (valid.length - 1)) * (width - 4) + 2;
    const y = height - 2 - ((p - minP) / range) * (height - 4);
    return [x, y] as [number, number];
  });

  const first = valid[0];
  const last = valid[valid.length - 1];
  const isUp = last > first + 0.005;
  const isDown = last < first - 0.005;
  const color = isUp ? "#22c55e" : isDown ? "#ef4444" : "#6b7280";

  const pointStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = pts[pts.length - 1];

  return (
    <svg width={width} height={height} className="overflow-visible flex-shrink-0">
      <polyline
        points={pointStr}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.8}
      />
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
}
