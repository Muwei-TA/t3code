// @effect-diagnostics nodeBuiltinImport:off -- Server-local CSPRNG HMAC binds export preview plans to prevent TOCTOU drift before writing CLI configs.
import * as NodeCrypto from "node:crypto";
import {
  HarnessError,
  type HarnessExportApplyInput,
  type HarnessExportApplyResult,
  type HarnessExportFileAction,
  type HarnessExportPreviewFile,
  type HarnessExportPreviewInput,
  type HarnessExportPreviewResult,
  type HarnessExportSection,
  type HarnessExportTarget,
  type HarnessMcpServerConfig,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import {
  formatCommandMarkdown,
  formatMarkdownWithFrontmatter,
  formatSkillMarkdown,
  sha256Hex,
} from "./HarnessLibraryStore.ts";
import { configContainsSecretPlaceholder, redactHarnessServerConfig } from "./HarnessSecrets.ts";
import * as HarnessStore from "./HarnessStore.ts";
import { safeReadFileUtf8, safeWriteFileAtomic } from "./safeFileOps.ts";

const ALL_SECTIONS: ReadonlyArray<HarnessExportSection> = ["mcp", "skills", "rules", "commands"];
const MAX_SNIPPET_CHARS = 800;

const MANAGED_RULES_BEGIN = "<!-- T3-HARNESS-BEGIN -->";
const MANAGED_RULES_END = "<!-- T3-HARNESS-END -->";
const MANAGED_RULES_BLOCK =
  /^<!-- T3-HARNESS-BEGIN -->\r?\n(?:(?!^<!-- T3-HARNESS-(?:BEGIN|END) -->\r?$)[\s\S])*?^<!-- T3-HARNESS-END -->(?=\r?$)/mu;

interface PlannedExportFile {
  readonly targetPath: string;
  readonly action: HarnessExportFileAction;
  readonly section: HarnessExportSection;
  readonly itemId: string;
  readonly content: string;
  readonly redactedPreviewContent: string;
  readonly hasSecretPlaceholders: boolean;
}

function truncateSnippet(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}\n…` : text;
}

function tomlEscapeString(value: string): string {
  return JSON.stringify(value);
}

function tomlKeySegment(key: string): string {
  return /^[a-zA-Z0-9_-]+$/u.test(key) ? key : tomlEscapeString(key);
}

function renderCodexMcpServerToml(id: string, config: HarnessMcpServerConfig): string {
  const lines: Array<string> = [`[mcp_servers.${tomlKeySegment(id)}]`];
  if (!config.enabled) {
    lines.push("enabled = false");
  }
  if (config.transport.type === "stdio") {
    lines.push(`command = ${tomlEscapeString(config.transport.command)}`);
    if (config.transport.args && config.transport.args.length > 0) {
      lines.push(`args = [${config.transport.args.map(tomlEscapeString).join(", ")}]`);
    }
    if (config.transport.cwd) {
      lines.push(`cwd = ${tomlEscapeString(config.transport.cwd)}`);
    }
    if (config.transport.env && Object.keys(config.transport.env).length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${tomlKeySegment(id)}.env]`);
      for (const [k, v] of Object.entries(config.transport.env).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`${tomlKeySegment(k)} = ${tomlEscapeString(v)}`);
      }
    }
  } else {
    lines.push(`url = ${tomlEscapeString(config.transport.url)}`);
    if (config.transport.headers && Object.keys(config.transport.headers).length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${tomlKeySegment(id)}.http_headers]`);
      for (const [k, v] of Object.entries(config.transport.headers).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`${tomlKeySegment(k)} = ${tomlEscapeString(v)}`);
      }
    }
  }
  return lines.join("\n");
}

const CODEX_EXPORT_START = "# >>> T3 Code Portable Harness MCP (managed export) >>>";
const CODEX_EXPORT_END = "# <<< T3 Code Portable Harness MCP <<<";

/** Non-destructively updates the managed T3 export block inside Codex `config.toml`. */
function mergeCodexConfigToml(
  existingToml: string,
  servers: ReadonlyArray<{ readonly id: string; readonly config: HarnessMcpServerConfig }>,
): string {
  const renderedBlocks = servers.map((s) => renderCodexMcpServerToml(s.id, s.config)).join("\n\n");
  const managedSection = `${CODEX_EXPORT_START}\n${renderedBlocks}\n${CODEX_EXPORT_END}`;
  const startIdx = existingToml.indexOf(CODEX_EXPORT_START);
  const endIdx = existingToml.indexOf(CODEX_EXPORT_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = existingToml.slice(0, startIdx).trimEnd();
    const after = existingToml.slice(endIdx + CODEX_EXPORT_END.length).trimStart();
    const parts = [before, managedSection, after].filter((part) => part.length > 0);
    return `${parts.join("\n\n")}\n`;
  }
  const trimmed = existingToml.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${managedSection}\n` : `${managedSection}\n`;
}

function toJsonMcpEntry(config: HarnessMcpServerConfig): Record<string, unknown> {
  if (config.transport.type === "stdio") {
    return {
      command: config.transport.command,
      ...(config.transport.args && config.transport.args.length > 0
        ? { args: [...config.transport.args] }
        : {}),
      ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
      ...(config.transport.env && Object.keys(config.transport.env).length > 0
        ? { env: { ...config.transport.env } }
        : {}),
      ...(config.enabled ? {} : { disabled: true }),
    };
  }
  return {
    type: config.transport.type,
    url: config.transport.url,
    ...(config.transport.headers && Object.keys(config.transport.headers).length > 0
      ? { headers: { ...config.transport.headers } }
      : {}),
    ...(config.enabled ? {} : { disabled: true }),
  };
}

/** Non-destructively merges `mcpServers` keys into `~/.claude.json` or `~/.cursor/mcp.json`. */
function mergeJsonMcpFile(
  existingRaw: string | null,
  servers: ReadonlyArray<{ readonly id: string; readonly config: HarnessMcpServerConfig }>,
): { readonly content: string; readonly warning?: string } {
  let root: Record<string, unknown> = {};
  if (existingRaw !== null && existingRaw.trim().length > 0) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = { ...(parsed as Record<string, unknown>) };
      } else {
        return {
          content: "",
          warning: "Target JSON file does not contain a top-level object; skipping MCP merge.",
        };
      }
    } catch {
      return {
        content: "",
        warning: "Target JSON file contains invalid JSON; skipping MCP merge to prevent data loss.",
      };
    }
  }
  const existingMap =
    root.mcpServers !== null &&
    typeof root.mcpServers === "object" &&
    !Array.isArray(root.mcpServers)
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {};
  for (const server of servers) {
    existingMap[server.id] = toJsonMcpEntry(server.config);
  }
  root.mcpServers = existingMap;
  return { content: `${JSON.stringify(root, null, 2)}\n` };
}

function computeExportPlanDigest(
  hmacKey: Buffer,
  target: HarnessExportTarget,
  files: ReadonlyArray<PlannedExportFile>,
): string {
  return NodeCrypto.createHmac("sha256", hmacKey)
    .update(
      JSON.stringify({
        target,
        files: files.map((f) => [f.targetPath, f.action, sha256Hex(f.content)]),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

export class HarnessExporter extends Context.Service<
  HarnessExporter,
  {
    readonly preview: (
      input: HarnessExportPreviewInput,
    ) => Effect.Effect<HarnessExportPreviewResult, HarnessError>;
    readonly apply: (
      input: HarnessExportApplyInput,
    ) => Effect.Effect<HarnessExportApplyResult, HarnessError>;
  }
>()("t3/harness/HarnessExporter") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = yield* HostProcess.HomeDirectory;
  const store = yield* HarnessStore.HarnessStore;
  const library = yield* HarnessLibraryStore.HarnessLibraryStore;
  const writeLock = yield* Semaphore.make(1);
  const hmacKey = NodeCrypto.randomBytes(32);

  const readFileOpt = Effect.fn("HarnessExporter.readFileOpt")(function* (filePath: string) {
    return yield* Effect.tryPromise({
      try: () =>
        safeReadFileUtf8(homeDir, filePath)
          .then(Option.some)
          .catch((error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return Option.none<string>();
            }
            throw error;
          }),
      catch: () =>
        new HarnessError({
          code: "io_error",
          detail: `Could not safely read ${filePath}. Symlinked dotfile directories and files are blocked by export protection.`,
        }),
    });
  });

  const writeFileAtomic = Effect.fn("HarnessExporter.writeFileAtomic")(function* (
    targetPath: string,
    contents: string,
  ) {
    yield* Effect.tryPromise({
      try: () => safeWriteFileAtomic(homeDir, targetPath, contents),
      catch: (error) =>
        new HarnessError({
          code: "io_error",
          detail: `Failed to write exported file ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  });

  const buildExportPlan = Effect.fn("HarnessExporter.buildExportPlan")(function* (input: {
    readonly target: HarnessExportTarget;
    readonly sections?: ReadonlyArray<HarnessExportSection> | undefined;
    readonly workspaceRoot?: string | undefined;
  }) {
    const [workspace, lib] = yield* Effect.all([
      store.resolveWorkspace(input.workspaceRoot),
      library.getSnapshot(input.workspaceRoot),
    ]);
    if (!workspace.managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: `${workspace.managedPolicyOrganization ?? "Organization"}'s policy does not allow portable harness extensions.`,
      });
    }

    const sections = new Set<HarnessExportSection>(
      input.sections && input.sections.length > 0 ? input.sections : ALL_SECTIONS,
    );
    if (input.target !== "claude" || [...sections].some((section) => section !== "mcp")) {
      const dotDir = path.join(homeDir, `.${input.target}`);
      const symlink = yield* fs.readLink(dotDir).pipe(Effect.option);
      if (Option.isSome(symlink)) {
        return yield* new HarnessError({
          code: "invalid_config",
          detail: `Cannot export to ${dotDir} because it is a symlinked dotfile directory. Export protection requires a real directory.`,
        });
      }
    }
    const files: Array<PlannedExportFile> = [];
    const warnings: Array<string> = [];

    const addPlannedFile = (
      targetPath: string,
      existingContent: string | null,
      section: HarnessExportSection,
      itemId: string,
      content: string,
      redactedPreviewContent: string,
      hasSecretPlaceholders: boolean,
    ) => {
      const action: HarnessExportFileAction =
        existingContent === null ? "create" : existingContent === content ? "unchanged" : "update";
      files.push({
        targetPath,
        action,
        section,
        itemId,
        content,
        redactedPreviewContent,
        hasSecretPlaceholders,
      });
    };

    // 1. MCP Servers
    if (sections.has("mcp")) {
      const exportableServers = workspace.servers
        .filter((s) => s.scope === "user" && s.effectiveEnabled)
        .map((s) => ({ id: s.id, config: s.config }));
      const redactedServers = exportableServers.map((s) => ({
        id: s.id,
        config: redactHarnessServerConfig(s.config),
      }));
      const hasSecrets = exportableServers.some((s) => configContainsSecretPlaceholder(s.config));

      if (exportableServers.length > 0) {
        if (input.target === "codex") {
          const targetPath = path.join(homeDir, ".codex", "config.toml");
          const existing = Option.getOrNull(yield* readFileOpt(targetPath));
          const merged = mergeCodexConfigToml(existing ?? "", exportableServers);
          // Preview only the redacted T3-managed export block so existing host config credentials can never leak.
          const redactedDeltaPreview = mergeCodexConfigToml("", redactedServers);
          addPlannedFile(
            targetPath,
            existing,
            "mcp",
            "mcpServers",
            merged,
            redactedDeltaPreview,
            hasSecrets,
          );
        } else {
          const targetPath =
            input.target === "claude"
              ? path.join(homeDir, ".claude.json")
              : path.join(homeDir, ".cursor", "mcp.json");
          const existing = Option.getOrNull(yield* readFileOpt(targetPath));
          const merged = mergeJsonMcpFile(existing, exportableServers);
          // Preview only the redacted T3-exported mcpServers entries, never existing host entries/secrets.
          const redactedDeltaPreview = mergeJsonMcpFile(null, redactedServers);
          if (merged.warning) {
            warnings.push(`${targetPath}: ${merged.warning}`);
          } else {
            addPlannedFile(
              targetPath,
              existing,
              "mcp",
              "mcpServers",
              merged.content,
              redactedDeltaPreview.content,
              hasSecrets,
            );
          }
        }
      }
    }

    // 2. Portable Skills (user scope)
    if (sections.has("skills")) {
      const targetSkillsRoot =
        input.target === "codex"
          ? path.join(homeDir, ".codex", "skills")
          : input.target === "claude"
            ? path.join(homeDir, ".claude", "skills")
            : path.join(homeDir, ".cursor", "skills");
      for (const skill of lib.skills) {
        if (skill.scope !== "user" || !skill.effectiveEnabled) continue;
        const targetPath = path.join(targetSkillsRoot, skill.id, "SKILL.md");
        const existing = Option.getOrNull(yield* readFileOpt(targetPath));
        const content = formatSkillMarkdown({
          name: skill.name,
          description: skill.description,
          shortDescription: skill.shortDescription,
          userInvocable: skill.userInvocable,
          userInvocationOnly: skill.userInvocationOnly,
          body: skill.body,
        });
        addPlannedFile(targetPath, existing, "skills", skill.id, content, content, false);
      }
    }

    // 3. Rules (user AGENTS.md + rules/*.md)
    if (sections.has("rules")) {
      if (input.target === "cursor") {
        // Export AGENTS.md and rules/*.md as Cursor `.mdc` files under `~/.cursor/rules/`.
        const cursorRulesRoot = path.join(homeDir, ".cursor", "rules");
        if (lib.userAgentsMd.exists && lib.userAgentsMd.body.trim().length > 0) {
          const targetPath = path.join(cursorRulesRoot, "t3-personal-agents.mdc");
          const existing = Option.getOrNull(yield* readFileOpt(targetPath));
          const content = formatMarkdownWithFrontmatter(
            { description: "Exported from T3 Code portable AGENTS.md", alwaysApply: true },
            lib.userAgentsMd.body,
          );
          addPlannedFile(targetPath, existing, "rules", "AGENTS.md", content, content, false);
        }
        for (const rule of lib.rules) {
          if (!rule.effectiveEnabled || rule.lockedByPolicy) continue;
          const targetPath = path.join(cursorRulesRoot, `${rule.id}.mdc`);
          const existing = Option.getOrNull(yield* readFileOpt(targetPath));
          const fm: Record<string, unknown> = {
            ...(rule.description ? { description: rule.description } : {}),
            alwaysApply: rule.apply === "always",
            ...(rule.apply === "glob" && rule.globs.length > 0
              ? { globs: rule.globs.join(", ") }
              : {}),
          };
          const content = formatMarkdownWithFrontmatter(fm, rule.body);
          addPlannedFile(targetPath, existing, "rules", rule.id, content, content, false);
        }
      } else {
        // Codex (`~/.codex/AGENTS.md`) or Claude (`~/.claude/CLAUDE.md`): assemble user AGENTS.md + always rules.
        const ruleBlocks: Array<string> = [];
        if (lib.userAgentsMd.exists && lib.userAgentsMd.body.trim().length > 0) {
          ruleBlocks.push(lib.userAgentsMd.body.trim());
        }
        for (const rule of lib.rules) {
          if (!rule.effectiveEnabled || rule.lockedByPolicy) continue;
          if (rule.apply === "always") {
            ruleBlocks.push(`## Rule: ${rule.id}\n\n${rule.body.trim()}`);
          } else {
            warnings.push(
              `Skipped ${rule.apply} rule "${rule.id}" for ${input.target} (conditional rules require Cursor .mdc or T3 Harness).`,
            );
          }
        }
        const targetPath =
          input.target === "codex"
            ? path.join(homeDir, ".codex", "AGENTS.md")
            : path.join(homeDir, ".claude", "CLAUDE.md");
        const existing = Option.getOrNull(yield* readFileOpt(targetPath));
        const managed = existing?.match(MANAGED_RULES_BLOCK) ?? undefined;
        if (ruleBlocks.length > 0 || managed !== undefined) {
          const eol = managed?.[0].includes("\r\n") ? "\r\n" : "\n";
          const rules = ruleBlocks.join("\n\n");
          if (/^<!-- T3-HARNESS-(?:BEGIN|END) -->\r?$/mu.test(rules)) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail: "Portable rules contain a reserved T3 Harness export marker.",
            });
          }
          const block = [
            MANAGED_RULES_BEGIN,
            ...(rules ? [rules.replace(/\r?\n/gu, eol)] : []),
            MANAGED_RULES_END,
          ].join(eol);
          let content: string;
          if (existing !== null && managed?.index !== undefined) {
            content =
              existing.slice(0, managed.index) +
              block +
              existing.slice(managed.index + managed[0].length);
          } else {
            const separator = existing ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
            content = `${existing ?? ""}${separator}${block}\n`;
            if (existing)
              warnings.push(
                `${targetPath}: Appended T3 Harness rules and preserved existing unmanaged content.`,
              );
          }
          addPlannedFile(targetPath, existing, "rules", "AGENTS.md", content, block, false);
        }
      }
    }

    // 4. Custom `/` Commands
    if (sections.has("commands")) {
      const enabledCommands = lib.commands.filter((c) => c.effectiveEnabled);
      if (enabledCommands.length > 0) {
        if (input.target === "claude") {
          const commandsRoot = path.join(homeDir, ".claude", "commands");
          for (const cmd of enabledCommands) {
            const targetPath = path.join(commandsRoot, `${cmd.id}.md`);
            const existing = Option.getOrNull(yield* readFileOpt(targetPath));
            const content = formatCommandMarkdown({
              description: cmd.description,
              argumentHint: cmd.argumentHint,
              body: cmd.body,
            });
            addPlannedFile(targetPath, existing, "commands", cmd.id, content, content, false);
          }
        } else {
          warnings.push(
            `${input.target} does not use ~/.claude/commands/*.md; ${enabledCommands.length} custom command(s) were not exported to ${input.target}.`,
          );
        }
      }
    }

    const planDigest = computeExportPlanDigest(hmacKey, input.target, files);

    return { files, warnings, planDigest };
  });

  const preview: HarnessExporter["Service"]["preview"] = Effect.fn("HarnessExporter.preview")(
    function* (input) {
      const plan = yield* buildExportPlan(input);
      const previewFiles: Array<HarnessExportPreviewFile> = plan.files.map((file) => ({
        targetPath: file.targetPath,
        action: file.action,
        section: file.section,
        itemId: file.itemId,
        bytes: NonNegativeInt.make(Buffer.byteLength(file.content, "utf8")),
        previewSnippet: truncateSnippet(file.redactedPreviewContent),
        hasSecretPlaceholders: file.hasSecretPlaceholders,
      }));
      return {
        target: input.target,
        planDigest: plan.planDigest,
        files: previewFiles,
        warnings: plan.warnings,
      };
    },
  );

  const apply: HarnessExporter["Service"]["apply"] = Effect.fn("HarnessExporter.apply")(
    function* (input) {
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* buildExportPlan(input);
          if (plan.planDigest !== input.planDigest) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail:
                "Export plan changed since preview. Refresh the export preview and confirm again.",
            });
          }
          const writtenPaths: Array<string> = [];
          const skippedPaths: Array<string> = [];
          for (const file of plan.files) {
            if (file.action === "unchanged") {
              skippedPaths.push(file.targetPath);
              continue;
            }
            yield* writeFileAtomic(file.targetPath, file.content);
            writtenPaths.push(file.targetPath);
          }
          return {
            target: input.target,
            writtenPaths,
            skippedPaths,
            warnings: plan.warnings,
          };
        }),
      );
    },
  );

  return HarnessExporter.of({ preview, apply });
});

export const layer = Layer.effect(HarnessExporter, make);
