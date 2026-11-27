import { use } from "react";
import { LightningShell } from "./shell";
import { APP_BASE_NAME } from "../../branding";
import { LightningAppIcon, LightningHardwareBadge } from "./LightningAppIcon";

const [PRIMARY_WORD = APP_BASE_NAME, ...REST_WORDS] = APP_BASE_NAME.split(" ");
const SECONDARY_WORD = REST_WORDS.join(" ");

export function LightningWordmark() {
  if (use(LightningShell) === "classic") {
    return (
      <span className="inline-flex items-center gap-2 text-sm font-semibold">
        <LightningAppIcon mono className="size-4" />
        {APP_BASE_NAME}
      </span>
    );
  }
  return (
    <span
      data-lightning-wordmark=""
      className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold tracking-tight"
    >
      <LightningHardwareBadge />
      <span className="inline-flex items-baseline gap-1">
        <span className="lightning-wordmark-glow">{PRIMARY_WORD}</span>
        {SECONDARY_WORD ? (
          <>
            {" "}
            <span className="lightning-wordmark-sub">{SECONDARY_WORD}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}
