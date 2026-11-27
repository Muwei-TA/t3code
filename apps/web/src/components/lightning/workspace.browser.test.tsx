import { cdp } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { NoProjectsHero } from "../NoProjectsHero";
import { WorkspaceShellProvider } from "./shell";
import { ComposerEnergyWave } from "./ComposerEnergyWave";
import { LedMatrixIndicator } from "./LedMatrixIndicator";
import { LightningCosmicBackdrop } from "./LightningCosmicBackdrop";
import { LightningThinkingPill } from "./LightningThinkingPill";
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
  expect(Boolean(screen.container.querySelector(".lightning-energy-wave"))).toBe(
    shell === "lightning",
  );
});

it("keeps scratch unavailable and draws telemetry only while active", async () => {
  available.mockReturnValue(null);
  await using screen = await render(
    <>
      <NoProjectsHero />
      <ComposerEnergyWave active={false} />
    </>,
  );
  expect(screen.container.querySelector(".lightning-energy-wave")).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Start without a project" }))
    .not.toBeInTheDocument();
  await screen.rerender(
    <>
      <LightningThinkingPill label="Thinking" />
      <ComposerEnergyWave active mode="voice" level={0.6} />
    </>,
  );
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
      <LedMatrixIndicator />
      <ComposerEnergyWave active />
    </>,
  );
  const matrix = screen.container.querySelector(".lightning-led-pattern")!;
  const waveBand = screen.container.querySelector(".lightning-wave-band-front")!;
  const session = cdp();
  try {
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await vi.waitFor(() => expect(getComputedStyle(matrix).animationPlayState).toBe("running"));
    await vi.waitFor(() => expect(getComputedStyle(waveBand).animationPlayState).toBe("running"));
    screen.container.hidden = true;
    await vi.waitFor(() => expect(getComputedStyle(matrix).animationPlayState).toBe("paused"));
    await vi.waitFor(() => expect(getComputedStyle(waveBand).animationPlayState).toBe("paused"));
    screen.container.hidden = false;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(getComputedStyle(matrix).animationName).toBe("none");
    expect(getComputedStyle(waveBand).animationName).toBe("none");
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
