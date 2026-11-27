import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  ArrowUpIcon,
  ArrowUpRightIcon,
  BlocksIcon,
  CommandIcon,
  MonitorIcon,
  PlusIcon,
  SquareDashedIcon,
} from "lucide-react";
import { openCommandPalette } from "../../commandPaletteBus";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { LightningAppIcon } from "./LightningAppIcon";
import { LightningCosmicBackdrop } from "./LightningCosmicBackdrop";
import { WorkspaceStatus } from "./WorkspaceStatus";

export function LightningHeroStage({ onScratch }: { onScratch: (() => void) | null }) {
  const gt = useGT();
  const bindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(bindings, "commandPalette.toggle");
  const primaryLaunch = () => {
    if (onScratch) onScratch();
    else openCommandPalette({ open: "add-project" });
  };

  return (
    <section
      data-lightning-hero=""
      className="relative isolate grid flex-1 place-items-center overflow-auto scrollbar-gutter-both px-5 py-12 text-center"
    >
      <LightningCosmicBackdrop variant="hero" />
      <div className="relative z-10 my-auto flex w-full max-w-3xl flex-col items-center">
        <div className="lightning-hero-emblem mb-5 grid size-13 place-items-center rounded-2xl">
          <LightningAppIcon className="size-7" />
        </div>
        <div className="lightning-eyebrow-pill mb-5 inline-flex items-center rounded-full px-3 py-1">
          <WorkspaceStatus hero />
        </div>
        <h1 className="lightning-hero-title text-balance text-4xl leading-none font-medium tracking-tight sm:text-5xl lg:text-6xl">
          <T>What should we work on?</T>
        </h1>
        <p className="mt-4 max-w-md text-sm text-muted-foreground sm:text-base">
          {onScratch
            ? gt("Add a project, or start without one.")
            : gt("Add a project to start your first thread.")}
        </p>

        {/* Floating Krea-inspired double-bevel obsidian command capsule */}
        <div className="lightning-hero-capsule-moat mt-9 w-full max-w-2xl">
          <div className="lightning-hero-capsule relative flex flex-col overflow-hidden text-left">
            <button
              type="button"
              onClick={primaryLaunch}
              className="group flex w-full cursor-pointer items-center justify-between gap-4 px-5 pt-5 pb-4 text-left focus-visible:outline-none"
            >
              <span className="truncate text-base text-muted-foreground/80 transition-colors group-hover:text-foreground">
                {gt("Ask anything...")}
              </span>
              <span
                aria-hidden="true"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform group-hover:scale-105"
              >
                <ArrowUpIcon className="size-4 stroke-2" />
              </span>
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pb-3.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm-pill" onClick={() => openCommandPalette({ open: "add-project" })}>
                  <PlusIcon />
                  <T>Add project</T>
                </Button>
                {onScratch ? (
                  <Button size="sm-pill" variant="ghost" onClick={onScratch}>
                    <SquareDashedIcon />
                    <T>Start without a project</T>
                  </Button>
                ) : null}
              </div>
              <Button
                size="sm-pill"
                variant="ghost-muted"
                aria-label={gt("Command palette")}
                onClick={() => openCommandPalette()}
              >
                {shortcut ? <kbd className="font-mono text-xs">{shortcut}</kbd> : <CommandIcon />}
              </Button>
            </div>
            <span aria-hidden="true" className="lightning-hero-capsule-glow" />
          </div>
        </div>

        {/* Design+Code precision hardware quick cards */}
        <nav
          aria-label={gt("Workspace")}
          className="mt-7 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2"
        >
          {[
            {
              index: "01",
              to: "/settings/connections",
              label: gt("Connections"),
              Icon: MonitorIcon,
            },
            {
              index: "02",
              to: "/harness",
              label: gt("Harness"),
              Icon: BlocksIcon,
            },
          ].map(({ index, to, label, Icon }) => (
            <Link
              key={to}
              to={to}
              className="lightning-hardware-card group flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="font-mono text-3xs tracking-widest text-muted-foreground/60">
                  {index}
                </span>
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/4 text-muted-foreground transition-colors group-hover:text-foreground">
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <span className="truncate text-sm font-medium text-foreground/90 group-hover:text-foreground">
                  {label}
                </span>
              </span>
              <ArrowUpRightIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
              />
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
