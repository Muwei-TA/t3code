import type { ReactNode } from "react";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import { LedMatrixIndicator } from "./LedMatrixIndicator";

export function LightningThinkingPill({
  label,
  trailing,
  compact = false,
  className,
}: {
  label: ReactNode;
  trailing?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      data-lightning-thinking-pill=""
      ref={observeVisibleAnimation}
      className={cn(
        "lightning-thinking-pill inline-flex max-w-full min-w-0 items-center rounded-full",
        compact ? "h-7 gap-2 px-2.5 text-xs" : "h-9 gap-2.5 px-3.5 text-sm",
        className,
      )}
    >
      <LedMatrixIndicator compact={compact} />
      <span className="lightning-thinking-text truncate font-medium tracking-tight tabular-nums">
        {label}
      </span>
      {trailing}
    </span>
  );
}
