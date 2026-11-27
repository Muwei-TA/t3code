import { SidebarProvider } from "../ui/sidebar";
import { createContext, useState, type ComponentProps } from "react";

export function readLightningShell(): "lightning" | "classic" {
  try {
    if (window.localStorage.getItem("lightning:ui-shell") === "classic") return "classic";
  } catch {}
  return "lightning";
}

export const LightningShell = createContext<ReturnType<typeof readLightningShell>>("lightning");

export function WorkspaceShellProvider(props: ComponentProps<typeof SidebarProvider>) {
  const [shell] = useState(readLightningShell);
  return (
    <LightningShell value={shell}>
      <SidebarProvider {...props} data-ui-shell={shell} />
    </LightningShell>
  );
}
