import { Profiler } from "react";
import { cdp } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { NoProjectsHero } from "../NoProjectsHero";
import { WorkspaceShellProvider } from "./shell";
import { ComposerEnergyWave } from "./ComposerEnergyWave";
import { LedMatrixIndicator } from "./LedMatrixIndicator";
import { LightningCosmicBackdrop } from "./LightningCosmicBackdrop";
import { LightningThinkingPill } from "./LightningThinkingPill";
import { LightningWordmark } from "./LightningWordmark";
import "~/index.css";

const { add, scratch, available } = vi.hoisted(() => ({
  add: vi.fn(),
  scratch: vi.fn(),
  available: vi.fn<() => string | null>(),
}));
vi.mock("../../commandPaletteBus", () => ({ openCommandPalette: add }));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: available, startScratchThread: scratch }),
}));

it.each(["lightning", "classic"])("opens project actions in the %s shell", async (shell) => {
  using _storage = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation((key) =>
      key === "lightning:ui-shell" && shell === "classic" ? "classic" : null,
    );
  available.mockReturnValue("local");
  await using screen = await render(
    <WorkspaceShellProvider>
      <NoProjectsHero />
      <LightningWordmark />
      <LightningCosmicBackdrop variant="draft" />
      <ComposerEnergyWave active />
    </WorkspaceShellProvider>,
  );
  await screen.getByRole("button", { name: "Add project" }).click();
  expect(add).toHaveBeenCalledWith({ open: "add-project" });
  await screen.getByRole("button", { name: "Start without a project" }).click();
  expect(scratch).toHaveBeenCalledWith("local");
  expect(Boolean(screen.container.querySelector("[data-lightning-hero]"))).toBe(
    shell === "lightning",
  );
  expect(Boolean(screen.container.querySelector("[data-lightning-cosmic-backdrop='draft']"))).toBe(
    shell === "lightning",
  );
  expect(Boolean(screen.container.querySelector("[data-lightning-wordmark]"))).toBe(
    shell === "lightning",
  );
  expect(Boolean(screen.container.querySelector(".lightning-energy-wave"))).toBe(
    shell === "lightning",
  );
  if (shell === "classic") {
    const button = screen.getByRole("button", { name: "Add project" }).element();
    using frame = vi.spyOn(window, "requestAnimationFrame");
    movePointer(button);
    expect(frame).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-lightning-pointer-enabled")).toBe(false);
  }
});

function movePointer(element: Element, fx = 0.75, fy = 0.25) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerType: "mouse",
      clientX: rect.left + rect.width * fx,
      clientY: rect.top + rect.height * fy,
    }),
  );
}

it("lights adjacent card edges from one point and tilts only the hovered card", async () => {
  available.mockReturnValue("local");
  await using screen = await render(
    <WorkspaceShellProvider>
      <NoProjectsHero />
    </WorkspaceShellProvider>,
  );
  const cards = screen.container.querySelectorAll<HTMLElement>(".lightning-hardware-card");
  const first = cards.item(0);
  const second = cards.item(1);
  const badge = screen.container.querySelector<HTMLElement>(".lightning-hero-emblem")!;
  const bounds = first.getBoundingClientRect();
  const neighbor = second.getBoundingClientRect();
  const sideBySide = neighbor.left > bounds.right;
  movePointer(first, sideBySide ? 0.99 : 0.5, sideBySide ? 0.5 : 0.99);
  await vi.waitFor(() => expect(second.dataset.lightningPointer).toBe("card"));
  const axis = sideBySide ? "--lx" : "--ly";
  const edge = sideBySide ? "left" : "top";
  const local = (el: HTMLElement) => parseFloat(el.style.getPropertyValue(axis));
  expect(local(first) + bounds[edge]).toBeCloseTo(local(second) + neighbor[edge]);
  expect(first.style.getPropertyValue(sideBySide ? "--tilt-y" : "--tilt-x")).not.toBe("0deg");
  expect(second.style.getPropertyValue("--tilt-y")).toBe("0deg");
  movePointer(badge);
  await vi.waitFor(() => expect(badge.style.getPropertyValue("--tilt-y")).toBe("3deg"));
  expect(badge.style.getPropertyValue("--tilt-x")).toBe("3deg");
  expect(first.style.getPropertyValue("--lx")).toBe("");
  document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
  expect(badge.style.getPropertyValue("--tilt-x")).toBe("");
});

it("tracks the composer rim and magnet and stays dormant under reduced motion", async () => {
  const commits = vi.fn();
  await using screen = await render(
    <WorkspaceShellProvider>
      <Profiler id="composer" onRender={commits}>
        <div data-slot="composer-host" className="relative p-4">
          <button type="submit" aria-label="Send" className="size-8 rounded-full" />
        </div>
      </Profiler>
    </WorkspaceShellProvider>,
  );
  const button = screen.getByRole("button", { name: "Send" }).element() as HTMLButtonElement;
  const host = button.parentElement!;
  commits.mockClear();
  {
    using frames = vi.spyOn(window, "requestAnimationFrame");
    movePointer(button, 0.5, 0.5);
    movePointer(button);
    expect(frames).toHaveBeenCalledTimes(1);
  }
  await vi.waitFor(() => expect(button.style.getPropertyValue("--mag-x")).toBe("1.25px"));
  expect(button.style.getPropertyValue("--mag-y")).toBe("-1.25px");
  expect(commits).not.toHaveBeenCalled();
  expect(parseFloat(host.style.getPropertyValue("--lx"))).toBeGreaterThan(0);
  expect(getComputedStyle(host, "::after").backgroundImage).toContain("radial-gradient");
  const session = cdp();
  try {
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await vi.waitFor(() => expect(button.style.getPropertyValue("--mag-x")).toBe(""));
    expect(getComputedStyle(button).translate).toBe("none");
    expect(host.style.getPropertyValue("--lx")).toBe("");
    expect(host.dataset.lightningPointer).toBeUndefined();
    {
      using reducedFrame = vi.spyOn(window, "requestAnimationFrame");
      movePointer(button);
      expect(reducedFrame).not.toHaveBeenCalled();
    }
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute("data-lightning-pointer-enabled")).toBe(false),
    );
    {
      using frame = vi.spyOn(window, "requestAnimationFrame");
      movePointer(button);
      expect(frame).not.toHaveBeenCalled();
    }
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute("data-lightning-pointer-enabled")).toBe(true),
    );
    movePointer(button);
    await vi.waitFor(() => expect(host.dataset.lightningPointer).toBe("capsule"));
    movePointer(button);
    window.dispatchEvent(new Event("blur"));
    expect(host.style.getPropertyValue("--lx")).toBe("");
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

it("transitions composer telemetry across waiting, typing, sending, running, and voice states", async () => {
  const composer = (active: boolean, voice = false) => (
    <div className="relative h-64" data-chat-workspace-drop-target="true">
      {!active && <LightningCosmicBackdrop variant="draft" />}
      <form data-chat-composer-form="true">
        <div data-slot="composer-host">
          <input aria-label="Prompt" />
          <ComposerEnergyWave active={active} mode={voice ? "voice" : "running"} level={0.6} />
        </div>
      </form>
      <LightningWordmark />
      {active && <LightningThinkingPill label="Thinking" />}
    </div>
  );
  await using screen = await render(composer(false));
  const host = screen.container.querySelector('[data-slot="composer-host"]')!;
  const disc = screen.container.querySelector(".lightning-orbit-disc")!;
  await vi.waitFor(() =>
    expect(disc.closest("[data-lightning-cosmic-backdrop]")?.getAttribute("style")).toContain(
      "--visible-animation-state: running",
    ),
  );
  expect(getComputedStyle(disc).animationPlayState).toBe("paused");
  const input = screen.container.querySelector("input")!;
  const form = input.form!;
  using _timers = fakeTimers();
  expect(host.getAttribute("data-lightning-composer-state")).toBe("waiting");
  for (const band of screen.container.querySelectorAll(".lightning-wave-band")) {
    expect(getComputedStyle(band).animationPlayState).toBe("paused");
  }
  await act(() => input.focus());
  expect(host.getAttribute("data-lightning-composer-state")).toBe("typing");
  await act(() => input.blur());
  expect(host.getAttribute("data-lightning-composer-state")).toBe("waiting");
  await act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true }));
  });
  expect(host.getAttribute("data-lightning-composer-state")).toBe("waiting");
  await act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.getAttribute("data-lightning-composer-state")).toBe("typing");
  await act(() => {
    window.dispatchEvent(new Event("lightning:composer-send"));
  });
  expect(host.getAttribute("data-lightning-composer-state")).toBe("sending");
  expect(screen.container.querySelector(".lightning-brand-chip[data-charging]")).not.toBeNull();
  await screen.rerender(composer(true));
  expect(screen.container.querySelector(".lightning-warp-burst")).not.toBeNull();
  expect(host.getAttribute("data-lightning-composer-state")).toBe("sending");
  await act(() => vi.advanceTimersByTime(800));
  expect(host.getAttribute("data-lightning-composer-state")).toBe("running");

  await screen.rerender(composer(true, true));
  expect(screen.container.querySelector("[data-lightning-thinking-pill]")).not.toBeNull();
  expect(screen.container.querySelector("[data-lightning-energy-wave='voice']")).not.toBeNull();
  expect(
    screen.container
      .querySelector(".lightning-led-pattern")
      ?.closest("svg")
      ?.getAttribute("aria-hidden"),
  ).toBe("true");
});

it("pauses offscreen telemetry and respects reduced motion", async () => {
  await using screen = await render(
    <WorkspaceShellProvider>
      <section data-lightning-hero="" className="relative size-64">
        <LightningCosmicBackdrop />
        <LedMatrixIndicator />
        <ComposerEnergyWave active />
      </section>
    </WorkspaceShellProvider>,
  );
  const matrix = screen.container.querySelector(".lightning-led-pattern")!;
  const waveBand = screen.container.querySelector(".lightning-wave-band-front")!;
  const rim = screen.container.querySelector(".lightning-composer-rim-sweep")!;
  const orbit = screen.container.querySelector(".lightning-orbit-core")!;
  const session = cdp();
  try {
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await vi.waitFor(() => expect(getComputedStyle(matrix).animationPlayState).toBe("running"));
    await vi.waitFor(() => expect(getComputedStyle(waveBand).animationPlayState).toBe("running"));
    await vi.waitFor(() =>
      expect(getComputedStyle(rim, "::before").animationPlayState).toBe("running"),
    );
    expect(getComputedStyle(orbit).animationPlayState).toBe("paused");
    const sky = orbit.closest("[data-lightning-cosmic-backdrop]")!;
    const swarm = sky.querySelector<HTMLCanvasElement>(".lightning-orbit-swarm")!;
    expect(swarm.width).toBeGreaterThan(0);
    movePointer(sky.parentElement!);
    await vi.waitFor(() => expect(sky.hasAttribute("data-orbit-focus")).toBe(true));
    await vi.waitFor(() => expect(getComputedStyle(orbit).animationPlayState).toBe("running"));
    await vi.waitFor(() => expect(getComputedStyle(orbit).animationPlayState).toBe("paused"), {
      timeout: 2500,
    });
    sky.parentElement!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 96,
        clientY: 96,
        pointerType: "mouse",
      }),
    );
    document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
    expect(sky.hasAttribute("data-orbit-focus")).toBe(false);
    screen.container.hidden = true;
    await vi.waitFor(() => expect(getComputedStyle(matrix).animationPlayState).toBe("paused"));
    await vi.waitFor(() => expect(getComputedStyle(waveBand).animationPlayState).toBe("paused"));
    await vi.waitFor(() =>
      expect(getComputedStyle(rim, "::before").animationPlayState).toBe("paused"),
    );
    await vi.waitFor(() => expect(getComputedStyle(orbit).animationPlayState).toBe("paused"));
    screen.container.hidden = false;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(getComputedStyle(matrix).animationName).toBe("none");
    expect(getComputedStyle(waveBand).animationName).toBe("none");
    expect(getComputedStyle(rim, "::before").animationName).toBe("none");
    expect(getComputedStyle(orbit).animationName).toBe("none");
    await vi.waitFor(() => expect(swarm.width).toBe(0));
    movePointer(sky.parentElement!);
    expect(getComputedStyle(sky.querySelector(".lightning-zenith-beam")!).transform).toBe("none");
    expect(getComputedStyle(sky.querySelector(".lightning-horizon-arc")!).transform).toBe("none");
    window.dispatchEvent(new Event("lightning:composer-send"));
    expect(screen.container.querySelector(".lightning-warp-burst")).toBeNull();
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
