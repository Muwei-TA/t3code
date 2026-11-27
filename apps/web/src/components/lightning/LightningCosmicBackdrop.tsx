import { use } from "react";
import { LightningShell } from "./shell";

interface StarPoint {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly opacity: number;
  readonly tint: "white" | "blue" | "violet";
}

interface VortexArc {
  readonly d: string;
  readonly opacity: number;
  readonly width: number;
}

// Deterministic cosmic particle field framing the center capsule like a gravitational vortex.
function buildCosmicGeometry(): {
  stars: ReadonlyArray<StarPoint>;
  arcs: ReadonlyArray<VortexArc>;
} {
  let seed = 0x51a7f319;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const stars: StarPoint[] = [];
  const cx0 = 720;
  const cy0 = 460;

  for (let i = 0; i < 290; i++) {
    const ring = Math.pow(next(), 0.7);
    const angle = next() * Math.PI * 2;
    const rx = 200 + ring * 560;
    const ry = 98 + ring * 355;
    const swirl = (1 - ring) * 0.52;
    const x = cx0 + Math.cos(angle + swirl) * rx + (next() - 0.5) * 26;
    const y = cy0 + Math.sin(angle + swirl) * ry + (next() - 0.5) * 18;

    const dx = (x - cx0) / 300;
    const dy = (y - cy0) / 138;
    if (dx * dx + dy * dy < 0.82) continue;
    if (x < 10 || x > 1430 || y < 10 || y > 890) continue;

    const sizePick = next();
    const r = sizePick > 0.91 ? 2.2 : sizePick > 0.66 ? 1.5 : 0.95;
    const opacity = Number((0.22 + (1 - ring) * 0.68 * (0.55 + next() * 0.45)).toFixed(2));
    const tintRoll = next();
    const tint: StarPoint["tint"] = tintRoll > 0.78 ? "blue" : tintRoll > 0.62 ? "violet" : "white";
    const cx = Number(x.toFixed(1));
    const cy = Number(y.toFixed(1));
    stars.push({ id: `s-${i}-${cx}-${cy}`, cx, cy, r, opacity, tint });
  }

  const arcs: VortexArc[] = [];
  for (let i = 0; i < 48; i++) {
    const t = i / 48;
    const rx = 295 + (i % 7) * 56 + (next() - 0.5) * 16;
    const ry = 132 + (i % 7) * 32 + (next() - 0.5) * 10;
    const a1 = t * Math.PI * 2 + (next() - 0.5) * 0.22;
    const span = 0.09 + next() * 0.15;
    const a2 = a1 + span;
    const x1 = cx0 + Math.cos(a1) * rx;
    const y1 = cy0 + Math.sin(a1) * ry;
    const x2 = cx0 + Math.cos(a2) * rx;
    const y2 = cy0 + Math.sin(a2) * ry;
    const am = a1 + span * 0.5;
    const xm = cx0 + Math.cos(am) * (rx + 7);
    const ym = cy0 + Math.sin(am) * (ry + 5);
    arcs.push({
      d: `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${xm.toFixed(1)} ${ym.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      opacity: Number((0.18 + (1 - (i % 7) / 7) * 0.4).toFixed(2)),
      width: i % 3 === 0 ? 1.3 : 0.9,
    });
  }

  return { stars, arcs };
}

const COSMIC_GEOMETRY = buildCosmicGeometry();

export function LightningCosmicBackdrop({ variant = "hero" }: { variant?: "hero" | "draft" }) {
  if (use(LightningShell) === "classic") return null;

  return (
    <div
      aria-hidden="true"
      data-lightning-cosmic-backdrop={variant}
      className="lightning-cosmic-backdrop pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      <div className="lightning-zenith-beam" />
      <div className="lightning-dot-grid" />
      <svg
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        className="lightning-vortex-svg"
      >
        <defs>
          <radialGradient id="lightning-vortex-fade" cx="50%" cy="51%" r="54%">
            <stop offset="0%" className="lightning-mask-white" stopOpacity="0.18" />
            <stop offset="32%" className="lightning-mask-white" stopOpacity="0.95" />
            <stop offset="76%" className="lightning-mask-white" stopOpacity="0.65" />
            <stop offset="100%" className="lightning-mask-white" stopOpacity="0" />
          </radialGradient>
          <mask id="lightning-vortex-mask">
            <rect width="1440" height="900" fill="url(#lightning-vortex-fade)" />
          </mask>
        </defs>
        <g mask="url(#lightning-vortex-mask)">
          {COSMIC_GEOMETRY.arcs.map((arc) => (
            <path
              key={arc.d}
              d={arc.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={arc.width}
              strokeLinecap="round"
              opacity={arc.opacity}
            />
          ))}
          {COSMIC_GEOMETRY.stars.map((star) => (
            <circle
              key={star.id}
              cx={star.cx}
              cy={star.cy}
              r={star.r}
              opacity={star.opacity}
              className={
                star.tint === "blue"
                  ? "lightning-star-blue"
                  : star.tint === "violet"
                    ? "lightning-star-violet"
                    : "fill-current"
              }
            />
          ))}
        </g>
      </svg>
      <div className="lightning-horizon-arc" />
    </div>
  );
}
