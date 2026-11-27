const workspace = "[data-lightning-hero], [data-chat-workspace-drop-target]";
const capsule = '[data-slot="composer-host"], .lightning-hero-capsule-moat';
const card = ".lightning-hardware-card, [data-theme-library-card]";
const row = '[data-sidebar-row], [data-ui-shell="lightning"] [data-sidebar="menu-button"]';
const magnet =
  '[data-lightning-launch], [data-slot="composer-host"] button.rounded-full:is([type="submit"][aria-label], [class~="bg-destructive/90"]):enabled';
const region = [
  workspace,
  capsule,
  magnet,
  row,
  ".lightning-brand-chip",
  "[data-thread-details-card]",
  "[data-lightning-card-grid]",
].join(",");
const surfaces = new WeakMap<Element, Set<HTMLElement>>();

// A draft backdrop and its composer are siblings of the hit target. Register their bounds
// with the workspace so a pointer sample never has to search the conversation DOM.
export function registerPointerSurface(element: HTMLElement | null) {
  const owner = element?.closest(workspace);
  if (!element || !owner) return;
  const group = surfaces.get(owner) ?? new Set<HTMLElement>();
  surfaces.set(owner, group);
  group.add(element);
  return () => {
    group.delete(element);
  };
}

type Surface = "capsule" | "card" | "badge" | "magnet" | "row" | "details" | "sky";

const properties = [
  "--lx",
  "--ly",
  "--tilt-x",
  "--tilt-y",
  "--mag-x",
  "--mag-y",
  "--orbit-dx",
  "--orbit-dy",
];

function clear(element: HTMLElement) {
  element.removeAttribute("data-lightning-pointer");
  element.removeAttribute("data-orbit-focus");
  for (const property of properties) element.style.removeProperty(property);
}

function listen() {
  const controller = new AbortController();
  const options = { passive: true, capture: true, signal: controller.signal };
  // Settings and the popover inspector render in portals outside the shell element.
  document.documentElement.setAttribute("data-lightning-pointer-enabled", "");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let active = new Set<HTMLElement>();
  let frame = 0;
  let target: Element | null = null;
  let x = 0;
  let y = 0;

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    target = null;
    for (const element of active) clear(element);
    active.clear();
  }

  function paint() {
    frame = 0;
    if (reduced.matches || !target?.isConnected || document.hidden) {
      reset();
      return;
    }
    const sample = target;
    const next = new Map<HTMLElement, { kind: Surface; rect: DOMRect; hovered: boolean }>();
    function measure(element: HTMLElement | null, kind: Surface, reach = 0) {
      if (!element || next.has(element)) return;
      const rect = element.getBoundingClientRect();
      if (
        !rect.width ||
        !rect.height ||
        x < rect.left - reach ||
        x > rect.right + reach ||
        y < rect.top - reach ||
        y > rect.bottom + reach
      )
        return;
      next.set(element, { kind, rect, hovered: element.contains(sample) });
    }
    const owner = sample.closest(workspace);
    if (owner) {
      for (const surface of surfaces.get(owner) ?? []) {
        if (surface.hasAttribute("data-lightning-cosmic-backdrop")) {
          if (
            !reduced.matches &&
            surface.style.getPropertyValue("--visible-animation-state") === "running"
          )
            measure(surface, "sky");
        } else measure(surface, "capsule", 28);
      }
    }
    measure(sample.closest(capsule), "capsule", 28);
    measure(sample.closest(magnet), "magnet");
    measure(sample.closest(".lightning-brand-chip"), "badge");
    measure(sample.closest(row), "row");
    measure(sample.closest("[data-thread-details-card]"), "details");
    const grid = sample.closest("[data-lightning-card-grid]");
    if (grid) {
      for (const tile of grid.querySelectorAll<HTMLElement>(card)) measure(tile, "card", 128);
    }

    for (const element of active) if (!next.has(element)) clear(element);
    active = new Set(next.keys());
    for (const [element, { kind, rect, hovered }] of next) {
      const lx = x - rect.left;
      const ly = y - rect.top;
      const nx = Math.min(1, Math.max(-1, (2 * lx) / rect.width - 1));
      const ny = Math.min(1, Math.max(-1, (2 * ly) / rect.height - 1));
      if (kind === "sky") {
        element.setAttribute("data-orbit-focus", "");
        element.style.setProperty("--orbit-dx", String(nx / 2));
        element.style.setProperty("--orbit-dy", String(ny / 2));
        continue;
      }
      if (element.dataset.lightningPointer !== kind) element.dataset.lightningPointer = kind;
      element.style.setProperty("--lx", `${lx}px`);
      element.style.setProperty("--ly", `${ly}px`);
      if (reduced.matches) continue;
      if (kind === "badge" || kind === "card") {
        const tilt = hovered ? (kind === "badge" ? 6 : 3) : 0;
        element.style.setProperty("--tilt-x", `${-ny * tilt}deg`);
        element.style.setProperty("--tilt-y", `${nx * tilt}deg`);
      } else if (kind === "magnet") {
        element.style.setProperty("--mag-x", `${nx * 2.5}px`);
        element.style.setProperty("--mag-y", `${ny * 2.5}px`);
      }
    }
  }

  function follow(event: PointerEvent, hit = event.target) {
    if (
      reduced.matches ||
      event.pointerType === "touch" ||
      !(hit instanceof Element) ||
      document.hidden
    ) {
      if (active.size > 0 || frame || target) reset();
      return;
    }
    if (hit !== target && !hit.closest(region)) {
      if (target) reset();
      return;
    }
    x = event.clientX;
    y = event.clientY;
    target = hit;
    if (!frame) frame = requestAnimationFrame(paint);
  }
  document.addEventListener("pointermove", follow, options);
  document.addEventListener("pointerout", (event) => follow(event, event.relatedTarget), options);
  document.documentElement.addEventListener("pointerleave", reset, { signal: controller.signal });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch") reset();
    },
    options,
  );
  document.addEventListener("pointercancel", reset, options);
  document.addEventListener("visibilitychange", reset, options);
  document.addEventListener("scroll", reset, options);
  window.addEventListener("blur", reset, options);
  reduced.addEventListener(
    "change",
    () => {
      const hit = target;
      reset();
      if (!reduced.matches && hit) {
        target = hit;
        frame = requestAnimationFrame(paint);
      }
    },
    options,
  );
  return () => {
    document.documentElement.removeAttribute("data-lightning-pointer-enabled");
    controller.abort();
    reset();
  };
}

export function observeLightningPointer() {
  const hover = matchMedia("(any-hover: hover)");
  let stop = hover.matches ? listen() : undefined;
  const change = () => {
    stop?.();
    stop = hover.matches ? listen() : undefined;
  };
  hover.addEventListener("change", change);
  return () => {
    hover.removeEventListener("change", change);
    stop?.();
  };
}
