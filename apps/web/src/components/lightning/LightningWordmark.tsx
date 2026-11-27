import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { APP_BASE_NAME } from "../../branding";
import { LightningAppIcon } from "./LightningAppIcon";

const [PRIMARY_WORD = APP_BASE_NAME, ...REST_WORDS] = APP_BASE_NAME.split(" ");
const SECONDARY_WORD = REST_WORDS.join(" ");

export function LightningWordmark() {
  return (
    <span
      ref={observeVisibleAnimation}
      className="lightning-wordmark group/brand inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold tracking-tight"
    >
      <span className="lightning-brand-chip relative inline-flex size-6.5 shrink-0 items-center justify-center overflow-hidden rounded-lg">
        <span aria-hidden="true" className="lightning-brand-chip-grid" />
        <LightningAppIcon className="lightning-brand-bolt relative z-10 size-4 shrink-0" />
        <span aria-hidden="true" className="lightning-brand-chip-prism" />
      </span>
      <span className="inline-flex items-baseline gap-1">
        <span className="lightning-wordmark-glow">{PRIMARY_WORD}</span>
        {SECONDARY_WORD ? <span className="lightning-wordmark-sub">{SECONDARY_WORD}</span> : null}
      </span>
    </span>
  );
}
