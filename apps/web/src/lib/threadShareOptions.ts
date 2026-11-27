import { THREAD_APP_LINK_SCHEMES } from "@t3tools/shared/threadLinks";

export function threadShareOptions() {
  const appScheme = THREAD_APP_LINK_SCHEMES.find(
    (scheme) => globalThis.location?.protocol === `${scheme}:`,
  );
  return { hostedAppUrl: import.meta.env.VITE_HOSTED_APP_URL, appScheme };
}
