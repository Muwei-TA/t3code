import type { ContextMenuSource } from "@t3tools/contracts";
import type { KeyboardEvent } from "react";

// Chromium uses no button for keyboard context menus and zero clicks for keyboard activation.
export function contextMenuSourceOf(
  event: Pick<MouseEvent, "type" | "button" | "detail">,
): ContextMenuSource {
  return (event.type === "click" ? event.detail === 0 : event.button === -1) ? "keyboard" : "mouse";
}

export function handleContextMenuKey(
  event: KeyboardEvent<HTMLElement>,
  open: (position: { x: number; y: number }, source: ContextMenuSource) => void,
): void {
  if (
    event.defaultPrevented ||
    (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  const { left, bottom } = event.currentTarget.getBoundingClientRect();
  open({ x: left, y: bottom }, "keyboard");
}
