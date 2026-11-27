import {
  HarnessAgentsMdSaveInput,
  HarnessCommandId,
  HarnessCommandUpsertInput,
  HarnessError,
  HarnessHookUpsertInput,
  HarnessInstallSkillPackageInput,
  HarnessMcpServerConfig,
  HarnessMcpServerId,
  HarnessModeId,
  HarnessModeUpsertInput,
  HarnessPluginId,
  HarnessRuleId,
  HarnessRuleUpsertInput,
  HarnessSkillId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import type { WorkflowDefinitions } from "../workflows/WorkflowRuntime.ts";
import { compileAndValidateDeclarativeWorkflow } from "./DeclarativeWorkflowCompiler.ts";
import { getDeliveryMatrix } from "./deliveryMatrix.ts";
import type { HarnessLibraryStore } from "./HarnessLibraryStore.ts";
import type { HarnessHooksService } from "./HarnessHooksService.ts";
import type { HarnessStore } from "./HarnessStore.ts";
import type { PluginHost } from "./PluginHost.ts";

const action = Schema.Literals(["upsert", "delete"]);
const rule = Schema.Struct({
  ...HarnessRuleUpsertInput.fields,
  apply: Schema.optionalKey(HarnessRuleUpsertInput.fields.apply),
  body: Schema.optionalKey(HarnessRuleUpsertInput.fields.body),
  id: Schema.String,
  action,
});
const command = Schema.Struct({
  ...HarnessCommandUpsertInput.fields,
  body: Schema.optionalKey(HarnessCommandUpsertInput.fields.body),
  action,
});
const mode = Schema.Struct({
  ...HarnessModeUpsertInput.fields,
  baseInteractionMode: Schema.optionalKey(HarnessModeUpsertInput.fields.baseInteractionMode),
  body: Schema.optionalKey(HarnessModeUpsertInput.fields.body),
  action,
});
const workflow = Schema.Struct({
  id: HarnessRuleId,
  action,
  yaml: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262144))),
});
const plugin = Schema.Struct({
  sourceDir: TrimmedNonEmptyString,
  id: Schema.optionalKey(HarnessPluginId),
});
const server = Schema.Struct({ id: HarnessMcpServerId, config: HarnessMcpServerConfig });
const readFile = Schema.Struct({ skillId: HarnessSkillId, relativePath: TrimmedNonEmptyString });
const tool = (name: string, description: string, schema: Schema.Top, readOnly = false) => {
  const document = Schema.toJsonSchemaDocument(schema);
  const inputSchema: Record<string, unknown> = { ...document.schema, $defs: document.definitions };
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    Reflect.deleteProperty(inputSchema.properties, "workspaceRoot");
    Reflect.deleteProperty(inputSchema.properties, "overrideBuiltin");
  }
  return {
    exposedName: name,
    upstreamName: name,
    serverId: null,
    description,
    inputSchema,
    readOnly,
  };
};

export const managementTools = [
  tool(
    "harness_inspect",
    "Inspect the T3 harness paths, installed assets and provider delivery matrix.",
    Schema.Struct({}),
    true,
  ),
  tool(
    "harness_skill_read_file",
    "Read a file from an enabled skill by package-relative path.",
    readFile,
    true,
  ),
  tool(
    "harness_install_skill",
    "Install or replace a skill package. Supply exactly one of an absolute server sourceDir or files, including SKILL.md.",
    HarnessInstallSkillPackageInput,
  ),
  tool(
    "harness_manage_rule",
    "Upsert or delete a personal rule. Use id AGENTS.md for personal instructions.",
    rule,
  ),
  tool("harness_manage_command", "Upsert or delete a portable slash command.", command),
  tool("harness_manage_mode", "Upsert or delete a portable mode.", mode),
  tool(
    "harness_manage_workflow",
    "Validate and save a declarative workflow as <id>.yaml, or delete it.",
    workflow,
  ),
  tool(
    "harness_propose_mcp",
    "Propose a disabled MCP server for user approval. Choose an unused id.",
    server,
  ),
  tool(
    "harness_propose_hook",
    "Propose a disabled hook for user approval. Choose an unused id.",
    HarnessHookUpsertInput,
  ),
  tool(
    "harness_install_plugin",
    "Install a plugin from an absolute server directory for review. Requires user trust before activation.",
    plugin,
  ),
];

const invalid = (detail: string) => new HarnessError({ code: "invalid_config", detail });
const decode = <S extends Schema.Top & { DecodingServices: never }>(schema: S, input: unknown) => {
  return Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => invalid("Invalid tool arguments.")),
  );
};

export const callManagementTool = Effect.fn("Harness.callManagementTool")(function* (
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string | undefined,
  lib: HarnessLibraryStore["Service"],
  services: {
    path: Path.Path;
    definitions: Option.Option<WorkflowDefinitions["Service"]>;
    store: Option.Option<HarnessStore["Service"]>;
    instances: Option.Option<ProviderInstanceRegistry["Service"]>;
    plugins: Option.Option<PluginHost["Service"]>;
    hooks: Option.Option<HarnessHooksService["Service"]>;
  },
): Effect.fn.Return<unknown, HarnessError> {
  const snapshot = lib.getSnapshot(workspaceRoot);
  const { workspaceRoot: _ignored, ...parameters } = args;
  const input = { ...parameters, ...(workspaceRoot ? { workspaceRoot } : {}) };
  const unavailable = invalid("Harness service unavailable.");
  switch (name) {
    case "harness_inspect": {
      if (Option.isNone(services.instances) || Option.isNone(services.store))
        return yield* unavailable;
      const library = yield* snapshot;
      const config = yield* services.store.value.resolveWorkspace(workspaceRoot);
      const plugins = Option.isSome(services.plugins)
        ? (yield* services.plugins.value.list()).plugins
        : [];
      const hooks = Option.isSome(services.hooks) ? (yield* services.hooks.value.list()).hooks : [];
      return {
        harnessDir: library.harnessDir,
        projectAgentsDir: library.workspaceRoot
          ? services.path.join(library.workspaceRoot, ".agents")
          : null,
        skills: library.skills.map(({ id, scope, sourcePath }) => ({ id, scope, sourcePath })),
        rules: library.rules.map((r) => r.id),
        commands: library.commands.map((c) => c.id),
        modes: library.modes.map((m) => m.id),
        workflows:
          library.managedPolicyAllowsHarness && Option.isSome(services.definitions)
            ? (yield* services.definitions.value.read).files
                .map((file) => file.name)
                .filter((name) => /\.ya?ml$/iu.test(name))
            : [],
        plugins: plugins.map(({ id, trustStatus, enabled }) => ({ id, trustStatus, enabled })),
        hooks: hooks.map(({ id, enabled, pendingApproval }) => ({ id, enabled, pendingApproval })),
        mcpServers: config.servers.map(({ id, effectiveEnabled, config }) => ({
          id,
          effectiveEnabled,
          pendingApproval: config.pendingApproval,
        })),
        deliveryMatrix: yield* getDeliveryMatrix(services.instances.value),
      };
    }
    case "harness_skill_read_file": {
      const { skillId, relativePath } = yield* decode(readFile, args);
      const detail = yield* lib.getSkillDetail({ nameOrId: skillId, workspaceRoot });
      if (Option.isNone(detail)) return yield* invalid("Skill is missing or disabled.");
      const skill = detail.value.skill;
      return yield* lib.readSkillFile({
        id: skill.id,
        scope: skill.scope,
        relativePath,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      });
    }
    case "harness_install_skill": {
      const request = yield* decode(HarnessInstallSkillPackageInput, input);
      const saved = yield* lib.installSkillPackage(request);
      const skill = saved.skills.find((s) => s.scope === request.scope && s.id === request.id);
      if (!skill) return yield* invalid("Installed skill could not be discovered.");
      return { id: skill.id, scope: skill.scope, sourcePath: skill.sourcePath };
    }
    case "harness_manage_rule": {
      const previous = yield* snapshot;
      const request = yield* decode(rule, input);
      if (request.id === "AGENTS.md") {
        yield* lib.saveUserAgentsMd(
          yield* decode(HarnessAgentsMdSaveInput, {
            ...input,
            body: request.action === "delete" ? "" : request.body,
          }),
        );
        return { id: request.id, previous: previous.userAgentsMd };
      }
      const id = yield* decode(HarnessRuleId, request.id);
      if (request.action === "delete") yield* lib.removeUserRule({ id, workspaceRoot });
      else yield* lib.upsertUserRule(yield* decode(HarnessRuleUpsertInput, input));
      return {
        id,
        previous: previous.rules.find((r) => r.id === id && r.scope === "user") ?? null,
      };
    }
    case "harness_manage_command": {
      const request = yield* decode(command, input);
      const id = yield* decode(HarnessCommandId, request.id);
      if (request.action === "delete") yield* lib.removeUserCommand({ id, workspaceRoot });
      else yield* lib.upsertUserCommand(yield* decode(HarnessCommandUpsertInput, input));
      return { id, action: request.action };
    }
    case "harness_manage_mode": {
      const request = yield* decode(mode, input);
      const id = yield* decode(HarnessModeId, request.id);
      if (request.action === "delete") yield* lib.removeUserMode({ id, workspaceRoot });
      else
        yield* lib.upsertUserMode(
          yield* decode(HarnessModeUpsertInput, { ...input, overrideBuiltin: false }),
        );
      return { id, action: request.action };
    }
    case "harness_manage_workflow": {
      const request = yield* decode(workflow, args);
      if (Option.isNone(services.definitions)) return yield* unavailable;
      const library = yield* snapshot;
      if (!library.managedPolicyAllowsHarness)
        return yield* new HarnessError({
          code: "policy_denied",
          detail: "Managed policy disables portable harness extensions.",
        });
      const fileName = request.id + ".yaml";
      const definitions = services.definitions.value;
      const yaml = request.yaml ?? "";
      if (request.action === "upsert") {
        const validation = compileAndValidateDeclarativeWorkflow(
          yaml,
          new Set(library.modes.map((m) => m.id)),
        );
        if (!validation.valid)
          return yield* invalid(validation.issues.map((issue) => issue.message).join(" "));
      }
      const result = yield* request.action === "upsert"
        ? definitions.save(fileName, yaml)
        : definitions.remove(fileName);
      if (!result.changed)
        return yield* invalid(result.problems.map((problem) => problem.message).join(" "));
      return result;
    }
    case "harness_propose_mcp": {
      if (Option.isNone(services.store)) return yield* unavailable;
      const request = yield* decode(server, args);
      const config = {
        ...request.config,
        enabled: false,
        pendingApproval: true,
        origin: { kind: "user" as const, source: "agent" },
      };
      const result = yield* services.store.value.importUserServers({
        entries: [{ id: request.id, config }],
      });
      if (!result.importedIds.length) return yield* invalid("Server id is already installed.");
      return { id: request.id, enabled: false, pendingApproval: true };
    }
    case "harness_propose_hook": {
      if (Option.isNone(services.hooks)) return yield* unavailable;
      const request = yield* decode(HarnessHookUpsertInput, args);
      yield* services.hooks.value.upsertUserHook(request, true);
      return { id: request.id, enabled: false, pendingApproval: true };
    }
    case "harness_install_plugin": {
      if (Option.isNone(services.plugins) || Option.isNone(services.store))
        return yield* unavailable;
      if (!services.store.value.managedPolicyAllowsPlugins)
        return yield* new HarnessError({
          code: "policy_denied",
          detail: "Plugins are disabled by managed policy.",
        });
      const request = yield* decode(plugin, args);
      const risk = yield* services.plugins.value.inspectExecutableRisk({
        kind: "sourcePath",
        sourcePath: request.sourceDir,
        id: request.id,
      });
      const snapshot = yield* services.plugins.value.install({
        expectedContentDigest: risk.contentDigest,
        sourcePath: request.sourceDir,
        ...(request.id ? { id: request.id } : {}),
        trustOnInstall: false,
        createOnly: true,
      });
      const installed = snapshot.plugins.find((p) => p.id === (request.id ?? risk.id));
      if (!installed) return yield* invalid("Installed plugin could not be discovered.");
      return {
        id: installed.id,
        contentDigest: installed.contentDigest,
        enabled: installed.enabled,
        trustStatus: installed.trustStatus,
        pendingApproval: true,
      };
    }
    default:
      return yield* invalid("Unknown management tool.");
  }
});
