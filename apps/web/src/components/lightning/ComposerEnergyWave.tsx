import { use } from "react";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { LightningShell } from "./shell";

export function ComposerEnergyWave({ active }: { active: boolean }) {
  if (!active || use(LightningShell) === "classic") return null;
  return (
    <span aria-hidden="true" ref={observeVisibleAnimation} className="lightning-energy-wave" />
  );
}
