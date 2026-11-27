import type { SVGProps } from "react";

export function LightningAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M13.4 2L4.2 13.4h6.3L9.3 22l10.5-12h-6.4L13.4 2Z" fill="currentColor" />
      <path d="M13.4 2L10.5 13.4H4.2L13.4 2Z" fill="currentColor" opacity="0.35" />
    </svg>
  );
}
