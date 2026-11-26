import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ThreadContextManifest,
} from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ThreadContextInspectorButton } from "./ThreadContextInspectorButton";

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: manifest }),
}));

const reason = "Tool filters require routing through T3 Gateway.";
const error = "MCP server disconnected unexpectedly";
const manifest: ThreadContextManifest = {
  threadId: ThreadId.make("test-thread"),
  generatedAt: "2026-11-26T00:00:00Z",
  providerInstanceId: ProviderInstanceId.make("codex"),
  interactionMode: "default",
  planModeSource: "native",
  planModeReadOnlyEnforcement: "native",
  harnessGatewayActive: true,
  mcpServers: [
    {
      id: "project-server",
      scope: "project",
      channel: "gateway",
      state: "connected",
      toolCount: 1,
      estimatedToolListBytes: 0,
      reason,
    },
    {
      id: "user-server",
      scope: "user",
      channel: "gateway",
      state: "error",
      toolCount: 0,
      estimatedToolListBytes: 0,
      reason: error,
    },
  ],
  degradedItems: [
    { kind: "mcp", id: "project-server", reason },
    { kind: "mcp", id: "user-server", reason: error },
  ],
};

it("opens Harness status and localizes scopes and static notices in Chinese", async () => {
  const translations = await getTranslationsSnapshot("zh");
  await using screen = await render(
    <GTProvider locale="zh" translations={translations}>
      <ThreadContextInspectorButton
        environmentId={EnvironmentId.make("test-environment")}
        threadId={manifest.threadId}
      />
    </GTProvider>,
  );

  const button = screen.getByRole("button", { name: "查看 Harness 状态" });
  await expect.element(button.getByText("Harness", { exact: true })).toBeVisible();
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Harness 状态" });
  const translatedReason = "工具筛选需要通过 T3 网关路由。";
  await expect.element(dialog.getByText("项目", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("用户", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText(translatedReason, { exact: true })).toBeVisible();
  await expect
    .element(dialog.getByRole("listitem").filter({ hasText: translatedReason }))
    .toBeVisible();
  await expect.element(dialog.getByText(error, { exact: true })).toBeVisible();
  await expect.element(dialog.getByRole("listitem").filter({ hasText: error })).toBeVisible();
});
