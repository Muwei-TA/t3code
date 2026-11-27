import { useId, type SVGProps } from "react";

export function LightningAppIcon({
  mono = false,
  ...props
}: SVGProps<SVGSVGElement> & { mono?: boolean }) {
  const uid = useId().replaceAll(":", "");
  const gradId = `lc-bolt-${uid}`;
  const sheenId = `lc-bolt-sheen-${uid}`;

  if (mono) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
        <path d="M13.4 2L4.2 13.4h6.3L9.3 22l10.5-12h-6.4L13.4 2Z" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={gradId} x1="25%" y1="5%" x2="75%" y2="95%">
          <stop offset="0%" className="lightning-bolt-stop-core" />
          <stop offset="48%" className="lightning-bolt-stop-amber" />
          <stop offset="100%" className="lightning-bolt-stop-ember" />
        </linearGradient>
        <linearGradient id={sheenId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" className="lightning-mask-white" stopOpacity="0.82" />
          <stop offset="100%" className="lightning-mask-white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M13.6 1.8L4 13.4h6.4L9.1 22.2 20 10h-6.5l.1-8.2Z" fill={`url(#${gradId})`} />
      <path d="M13.6 1.8L10.4 13.4H4L13.6 1.8Z" fill={`url(#${sheenId})`} />
    </svg>
  );
}
