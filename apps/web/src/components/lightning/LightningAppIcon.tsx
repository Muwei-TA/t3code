import { use, useId, type SVGProps } from "react";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import { LightningShell } from "./shell";

export function LightningAppIcon({
  mono = false,
  ...props
}: SVGProps<SVGSVGElement> & { mono?: boolean }) {
  const uid = useId();
  const classic = use(LightningShell) === "classic";
  const bolt = "M14.7 1.4 3.5 13.9h7.1L8.7 22.6 20.6 9.4h-7.2z";
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      {mono || classic ? (
        <path d={bolt} fill="currentColor" />
      ) : (
        <>
          <defs>
            <linearGradient id={uid} x1="30%" y1="0%" x2="68%" y2="100%">
              <stop className="lightning-bolt-stop-core" />
              <stop offset=".44" className="lightning-bolt-stop-amber" />
              <stop offset="1" className="lightning-bolt-stop-ember" />
            </linearGradient>
          </defs>
          <path d={bolt} fill={`url(#${uid})`} />
          <path d="M14.7 1.4 9.1 12l-5.6 1.9z" className="lightning-bolt-facet" />
          <path d="m9.1 12 11.5-2.6-7.4 3.3-4.5 9.9 1.9-8.7z" className="lightning-bolt-ridge" />
        </>
      )}
    </svg>
  );
}

function observeCharge(chip: HTMLSpanElement | null) {
  if (!chip || chip.parentElement?.closest('[aria-hidden="true"]')) return;
  const target = chip.closest<HTMLElement>("[data-lightning-wordmark]") ?? chip;
  const stop = observeVisibleAnimation(target);
  const charge = () => {
    if (target.style.getPropertyValue("--visible-animation-state") !== "running") return;
    chip.setAttribute("data-charging", "");
    for (const pulse of target.getAnimations({ subtree: true })) pulse.currentTime = 0;
  };
  const finish = () => chip.removeAttribute("data-charging");
  target.addEventListener("pointerenter", charge);
  window.addEventListener("lightning:composer-send", charge);
  chip.addEventListener("animationend", finish);
  return () => {
    target.removeEventListener("pointerenter", charge);
    window.removeEventListener("lightning:composer-send", charge);
    chip.removeEventListener("animationend", finish);
    stop?.();
  };
}

export function LightningHardwareBadge({ hero = false }: { hero?: boolean }) {
  return (
    <span
      ref={observeCharge}
      aria-hidden="true"
      className={cn(
        "lightning-brand-chip relative inline-grid shrink-0 place-items-center overflow-hidden",
        hero ? "lightning-hero-emblem size-14 rounded-2xl" : "size-6.5 rounded-lg",
      )}
    >
      <span className="lightning-brand-chip-grid" />
      <LightningAppIcon
        className={cn("lightning-brand-bolt relative", hero ? "size-8" : "size-4")}
      />
      <span className="lightning-brand-chip-prism" />
    </span>
  );
}
