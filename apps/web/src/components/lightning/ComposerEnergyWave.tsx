import { use, useId, type CSSProperties } from "react";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import { LightningShell } from "./shell";

const SPARK_DOTS: ReadonlyArray<{
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly delay: string;
  readonly toneClass: string;
}> = [
  { id: "sp-1", cx: 184, cy: 26, delay: "-0.1s", toneClass: "lightning-spark-cyan" },
  { id: "sp-2", cx: 214, cy: 22, delay: "-0.7s", toneClass: "lightning-spark-blue" },
  { id: "sp-3", cx: 248, cy: 18, delay: "-0.35s", toneClass: "lightning-spark-violet" },
  { id: "sp-4", cx: 278, cy: 15, delay: "-1.1s", toneClass: "lightning-spark-violet" },
  { id: "sp-5", cx: 304, cy: 12, delay: "-0.55s", toneClass: "lightning-spark-pink" },
  { id: "sp-6", cx: 326, cy: 10, delay: "-0.2s", toneClass: "lightning-spark-pink" },
  { id: "sp-7", cx: 348, cy: 13, delay: "-0.9s", toneClass: "lightning-spark-amber" },
  { id: "sp-8", cx: 374, cy: 16, delay: "-0.45s", toneClass: "lightning-spark-amber" },
  { id: "sp-9", cx: 402, cy: 20, delay: "-1.25s", toneClass: "lightning-spark-pink" },
  { id: "sp-10", cx: 432, cy: 24, delay: "-0.65s", toneClass: "lightning-spark-blue" },
  { id: "sp-11", cx: 462, cy: 27, delay: "-0.3s", toneClass: "lightning-spark-cyan" },
];

export function ComposerEnergyWave({
  active,
  mode = "running",
  level = 0,
}: {
  active: boolean;
  mode?: "voice" | "running";
  level?: number;
}) {
  const uid = useId().replaceAll(":", "");
  if (!active || use(LightningShell) === "classic") return null;

  const amp = mode === "voice" ? Math.max(0.55, Math.min(1.22, 0.68 + level * 0.9)) : 1;
  const waveStyle = { "--lightning-wave-amp": String(amp) } as CSSProperties;
  const spectrumId = `lc-wave-spec-${uid}`;
  const coreId = `lc-wave-core-${uid}`;
  const dotPatternId = `lc-wave-dots-${uid}`;
  const dotMaskId = `lc-wave-mask-${uid}`;

  return (
    <div
      aria-hidden="true"
      data-lightning-energy-wave={mode}
      ref={observeVisibleAnimation}
      style={waveStyle}
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
    >
      <span className="lightning-energy-wave-bloom" data-mode={mode} />
      <svg
        viewBox="0 0 640 48"
        preserveAspectRatio="none"
        className="lightning-energy-wave"
        data-mode={mode}
      >
        <defs>
          <linearGradient id={spectrumId} x1="0%" y1="0%" x2="100%" y2="0%">
            {mode === "voice" ? (
              <>
                <stop offset="2%" className="lightning-spec-cyan" stopOpacity="0" />
                <stop offset="16%" className="lightning-spec-cyan" />
                <stop offset="32%" className="lightning-spec-indigo" />
                <stop offset="48%" className="lightning-spec-pink" />
                <stop offset="65%" className="lightning-spec-orange" />
                <stop offset="82%" className="lightning-spec-gold" />
                <stop offset="98%" className="lightning-spec-gold" stopOpacity="0" />
              </>
            ) : (
              <>
                <stop offset="2%" className="lightning-spec-cyan" stopOpacity="0" />
                <stop offset="18%" className="lightning-spec-cyan" />
                <stop offset="38%" className="lightning-spec-blue" />
                <stop offset="56%" className="lightning-spec-violet" />
                <stop offset="74%" className="lightning-spec-pink" />
                <stop offset="88%" className="lightning-spec-amber" />
                <stop offset="98%" className="lightning-spec-amber" stopOpacity="0" />
              </>
            )}
          </linearGradient>
          <linearGradient id={coreId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" className="lightning-mask-white" stopOpacity="0" />
            <stop offset="62%" className="lightning-mask-white" stopOpacity="0.16" />
            <stop offset="100%" className="lightning-mask-white" stopOpacity="0.72" />
          </linearGradient>
          <pattern id={dotPatternId} width="5" height="4" patternUnits="userSpaceOnUse">
            <rect
              x="0.8"
              y="0.7"
              width="2.6"
              height="2.4"
              rx="1.2"
              className="lightning-mask-white"
            />
          </pattern>
          <mask id={dotMaskId}>
            <rect width="640" height="48" fill={`url(#${dotPatternId})`} />
          </mask>
        </defs>

        <g mask={`url(#${dotMaskId})`}>
          <path
            className="lightning-wave-band lightning-wave-band-back"
            fill={`url(#${spectrumId})`}
            opacity="0.58"
            d="M0 48 L0 44 C78 44 128 34 192 26 C248 19 282 10 330 12 C382 14 424 27 482 32 C540 37 586 44 640 44 L640 48 Z"
          />
          <path
            className="lightning-wave-band lightning-wave-band-mid"
            fill={`url(#${spectrumId})`}
            opacity="0.88"
            d="M0 48 L0 45 C74 44 136 39 196 31 C250 24 282 15 322 14 C364 13 398 24 448 31 C504 39 574 44 640 45 L640 48 Z"
          />
          <path
            className="lightning-wave-band lightning-wave-band-front"
            fill={`url(#${spectrumId})`}
            d="M0 48 L0 46 C96 45 162 41 224 34 C272 28 296 20 326 19 C358 18 390 29 442 35 C500 42 566 45 640 46 L640 48 Z"
          />
          <path
            className="lightning-wave-band lightning-wave-band-front"
            fill={`url(#${coreId})`}
            d="M0 48 L0 46 C120 46 210 41 278 33 C308 29 334 29 366 33 C434 41 520 46 640 46 L640 48 Z"
          />
        </g>

        <g>
          {SPARK_DOTS.map((dot) => (
            <circle
              key={dot.id}
              cx={dot.cx}
              cy={dot.cy}
              r="1.35"
              className={cn("lightning-wave-spark", dot.toneClass)}
              style={{ animationDelay: dot.delay }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
