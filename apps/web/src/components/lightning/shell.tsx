import { createContext, useEffect, useState, type ComponentProps } from "react";
import { SidebarProvider } from "../ui/sidebar";
import { observeLightningPointer } from "./pointerInteractive";

export function readLightningShell(): "lightning" | "classic" {
  try {
    if (window.localStorage.getItem("lightning:ui-shell") === "classic") return "classic";
  } catch {}
  return "lightning";
}

export const LightningShell =
  createContext<ReturnType<typeof readLightningShell>>(readLightningShell());

export function WorkspaceShellProvider(props: ComponentProps<typeof SidebarProvider>) {
  const [shell] = useState(readLightningShell);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delegates hardware pointer input for the mounted workspace
  useEffect(() => {
    if (shell === "lightning") return observeLightningPointer();
  }, [shell]);
  return (
    <LightningShell value={shell}>
      <SidebarProvider {...props} data-ui-shell={shell} />
    </LightningShell>
  );
}
