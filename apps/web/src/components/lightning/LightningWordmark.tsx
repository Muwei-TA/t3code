import { APP_BASE_NAME } from "../../branding";
import { LightningAppIcon } from "./LightningAppIcon";

export function LightningWordmark() {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold tracking-tight">
      <span className="lightning-brand-chip inline-flex size-5.5 shrink-0 items-center justify-center rounded-md">
        <LightningAppIcon className="size-3.5 shrink-0" />
      </span>
      <span>{APP_BASE_NAME}</span>
    </span>
  );
}
