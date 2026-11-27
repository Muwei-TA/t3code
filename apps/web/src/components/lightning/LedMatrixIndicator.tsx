import { observeVisibleAnimation } from "../../lib/visibleAnimation";

// One seven-row motif, repeated once so the aperture can advance a full cycle.
const rows = ["0001000", "0011000", "0111110", "0001100", "0011000", "0010000", "0100000"];
const pixels = rows
  .flatMap((row, y) =>
    [...row].flatMap((pixel, x) =>
      pixel === "1" ? [`M${3 * x + 0.5} ${3 * y + 0.5}h2v2h-2z`] : [],
    ),
  )
  .join(" ");
const grid = rows
  .flatMap((row, y) => [...row].map((__, x) => `M${3 * x + 0.5} ${3 * y + 0.5}h2v2h-2z`))
  .join(" ");

export function LedMatrixIndicator() {
  return (
    <svg
      aria-hidden="true"
      ref={observeVisibleAnimation}
      viewBox="0 0 21 21"
      className="size-4 shrink-0 overflow-hidden text-warning-foreground"
    >
      <path d={grid} fill="currentColor" opacity=".2" />
      <g className="lightning-led-pattern" fill="currentColor">
        <path d={pixels} />
        <path d={pixels} transform="translate(0 21)" />
      </g>
    </svg>
  );
}
