import {
  DEFAULT_HARNESS_CAPABILITIES,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  mcpResourceContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Mentions from "./HarnessMcpResourceMentions.ts";
import * as McpGateway from "./McpGateway.ts";

it.effect(
  "reads only the referenced project's text resources and keeps binary content out of prompts",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment");
      const projectId = ProjectId.make("project");
      const url = (name: string) => `t3-harness://fixture/memo%3A${name}`;
      const selected = mcpResourceContextRecord(environmentId, projectId, url("selected"), "Guide");
      const binary = mcpResourceContextRecord(
        environmentId,
        projectId,
        url("binary"),
        "Binary guide",
      );
      const otherProject = mcpResourceContextRecord(
        environmentId,
        ProjectId.make("other"),
        url("ignored-project"),
        "Mixed project",
      );
      const otherEnvironment = mcpResourceContextRecord(
        EnvironmentId.make("other"),
        projectId,
        url("ignored-env"),
        "Mixed environment",
      );
      const unreferenced = mcpResourceContextRecord(
        environmentId,
        projectId,
        url("unreferenced"),
        "Unused",
      );
      const reads: string[] = [];
      const render = yield* Mentions.makeMessageProjector.pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(McpGateway.McpGateway)({
              readResourceForSession: ({ uri, connectedOnly, context }) =>
                Effect.sync(() => {
                  assert.isTrue(connectedOnly);
                  assert.equal(context.workspaceRoot, "/repo/worktree");
                  reads.push(uri);
                  return {
                    contents:
                      uri === binary.uri
                        ? [{ uri, mimeType: "application/octet-stream", blob: "YXNkZg==" }]
                        : [{ uri, mimeType: "text/plain", text: "The handbook has a blue cover." }],
                  };
                }),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
        ),
      );
      const records = [selected, binary, otherProject, otherEnvironment];
      const text = records.map(formatComposerContextReference).join(" ");
      const projected = yield* render(
        { text, records: [...records, unreferenced] },
        {
          id: ThreadId.make("thread"),
          projectId,
          worktreePath: "/repo/worktree",
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        undefined,
        DEFAULT_HARNESS_CAPABILITIES,
      );
      assert.deepEqual(reads, [selected.uri, binary.uri]);
      assert.include(projected, "The handbook has a blue cover.");
      assert.include(projected, "MCP resource unavailable: Binary guide");
      assert.notInclude(projected, "YXNkZg==");
    }),
);
