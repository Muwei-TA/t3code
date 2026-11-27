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
  await vi.waitFor(() => expect(getComputedStyle(disc).animationPlayState).toBe("running"));
  const input = screen.container.querySelector("input")!;
  const form = input.form!;
  using _timers = fakeTimers();
  expect(host.getAttribute("data-lightning-composer-state")).toBe("waiting");
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
    <>
      <LightningCosmicBackdrop />
      <LedMatrixIndicator />
      <ComposerEnergyWave active />
    </>,
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
    await vi.waitFor(() => expect(getComputedStyle(orbit).animationPlayState).toBe("running"));
    const sky = orbit.closest("[data-lightning-cosmic-backdrop]")!;
    const bounds = sky.getBoundingClientRect();
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerType: "mouse",
        clientX: bounds.left + bounds.width * 0.75,
        clientY: bounds.top + bounds.height * 0.3,
      }),
    );
    await vi.waitFor(() => expect(sky.hasAttribute("data-orbit-focus")).toBe(true));
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
    window.dispatchEvent(new Event("lightning:composer-send"));
    expect(screen.container.querySelector(".lightning-warp-burst")).toBeNull();
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
