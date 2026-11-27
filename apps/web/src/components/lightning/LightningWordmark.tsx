import { APP_BASE_NAME } from "../../branding";
import { LightningAppIcon } from "./LightningAppIcon";

export function LightningWordmark() {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold tracking-tight">
      <LightningAppIcon className="size-4 shrink-0" />
      {APP_BASE_NAME}
    </span>
  );
}
