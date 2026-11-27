import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
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
import { WorkspaceStatus } from "./WorkspaceStatus";

export function LightningHeroStage({ onScratch }: { onScratch: (() => void) | null }) {
  const gt = useGT();
  const bindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(bindings, "commandPalette.toggle");
  return (
    <section
      data-lightning-hero=""
      className="relative isolate grid flex-1 place-items-center overflow-auto scrollbar-gutter-both px-5 py-12 text-center"
    >
      <div className="my-auto flex w-full max-w-2xl flex-col items-center">
        <div className="mb-6 grid size-14 place-items-center rounded-2xl border border-foreground/10 bg-card shadow-lg inset-shadow-2xs inset-shadow-foreground/10">
          <LightningAppIcon className="size-8" />
        </div>
        <WorkspaceStatus hero />
        <h1 className="mt-4 text-balance text-4xl leading-none sm:text-5xl lg:text-6xl font-medium tracking-tight">
          <T>What should we work on?</T>
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          {onScratch
            ? gt("Add a project, or start without one.")
            : gt("Add a project to start your first thread.")}
        </p>
        <div className="mt-8 inline-flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-3xl border border-foreground/10 bg-card p-2 shadow-xl/10 inset-shadow-2xs inset-shadow-foreground/5">
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
          <Button
            size="sm-pill"
            variant="ghost-muted"
            aria-label={gt("Command palette")}
            onClick={() => openCommandPalette()}
          >
            {shortcut ? <kbd className="font-mono text-xs">{shortcut}</kbd> : <CommandIcon />}
          </Button>
        </div>
        <nav aria-label={gt("Workspace")} className="mt-7 flex flex-wrap justify-center gap-2">
          {[
            { to: "/settings/connections", label: gt("Connections"), Icon: MonitorIcon },
            { to: "/harness", label: gt("Harness"), Icon: BlocksIcon },
          ].map(({ to, label, Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2 rounded-lg border border-foreground/10 bg-background/80 px-3 py-2 text-xs text-muted-foreground hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon aria-hidden className="size-3.5" />
              {label}
              <ArrowUpRightIcon aria-hidden className="ml-2 size-3" />
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
