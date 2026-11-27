import { use, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import { LightningShell } from "./shell";

export type ComposerTelemetryPhase = "waiting" | "typing" | "sending" | "running" | "voice";

const SPARK_DOTS: ReadonlyArray<{
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly delay: string;
  readonly toneClass: string;
}> = [
  { id: "sp-1", cx: 168, cy: 26, delay: "-0.1s", toneClass: "lightning-spark-cyan" },
  { id: "sp-2", cx: 204, cy: 22, delay: "-0.7s", toneClass: "lightning-spark-blue" },
  { id: "sp-3", cx: 240, cy: 17, delay: "-0.35s", toneClass: "lightning-spark-violet" },
  { id: "sp-4", cx: 274, cy: 14, delay: "-1.1s", toneClass: "lightning-spark-violet" },
  { id: "sp-5", cx: 304, cy: 11, delay: "-0.55s", toneClass: "lightning-spark-pink" },
  { id: "sp-6", cx: 328, cy: 10, delay: "-0.2s", toneClass: "lightning-spark-pink" },
  { id: "sp-7", cx: 352, cy: 13, delay: "-0.9s", toneClass: "lightning-spark-amber" },
  { id: "sp-8", cx: 382, cy: 16, delay: "-0.45s", toneClass: "lightning-spark-amber" },
  { id: "sp-9", cx: 412, cy: 20, delay: "-1.25s", toneClass: "lightning-spark-pink" },
  { id: "sp-10", cx: 444, cy: 24, delay: "-0.65s", toneClass: "lightning-spark-blue" },
  { id: "sp-11", cx: 476, cy: 27, delay: "-0.3s", toneClass: "lightning-spark-cyan" },
];

export function ComposerEnergyWave({
  active,
  mode = "running",
  level = 0,
  sending = false,
}: {
  active: boolean;
  mode?: "voice" | "running";
  level?: number;
  sending?: boolean;
}) {
  const shell = use(LightningShell);
  const uid = useId().replaceAll(":", "");
  const rootRef = useRef<HTMLDivElement>(null);
  const [typingActive, setTypingActive] = useState(false);
  const [sendBurst, setSendBurst] = useState(false);
  const crestRef = useRef<SVGGElement>(null);

  const phase: ComposerTelemetryPhase =
    sendBurst || sending
      ? "sending"
      : active
        ? mode === "voice"
          ? "voice"
          : "running"
        : typingActive
          ? "typing"
          : "waiting";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the wave with native editor input, focus and confirmed sends
  useEffect(() => {
    if (shell === "classic") return;
    const root = rootRef.current;
    if (!root) return;
    const form = root.closest<HTMLElement>('[data-chat-composer-form="true"]');
    const host = root.closest<HTMLElement>('[data-slot="composer-host"]');

    let typingTimer: number | undefined;
    let strikeFrame = 0;
    let sendTimer: number | undefined;

    const focusEditor = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return false;
      setTypingActive(true);
      window.clearTimeout(typingTimer);
      typingTimer = window.setTimeout(() => setTypingActive(false), 1400);
      return true;
    };

    const triggerTyping = (event: Event) => {
      if (!focusEditor(event) || strikeFrame) return;
      // A physical keystroke can emit both keydown and input for the same edit.
      strikeFrame = window.requestAnimationFrame(() => {
        strikeFrame = 0;
        const crest = crestRef.current;
        if (!crest || root.style.getPropertyValue("--visible-animation-state") !== "running")
          return;
        for (const pulse of crest.getAnimations({ subtree: true })) pulse.currentTime = 0;
        window.dispatchEvent(new Event("lightning:composer-typing"));
      });
    };

    const triggerSendBurst = () => {
      window.cancelAnimationFrame(strikeFrame);
      strikeFrame = 0;
      setTypingActive(false);
      setSendBurst(true);
      window.clearTimeout(sendTimer);
      sendTimer = window.setTimeout(() => setSendBurst(false), 800);
    };

    const onFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget;
      if (form && nextTarget instanceof Node && form.contains(nextTarget)) return;
      window.clearTimeout(typingTimer);
      setTypingActive(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Enter" && !event.shiftKey) return;
      if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete") {
        triggerTyping(event);
      }
    };

    form?.addEventListener("input", triggerTyping);
    form?.addEventListener("keydown", onKeyDown);
    form?.addEventListener("focusout", onFocusOut);
    form?.addEventListener("focusin", focusEditor);
    window.addEventListener("lightning:composer-send", triggerSendBurst);

    return () => {
      window.clearTimeout(typingTimer);
      window.cancelAnimationFrame(strikeFrame);
      window.clearTimeout(sendTimer);
      form?.removeEventListener("input", triggerTyping);
      form?.removeEventListener("keydown", onKeyDown);
      form?.removeEventListener("focusout", onFocusOut);
      form?.removeEventListener("focusin", focusEditor);
      window.removeEventListener("lightning:composer-send", triggerSendBurst);
      host?.removeAttribute("data-lightning-composer-state");
    };
  }, [shell]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the active telemetry phase attribute onto the ancestor composer host DOM element
  useEffect(() => {
    if (shell === "classic") return;
    const host = rootRef.current?.closest<HTMLElement>('[data-slot="composer-host"]');
    if (!host) return;
    host.setAttribute("data-lightning-composer-state", phase);
  }, [phase, shell]);

  if (shell === "classic") return null;

  const amp =
    phase === "sending"
      ? 1.32
      : phase === "voice"
        ? Math.max(0.6, Math.min(1.25, 0.72 + level * 0.9))
        : phase === "running"
          ? 1
          : phase === "typing"
            ? 0.84
            : 0.4;
  const waveStyle = { "--lightning-wave-amp": String(amp) } as CSSProperties;
  const spectrumId = `lc-wave-spec-${uid}`;
  const coreId = `lc-wave-core-${uid}`;
  const dotPatternId = `lc-wave-dots-${uid}`;
  const dotMaskId = `lc-wave-mask-${uid}`;
  const warmPalette = phase === "voice" || phase === "sending";

  return (
    <div
      aria-hidden="true"
      data-lightning-energy-wave={phase}
      ref={(node) => {
        rootRef.current = node;
        return observeVisibleAnimation(node);
      }}
      style={waveStyle}
      className="lightning-composer-telemetry pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
    >
      <span className="lightning-composer-rim-sweep" data-phase={phase} />
      {phase === "sending" ? <span className="lightning-send-surge" /> : null}
      <span className="lightning-energy-wave-bloom" data-phase={phase} />
      <svg
        viewBox="0 0 640 48"
        preserveAspectRatio="none"
        className="lightning-energy-wave"
        data-phase={phase}
      >
        <defs>
          <linearGradient id={spectrumId} x1="0%" y1="0%" x2="100%" y2="0%">
            {warmPalette ? (
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
            <stop offset="58%" className="lightning-mask-white" stopOpacity="0.2" />
            <stop offset="100%" className="lightning-mask-white" stopOpacity="0.82" />
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
            data-phase={phase}
            fill={`url(#${spectrumId})`}
            opacity="0.58"
            d="M0 48 L0 44 C78 44 128 34 192 26 C248 19 282 10 330 12 C382 14 424 27 482 32 C540 37 586 44 640 44 L640 48 Z"
          />
          <path
            className="lightning-wave-band lightning-wave-band-mid"
            data-phase={phase}
            fill={`url(#${spectrumId})`}
            opacity="0.88"
            d="M0 48 L0 45 C74 44 136 39 196 31 C250 24 282 15 322 14 C364 13 398 24 448 31 C504 39 574 44 640 45 L640 48 Z"
          />
          <path
            className="lightning-wave-band lightning-wave-band-front"
            data-phase={phase}
            fill={`url(#${spectrumId})`}
            d="M0 48 L0 46 C96 45 162 41 224 34 C272 28 296 20 326 19 C358 18 390 29 442 35 C500 42 566 45 640 46 L640 48 Z"
          />
          <path
            className="lightning-wave-band lightning-wave-band-front"
            data-phase={phase}
            fill={`url(#${coreId})`}
            d="M0 48 L0 46 C120 46 210 41 278 33 C308 29 334 29 366 33 C434 41 520 46 640 46 L640 48 Z"
          />
          <g ref={crestRef} fill={`url(#${spectrumId})`}>
            <path
              className="lightning-key-crest"
              d="M215 48c56 0 71-5 85-24 6-9 11-9 17 0 10 16 25 23 62 24z"
            />
            <g transform="translate(640 0) scale(-1 1)">
              <path
                className="lightning-key-crest"
                d="M215 48c56 0 71-5 85-24 6-9 11-9 17 0 10 16 25 23 62 24z"
              />
            </g>
          </g>
        </g>

        {phase !== "waiting" ? (
          <g>
            {SPARK_DOTS.map((dot) => (
              <circle
                key={dot.id}
                cx={dot.cx}
                cy={dot.cy}
                r={phase === "sending" ? "1.65" : "1.35"}
                className={cn("lightning-wave-spark", dot.toneClass)}
                style={
                  {
                    animationDelay: phase === "sending" ? "0s" : dot.delay,
                    "--spark-flight": `${(dot.cx - 320) * 0.32}px`,
                  } as CSSProperties
                }
              />
            ))}
          </g>
        ) : null}
      </svg>
    </div>
  );
}
