// Shared layout constants for the prop grid. Target dimensions from manual §5.
// Header and rows use the SAME width tokens so the single synchronized grid never
// drifts (manual §5 — do not build two independently scrolling tables).

export const COLORS = {
  page: "#001B20",
  header: "#17374C",
  row: "#001B20",
  rowAlt: "#04222a",
  divider: "#123038",
  frozenEdge: "#0a2a33", // slightly different bg to mark the sticky/scroll boundary
  anchorBg: "#082830",
  pill: "#22c55e", // bright green Odds-to-Hit pill
  ink: "#e6f2f2",
  inkMuted: "#7fa6ab",
  inkFaint: "#4d7178",
};

// Column widths (px). Left of the divider is sticky; the rest scrolls.
export const W = {
  player: 260,
  stat: 120,
  line: 78,
  betOver: 110,
  betUnder: 110,
  edge: 96,
  book: 96,
};

export const ROW_H = 76;
export const HEADER_H = 58;

// Total width of the sticky identity region (Player + Stat + Line).
export const STICKY_W = W.player + W.stat + W.line;
