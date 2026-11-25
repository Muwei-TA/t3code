import { EnvironmentId, PlanId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProposedPlanCard } from "./ProposedPlanCard";

const ENV_ID = EnvironmentId.make("env-plan-browser");
const PLAN_ID = PlanId.make("plan:1");
const PLAN_MARKDOWN = "# Ship Portable Harness\n\n1. Add gateway\n2. Verify security";

describe("ProposedPlanCard", () => {
  it("renders execution actions only for active plans and gates worktree action on isGitRepo", async () => {
    const onImplementPlan = vi.fn(async () => undefined);
    const onContinuePlanning = vi.fn();

    // 1. Active plan in a Git repo shows Implement plan + Fresh context + Edit + Continue planning
    //    AND shows "Implement in new worktree" in the overflow menu.
    {
      await using screen = await render(
        <ProposedPlanCard
          planId={PLAN_ID}
          planStatus="active"
          planMarkdown={PLAN_MARKDOWN}
          environmentId={ENV_ID}
          cwd="/repo"
          workspaceRoot="/repo"
          isGitRepo
          canOperateThread
          onImplementPlan={onImplementPlan}
          onContinuePlanning={onContinuePlanning}
        />,
      );

      await expect.element(screen.getByRole("button", { name: "Implement plan" })).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Fresh context" })).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Edit" })).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Continue planning" })).toBeVisible();

      await screen.getByRole("button", { name: "Plan actions" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Implement in new worktree" }))
        .toBeVisible();
    }

    // 2. Active plan in a NON-Git workspace hides "Implement in new worktree" from the menu.
    {
      await using screen = await render(
        <ProposedPlanCard
          planId={PLAN_ID}
          planStatus="active"
          planMarkdown={PLAN_MARKDOWN}
          environmentId={ENV_ID}
          cwd="/scratch"
          workspaceRoot="/scratch"
          isGitRepo={false}
          canOperateThread
          onImplementPlan={onImplementPlan}
          onContinuePlanning={onContinuePlanning}
        />,
      );

      await screen.getByRole("button", { name: "Plan actions" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Clear context & implement" }))
        .toBeVisible();
      expect(page.getByRole("menuitem", { name: "Implement in new worktree" }).query()).toBeNull();
    }

    // 3. Completed and superseded plans hide execution buttons so users cannot trigger
    //    rejected `sourceProposedPlan` RPC calls.
    for (const status of ["completed", "superseded"] as const) {
      await using screen = await render(
        <ProposedPlanCard
          planId={PLAN_ID}
          planStatus={status}
          planMarkdown={PLAN_MARKDOWN}
          environmentId={ENV_ID}
          cwd="/repo"
          workspaceRoot="/repo"
          isGitRepo
          canOperateThread
          onImplementPlan={onImplementPlan}
          onContinuePlanning={onContinuePlanning}
        />,
      );

      expect(screen.getByRole("button", { name: "Implement plan" }).query()).toBeNull();
      expect(screen.getByRole("button", { name: "Fresh context" }).query()).toBeNull();
      expect(screen.getByRole("button", { name: "Edit" }).query()).toBeNull();
      expect(screen.getByRole("button", { name: "Continue planning" }).query()).toBeNull();
      await expect
        .element(screen.getByText(status === "completed" ? "Completed" : "Superseded"))
        .toBeVisible();
    }
  });
});
