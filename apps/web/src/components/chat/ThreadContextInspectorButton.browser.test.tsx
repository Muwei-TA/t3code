import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ThreadContextInspectorButton } from "./ThreadContextInspectorButton";

it("opens Harness status from the Harness composer button", async () => {
  await using screen = await render(
    <ThreadContextInspectorButton
      environmentId={EnvironmentId.make("test-environment")}
      threadId={ThreadId.make("test-thread")}
    />,
  );

  const button = screen.getByRole("button", { name: "Inspect harness status" });
  await expect.element(button.getByText("Harness", { exact: true })).toBeVisible();
  await button.click();
  await expect.element(page.getByRole("dialog", { name: "Harness status" })).toBeVisible();
});
