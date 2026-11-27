import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";

// Six 7x7 hardware LED frames with 3 luminance tiers:
// '1' = warm amber trail, '2' = vivid amber LED, '3' = incandescent white-gold core.
const LED_FRAMES: ReadonlyArray<{ readonly id: string; readonly rows: ReadonlyArray<string> }> = [
  {
    id: "ring",
    rows: ["0012100", "0123210", "1210121", "2300032", "1210121", "0123210", "0012100"],
  },
  {
    id: "diamond",
    rows: ["0001000", "0012100", "0123210", "1233321", "0123210", "0012100", "0001000"],
  },
  {
    id: "core",
    rows: ["0000000", "0011100", "0123210", "0133310", "0123210", "0011100", "0000000"],
  },
  {
    id: "bolt",
    rows: ["0002100", "0023100", "0233221", "0003320", "0023100", "0121000", "0110000"],
  },
  {
    id: "sweep",
    rows: ["1210000", "2321000", "1232100", "0123210", "0012321", "0001232", "0000121"],
  },
  {
    id: "bloom",
    rows: ["0122210", "1231321", "2310132", "2101012", "2310132", "1231321", "0122210"],
  },
];

interface LedFramePaths {
  readonly id: string;
  readonly delay: string;
  readonly primary: boolean;
  readonly dim: string;
  readonly mid: string;
  readonly hot: string;
}

const CELL_STEP = 4;
const CELL_SIZE = 2.65;
const CELL_INSET = 0.675;

function rectPath(x: number, y: number): string {
  const px = (x * CELL_STEP + CELL_INSET).toFixed(2);
  const py = (y * CELL_STEP + CELL_INSET).toFixed(2);
  return `M${px} ${py}h${CELL_SIZE}v${CELL_SIZE}h-${CELL_SIZE}z`;
}

const SOCKET_GRID_PATH = Array.from({ length: 7 }, (_, y) =>
  Array.from({ length: 7 }, (__, x) => rectPath(x, y)).join(" "),
).join(" ");

const COMPILED_FRAMES: ReadonlyArray<LedFramePaths> = LED_FRAMES.map(({ id, rows }, index) => {
  const dim: string[] = [];
  const mid: string[] = [];
  const hot: string[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === "1") dim.push(rectPath(x, y));
      else if (cell === "2") mid.push(rectPath(x, y));
      else if (cell === "3") hot.push(rectPath(x, y));
    });
  });
  return {
    id,
    delay: index === 0 ? "0s" : `${(-(6 - index) * 0.3).toFixed(2)}s`,
    primary: index === 0,
    dim: dim.join(" "),
    mid: mid.join(" "),
    hot: hot.join(" "),
  };
});

export function LedMatrixIndicator({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        "lightning-led-housing relative inline-flex shrink-0 items-center justify-center",
        compact ? "size-4" : "size-5.5",
      )}
    >
      <svg
        aria-hidden="true"
        ref={observeVisibleAnimation}
        viewBox="0 0 28 28"
        className="lightning-led-svg size-full overflow-visible"
      >
        <path d={SOCKET_GRID_PATH} className="lightning-led-socket" />
        {COMPILED_FRAMES.map((frame) => (
          <g
            key={frame.id}
            className={cn(
              "lightning-led-frame",
              frame.primary && "lightning-led-pattern lightning-led-frame-primary",
            )}
            style={{ animationDelay: frame.delay }}
          >
            {frame.dim ? <path d={frame.dim} className="lightning-led-dim" /> : null}
            {frame.mid ? <path d={frame.mid} className="lightning-led-mid" /> : null}
            {frame.hot ? <path d={frame.hot} className="lightning-led-hot" /> : null}
          </g>
        ))}
      </svg>
    </span>
  );
}
