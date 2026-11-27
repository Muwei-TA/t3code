import { use, useEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { attachStarSwarm, paintOrbit, releaseWarp } from "./galaxy";
import { registerPointerSurface } from "./pointerInteractive";
import { LightningShell } from "./shell";

export function LightningCosmicBackdrop({ variant = "hero" }: { variant?: "hero" | "draft" }) {
  const shell = use(LightningShell);
  const hostRef = useRef<HTMLDivElement>(null);
  const discRef = useRef<HTMLCanvasElement>(null);
  const coreRef = useRef<HTMLCanvasElement>(null);
  const swarmRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the orbital textures and connects compositor motion to pointer, theme and composer events
  useEffect(() => {
    if (shell === "classic") return;
    const host = hostRef.current;
    const disc = discRef.current;
    const core = coreRef.current;
    const swarm = swarmRef.current;
    if (!host || !disc || !core || !swarm) return;
    const stopVisibility = observeVisibleAnimation(host);
    let tone = "";
    const paint = () => {
      const width = disc.clientWidth;
      if (!width) return;
      const pixels = Math.min(
        1536,
        Math.max(512, 256 * Math.ceil((width * devicePixelRatio) / 256)),
      );
      const nextTone = getComputedStyle(host).getPropertyValue("--orbit-ice");
      if (disc.width === pixels && tone === nextTone) return;
      tone = nextTone;
      paintOrbit(disc, pixels, false);
      paintOrbit(core, Math.ceil(pixels / 2), true);
    };
    const anchor =
      variant === "draft"
        ? host
            .closest("[data-chat-workspace-drop-target]")
            ?.querySelector('[data-slot="composer-host"]')
        : host.closest("[data-lightning-hero]")?.querySelector(".lightning-hero-capsule");
    const align = () => {
      if (!anchor) return;
      const capsule = anchor.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      host.style.setProperty("--orbit-cy", `${capsule.top + capsule.height / 2 - bounds.top}px`);
    };
    const stopResize = observeResize(host, () => {
      paint();
      align();
    });
    const stopAnchor = anchor ? observeResize(anchor, align) : undefined;
    const theme = new MutationObserver(paint);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme-id"],
    });

    const moving = () => host.style.getPropertyValue("--visible-animation-state") === "running";
    const stopPointerSurface = registerPointerSurface(host);
    const stopStarSwarm = attachStarSwarm(host, swarm);
    let coast: number | undefined;
    const onTyping = () => {
      if (!moving()) return;
      if (!host.hasAttribute("data-orbit-typing")) {
        host.setAttribute("data-orbit-typing", "");
        core.getAnimations()[0]?.updatePlaybackRate(1.85);
      }
      window.clearTimeout(coast);
      coast = window.setTimeout(() => {
        host.removeAttribute("data-orbit-typing");
        core.getAnimations()[0]?.updatePlaybackRate(1);
      }, 1000);
    };
    const onSend = () => {
      if (moving()) releaseWarp(host, anchor);
    };

    window.addEventListener("lightning:composer-typing", onTyping);
    window.addEventListener("lightning:composer-send", onSend);
    return () => {
      stopStarSwarm();
      stopPointerSurface?.();
      window.clearTimeout(coast);
      theme.disconnect();
      stopResize();
      stopAnchor?.();
      stopVisibility?.();
      window.removeEventListener("lightning:composer-typing", onTyping);
      window.removeEventListener("lightning:composer-send", onSend);
    };
  }, [shell, variant]);

  if (shell === "classic") return null;
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-lightning-cosmic-backdrop={variant}
      className="lightning-cosmic-backdrop pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      <div className="lightning-zenith-beam" />
      <div className="lightning-horizon-arc" />
      <div className="lightning-orbit-plane">
        <canvas ref={discRef} className="lightning-orbit-disc" />
        <canvas ref={coreRef} className="lightning-orbit-core" />
      </div>
      <canvas ref={swarmRef} className="lightning-orbit-swarm" />
      <div className="lightning-orbit-focus" />
    </div>
  );
}
