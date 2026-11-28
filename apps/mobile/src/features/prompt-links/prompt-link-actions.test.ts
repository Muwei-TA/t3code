import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  copy: vi.fn(async () => true),
  share: {
    hostedAppUrl: undefined as string | undefined,
    appScheme: "lightningcode-preview" as const,
  },
}));

vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: fixture.copy }));
vi.mock("../../lib/hostedThreadLinkOrigin", () => ({ mobileThreadShareOptions: fixture.share }));
vi.mock("../../state/use-composer-drafts", () => ({}));

import { copyPromptLink } from "./prompt-link-actions";

it.each([
  [undefined, "lightningcode-preview://new?prompt=Review"],
  ["https://lightning.example", "https://lightning.example/new?prompt=Review"],
])("copies a prompt using the mobile link configuration (%s)", async (origin, href) => {
  fixture.share.hostedAppUrl = origin;
  await copyPromptLink("Review");
  expect(fixture.copy).toHaveBeenLastCalledWith(href, { target: "prompt link" });
});
