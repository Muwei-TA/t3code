import { createMemoryHistory } from "@tanstack/react-router";
import {
  WS_METHODS,
  type WorkflowRun,
  type WorkflowRunsSnapshot,
  type WorkflowStartInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import {
  ENVIRONMENT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("starts Workflow Mode from chat and answers a workflow question inline", async () => {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  await page.viewport(1280, 900);
  const thread = threadWithHistory("workflow-chat-browser", 1);
  using _environment = installFakeEnvironment([thread], { workflowChat: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const initial: WorkflowRunsSnapshot = {
    workflows: [
      {
        name: "audit-pipeline",
        version: 1,
        source: "yaml",
        chatModeCompatible: true,
        triggers: [],
      },
    ],
    runs: [],
    questions: [],
  };
  const now = "2026-11-26T00:00:00.000Z";
  const run: WorkflowRun = {
    runId: "workflow-mode-browser-run",
    workflow: "audit-pipeline",
    version: 1,
    title: "audit-pipeline",
    status: "waiting",
    detail: "priority",
    result: null,
    pauses: 0,
    retired: false,
    resumesAt: null,
    parentRunId: null,
    parentStep: null,
    hostThreadId: thread.id,
    startedAt: now,
    updatedAt: now,
    endedAt: null,
  };
  const waiting: WorkflowRunsSnapshot = {
    ...initial,
    runs: [run],
    questions: [
      {
        runId: run.runId,
        name: "priority",
        request: { title: "Which priority?", choices: ["Correctness", "Simplicity"] },
        askedAt: now,
        thread: null,
      },
    ],
  };
  const finished: WorkflowRunsSnapshot = {
    ...initial,
    runs: [
      {
        ...run,
        status: "completed",
        updatedAt: "2026-11-26T00:00:01.000Z",
        endedAt: "2026-11-26T00:00:01.000Z",
      },
    ],
  };
  const started = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const startCalls: WorkflowStartInput[] = [];
  const answers: unknown[] = [];
  using _snapshot = answerRpc(WS_METHODS.workflowsSubscribe, () =>
    Stream.concat(
      Stream.make(initial),
      Stream.concat(
        Stream.fromEffect(Effect.promise(() => started.promise).pipe(Effect.as(waiting))),
        Stream.concat(
          Stream.fromEffect(Effect.promise(() => answered.promise).pipe(Effect.as(finished))),
          Stream.never,
        ),
      ),
    ),
  );
  using _start = answerRpc(WS_METHODS.workflowsStart, (input: WorkflowStartInput) =>
    Effect.sync(() => {
      startCalls.push(input);
      started.resolve();
      return { runId: run.runId };
    }),
  );
  using _get = answerRpc(WS_METHODS.workflowsGet, () =>
    Effect.succeed({
      run,
      references: [],
      stages: [{ id: "priority", kind: "ask" }],
      steps: [],
    }),
  );
  using _answer = answerRpc(WS_METHODS.workflowsAnswer, (input) =>
    Effect.sync(() => {
      answers.push(input);
      answered.resolve();
    }),
  );
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  const mode = page.getByRole("button", { name: /Switch portable mode/ }).first();
  await vi.waitFor(() => {
    const state = appAtomRegistry.get(
      serverEnvironment.workflowsLive({
        environmentId: ENVIRONMENT_ID,
        input: { chat: { threadId: thread.id } },
      }),
    );
    expect(state._tag).toBe("Success");
  });
  await expect.element(mode).toBeVisible();
  await userEvent.click(mode);
  await userEvent.click(page.getByRole("menuitem", { name: "audit-pipeline" }));
  await userEvent.click(editor);
  await cdp().send("Input.insertText", { text: "Review the changes" });
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Which priority?", { exact: true })).toBeVisible();
  expect(startCalls).toEqual([
    expect.objectContaining({
      threadId: thread.id,
      workflow: "audit-pipeline",
      prompt: "Review the changes",
    }),
  ]);
  expect(dispatchedCommands().some((command) => command.type === "message.dispatch")).toBe(false);

  const card = page.getByRole("button", { name: "audit-pipeline", exact: true }).first();
  await userEvent.click(card);
  await expect.element(card).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(page.getByRole("button", { name: "Correctness", exact: true }).first());
  await vi.waitFor(() =>
    expect(answers).toEqual([{ runId: run.runId, name: "priority", choice: "Correctness" }]),
  );
});
