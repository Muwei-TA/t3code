// @effect-diagnostics nodeBuiltinImport:off -- Server-local CSPRNG HMAC binds library import preview tokens without exposing unkeyed content hashes.
import * as NodeCrypto from "node:crypto";
import {
  HarnessCommandId,
  HarnessError,
  type HarnessLibraryApplyImportsInput,
  type HarnessLibraryImportCandidate,
  type HarnessLibraryImportKind,
  type HarnessLibraryImportSourcePreview,
  type HarnessMcpImportConflict,
  type HarnessMcpImportSource,
  HarnessRuleId,
  HarnessSkillId,
  isReservedHarnessCommandId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HarnessLibraryStore from "./HarnessLibraryStore.ts";
import {
  formatCommandMarkdown,
  formatRuleMarkdown,
  formatSkillMarkdown,
  parseMarkdownFrontmatter,
  sha256Hex,
} from "./HarnessLibraryStore.ts";
import * as HarnessStore from "./HarnessStore.ts";

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);

function sanitizeId(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^[^a-zA-Z0-9]+/u, "")
    .slice(0, 64);
}

interface RawLibraryImportItem {
  readonly source: HarnessMcpImportSource;
  readonly kind: HarnessLibraryImportKind;
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly sourcePath: string;
  readonly normalizedContent: string;
  readonly summary: string;
  readonly applyPayload:
    | { readonly kind: "agents_md"; readonly body: string }
    | {
        readonly kind: "skill";
        readonly id: HarnessSkillId;
        readonly name: string;
        readonly description?: string | undefined;
        readonly body: string;
      }
    | {
        readonly kind: "rule";
        readonly id: HarnessRuleId;
        readonly description?: string | undefined;
        readonly apply: "always" | "glob" | "manual";
        readonly globs: ReadonlyArray<string>;
        readonly body: string;
      }
    | {
        readonly kind: "command";
        readonly id: HarnessCommandId;
        readonly description?: string | undefined;
        readonly argumentHint?: string | undefined;
        readonly body: string;
      };
}

interface ScannedLibrarySource {
  readonly source: HarnessMcpImportSource;
  readonly found: boolean;
  readonly items: ReadonlyArray<RawLibraryImportItem>;
  readonly warnings: ReadonlyArray<string>;
}

/** Converts Cursor `.cursor/rules/*.mdc` / `*.md` frontmatter into portable T3 `rules/*.md` fields. */
export function convertCursorRuleToPortable(input: {
  readonly rawText: string;
  readonly rawId: string;
}): {
  readonly apply: "always" | "glob" | "manual";
  readonly globs: ReadonlyArray<string>;
  readonly description?: string | undefined;
  readonly body: string;
} {
  const parsed = parseMarkdownFrontmatter(input.rawText);
  const fm = parsed.frontmatter ?? {};
  const description =
    typeof fm.description === "string" && fm.description.trim().length > 0
      ? fm.description.trim()
      : undefined;
  const rawGlobs = fm.globs;
  const globs = Array.isArray(rawGlobs)
    ? rawGlobs
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    : typeof rawGlobs === "string"
      ? rawGlobs
          .split(/[,\n]+/u)
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
  const alwaysApply = fm.alwaysApply === true || fm.alwaysApply === "true";
  const apply: "always" | "glob" | "manual" = alwaysApply
    ? "always"
    : globs.length > 0
      ? "glob"
      : "manual";
  return {
    apply,
    globs,
    ...(description !== undefined ? { description } : {}),
    body: parsed.body.trim(),
  };
}

export class HarnessLibraryImporter extends Context.Service<
  HarnessLibraryImporter,
  {
    readonly scan: (
      workspaceRoot?: string | undefined,
    ) => Effect.Effect<ReadonlyArray<HarnessLibraryImportSourcePreview>>;
    readonly apply: (input: HarnessLibraryApplyImportsInput) => Effect.Effect<
      {
        readonly importedKeys: ReadonlyArray<string>;
        readonly skippedKeys: ReadonlyArray<string>;
        readonly snapshot: import("@t3tools/contracts").HarnessLibrarySnapshot;
      },
      HarnessError
    >;
  }
>()("t3/harness/HarnessLibraryImporter") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = yield* HostProcess.HomeDirectory;
  const store = yield* HarnessStore.HarnessStore;
  const library = yield* HarnessLibraryStore.HarnessLibraryStore;
  const hmacKey = NodeCrypto.randomBytes(32);

  const previewDigestFor = (
    item: Pick<RawLibraryImportItem, "kind" | "id" | "normalizedContent">,
  ) =>
    NodeCrypto.createHmac("sha256", hmacKey)
      .update(`${item.kind}\u0000${item.id}\u0000${sha256Hex(item.normalizedContent)}`)
      .digest("hex")
      .slice(0, 24);

  const existingDigestFor = (kind: HarnessLibraryImportKind, id: string, rawContent: string) =>
    NodeCrypto.createHmac("sha256", hmacKey)
      .update(`existing\u0000${kind}\u0000${id}\u0000${sha256Hex(rawContent)}`)
      .digest("hex")
      .slice(0, 24);

  const readFileOpt = (filePath: string) =>
    fs.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const scanSkillsDir = Effect.fn("HarnessLibraryImporter.scanSkillsDir")(function* (
    source: HarnessMcpImportSource,
    skillsDir: string,
    warnings: Array<string>,
  ) {
    const entries = yield* fs.readDirectory(skillsDir).pipe(Effect.orElseSucceed(() => []));
    const items: Array<RawLibraryImportItem> = [];
    for (const dirName of entries) {
      const skillFile = path.join(skillsDir, dirName, "SKILL.md");
      const raw = yield* readFileOpt(skillFile);
      if (Option.isNone(raw)) continue;
      const sanitized = sanitizeId(dirName);
      const idOpt = decodeSkillId(sanitized);
      if (Option.isNone(idOpt)) {
        warnings.push(`Skipped skill "${dirName}": invalid identifier.`);
        continue;
      }
      const parsed = parseMarkdownFrontmatter(raw.value);
      const fm = parsed.frontmatter ?? {};
      const name =
        typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : idOpt.value;
      const description =
        typeof fm.description === "string" && fm.description.trim().length > 0
          ? fm.description.trim()
          : undefined;
      const normalizedContent = formatSkillMarkdown({
        name,
        description,
        body: parsed.body,
      });
      items.push({
        source,
        kind: "skill",
        id: idOpt.value,
        name,
        ...(description !== undefined ? { description } : {}),
        sourcePath: skillFile,
        normalizedContent,
        summary: description ?? `Skill ${name}`,
        applyPayload: {
          kind: "skill",
          id: idOpt.value,
          name,
          ...(description !== undefined ? { description } : {}),
          body: parsed.body,
        },
      });
    }
    return items;
  });

  const scanClaudeCommandsDir = Effect.fn("HarnessLibraryImporter.scanClaudeCommandsDir")(
    function* (commandsDir: string, warnings: Array<string>) {
      const entries = yield* fs.readDirectory(commandsDir).pipe(Effect.orElseSucceed(() => []));
      const items: Array<RawLibraryImportItem> = [];
      for (const fileName of entries) {
        if (!fileName.endsWith(".md")) continue;
        const filePath = path.join(commandsDir, fileName);
        const raw = yield* readFileOpt(filePath);
        if (Option.isNone(raw)) continue;
        const rawId = sanitizeId(fileName.slice(0, -3));
        if (isReservedHarnessCommandId(rawId)) {
          warnings.push(`Skipped command "/${rawId}": reserved by T3 Code.`);
          continue;
        }
        const idOpt = decodeCommandId(rawId);
        if (Option.isNone(idOpt)) {
          warnings.push(`Skipped command "${fileName}": invalid identifier.`);
          continue;
        }
        const parsed = parseMarkdownFrontmatter(raw.value);
        const fm = parsed.frontmatter ?? {};
        const description =
          typeof fm.description === "string" && fm.description.trim().length > 0
            ? fm.description.trim()
            : undefined;
        const argumentHint =
          typeof fm["argument-hint"] === "string" && fm["argument-hint"].trim().length > 0
            ? fm["argument-hint"].trim()
            : undefined;
        const normalizedContent = formatCommandMarkdown({
          description,
          argumentHint,
          body: parsed.body,
        });
        items.push({
          source: "claude",
          kind: "command",
          id: idOpt.value,
          name: `/${idOpt.value}`,
          ...(description !== undefined ? { description } : {}),
          sourcePath: filePath,
          normalizedContent,
          summary: description ?? `Slash command /${idOpt.value}`,
          applyPayload: {
            kind: "command",
            id: idOpt.value,
            ...(description !== undefined ? { description } : {}),
            ...(argumentHint !== undefined ? { argumentHint } : {}),
            body: parsed.body,
          },
        });
      }
      return items;
    },
  );

  const scanCursorRulesDir = Effect.fn("HarnessLibraryImporter.scanCursorRulesDir")(function* (
    rulesDir: string,
    warnings: Array<string>,
  ) {
    const entries = yield* fs.readDirectory(rulesDir).pipe(Effect.orElseSucceed(() => []));
    const items: Array<RawLibraryImportItem> = [];
    for (const fileName of entries) {
      if (!fileName.endsWith(".mdc") && !fileName.endsWith(".md")) continue;
      const filePath = path.join(rulesDir, fileName);
      const raw = yield* readFileOpt(filePath);
      if (Option.isNone(raw)) continue;
      const base = fileName.replace(/\.(?:mdc|md)$/u, "");
      const rawId = sanitizeId(base);
      const idOpt = decodeRuleId(rawId);
      if (Option.isNone(idOpt)) {
        warnings.push(`Skipped Cursor rule "${fileName}": invalid identifier.`);
        continue;
      }
      const converted = convertCursorRuleToPortable({ rawText: raw.value, rawId: idOpt.value });
      const normalizedContent = formatRuleMarkdown({
        description: converted.description,
        apply: converted.apply,
        globs: converted.globs,
        body: converted.body,
      });
      items.push({
        source: "cursor",
        kind: "rule",
        id: idOpt.value,
        name: idOpt.value,
        ...(converted.description !== undefined ? { description: converted.description } : {}),
        sourcePath: filePath,
        normalizedContent,
        summary:
          converted.description ??
          `${converted.apply} rule${converted.globs.length > 0 ? ` (${converted.globs.join(", ")})` : ""}`,
        applyPayload: {
          kind: "rule",
          id: idOpt.value,
          ...(converted.description !== undefined ? { description: converted.description } : {}),
          apply: converted.apply,
          globs: converted.globs,
          body: converted.body,
        },
      });
    }
    return items;
  });

  const scanRawSources = Effect.fn("HarnessLibraryImporter.scanRawSources")(function* (
    workspaceRoot?: string | undefined,
  ): Effect.fn.Return<ReadonlyArray<ScannedLibrarySource>> {
    const out: Array<ScannedLibrarySource> = [];

    // 1. Codex (`~/.codex/skills`, `~/.codex/AGENTS.md`)
    {
      const warnings: Array<string> = [];
      const items: Array<RawLibraryImportItem> = [];
      const codexSkills = yield* scanSkillsDir(
        "codex",
        path.join(homeDir, ".codex", "skills"),
        warnings,
      );
      items.push(...codexSkills);
      const codexAgentsPath = path.join(homeDir, ".codex", "AGENTS.md");
      const codexAgents = yield* readFileOpt(codexAgentsPath);
      if (Option.isSome(codexAgents) && codexAgents.value.trim().length > 0) {
        items.push({
          source: "codex",
          kind: "agents_md",
          id: "AGENTS.md",
          name: "AGENTS.md",
          description: "Personal rules from ~/.codex/AGENTS.md",
          sourcePath: codexAgentsPath,
          normalizedContent: codexAgents.value,
          summary: "Personal AGENTS.md rules",
          applyPayload: { kind: "agents_md", body: codexAgents.value },
        });
      }
      out.push({ source: "codex", found: items.length > 0, items, warnings });
    }

    // 2. Claude (`~/.claude/skills`, `~/.claude/commands`, `~/.claude/CLAUDE.md`)
    {
      const warnings: Array<string> = [];
      const items: Array<RawLibraryImportItem> = [];
      const claudeSkills = yield* scanSkillsDir(
        "claude",
        path.join(homeDir, ".claude", "skills"),
        warnings,
      );
      const claudeCommands = yield* scanClaudeCommandsDir(
        path.join(homeDir, ".claude", "commands"),
        warnings,
      );
      items.push(...claudeSkills, ...claudeCommands);
      const claudeMdPath = path.join(homeDir, ".claude", "CLAUDE.md");
      const claudeMd = yield* readFileOpt(claudeMdPath);
      if (Option.isSome(claudeMd) && claudeMd.value.trim().length > 0) {
        items.push({
          source: "claude",
          kind: "agents_md",
          id: "AGENTS.md",
          name: "CLAUDE.md → AGENTS.md",
          description: "Personal rules from ~/.claude/CLAUDE.md",
          sourcePath: claudeMdPath,
          normalizedContent: claudeMd.value,
          summary: "Personal CLAUDE.md rules",
          applyPayload: { kind: "agents_md", body: claudeMd.value },
        });
      }
      out.push({ source: "claude", found: items.length > 0, items, warnings });
    }

    // 3. Cursor (`~/.cursor/skills`, `~/.cursor/rules`, `<workspace>/.cursor/rules`)
    {
      const warnings: Array<string> = [];
      const items: Array<RawLibraryImportItem> = [];
      const seenRuleIds = new Set<string>();
      const cursorSkills = yield* scanSkillsDir(
        "cursor",
        path.join(homeDir, ".cursor", "skills"),
        warnings,
      );
      items.push(...cursorSkills);
      if (workspaceRoot && workspaceRoot.trim().length > 0) {
        const wsRules = yield* scanCursorRulesDir(
          path.join(workspaceRoot.trim(), ".cursor", "rules"),
          warnings,
        );
        for (const item of wsRules) {
          seenRuleIds.add(item.id);
          items.push(item);
        }
      }
      const userCursorRules = yield* scanCursorRulesDir(
        path.join(homeDir, ".cursor", "rules"),
        warnings,
      );
      for (const item of userCursorRules) {
        if (!seenRuleIds.has(item.id)) items.push(item);
      }
      out.push({ source: "cursor", found: items.length > 0, items, warnings });
    }

    // 4. Antigravity (`~/.gemini/antigravity/skills`)
    {
      const warnings: Array<string> = [];
      const items = yield* scanSkillsDir(
        "antigravity",
        path.join(homeDir, ".gemini", "antigravity", "skills"),
        warnings,
      );
      out.push({ source: "antigravity", found: items.length > 0, items, warnings });
    }

    return out;
  });

  const existingContentFor = (
    snapshot: import("@t3tools/contracts").HarnessLibrarySnapshot,
    kind: HarnessLibraryImportKind,
    id: string,
  ): string | null => {
    if (kind === "agents_md") {
      return snapshot.userAgentsMd.exists ? snapshot.userAgentsMd.body : null;
    }
    if (kind === "skill") {
      const found = snapshot.skills.find((s) => s.scope === "user" && s.id === id);
      return found
        ? formatSkillMarkdown({
            name: found.name,
            description: found.description,
            shortDescription: found.shortDescription,
            userInvocable: found.userInvocable,
            userInvocationOnly: found.userInvocationOnly,
            enabled: found.enabled,
            body: found.body,
          })
        : null;
    }
    if (kind === "rule") {
      const found = snapshot.rules.find((r) => r.scope === "user" && r.id === id);
      return found
        ? formatRuleMarkdown({
            description: found.description,
            apply: found.apply,
            globs: found.globs,
            enabled: found.enabled,
            body: found.body,
          })
        : null;
    }
    const found = snapshot.commands.find((c) => c.scope === "user" && c.id === id);
    return found
      ? formatCommandMarkdown({
          description: found.description,
          argumentHint: found.argumentHint,
          enabled: found.enabled,
          body: found.body,
        })
      : null;
  };

  const scan: HarnessLibraryImporter["Service"]["scan"] = Effect.fn("HarnessLibraryImporter.scan")(
    function* (workspaceRoot) {
      const [rawSources, snapshot] = yield* Effect.all([
        scanRawSources(workspaceRoot),
        library.getSnapshot(workspaceRoot),
      ]);
      return rawSources.map((src): HarnessLibraryImportSourcePreview => {
        const candidates: Array<HarnessLibraryImportCandidate> = src.items.map((item) => {
          const existing = existingContentFor(snapshot, item.kind, item.id);
          let conflict: HarnessMcpImportConflict = "none";
          if (existing !== null) {
            conflict =
              existing.trim() === item.normalizedContent.trim()
                ? "exists_identical"
                : "exists_different";
          }
          return {
            kind: item.kind,
            id: TrimmedNonEmptyString.make(item.id),
            name: TrimmedNonEmptyString.make(item.name),
            ...(item.description !== undefined ? { description: item.description } : {}),
            sourcePath: item.sourcePath,
            previewDigest: previewDigestFor(item),
            existingDigest:
              existing !== null ? existingDigestFor(item.kind, item.id, existing) : null,
            conflict,
            bytes: NonNegativeInt.make(Buffer.byteLength(item.normalizedContent, "utf8")),
            summary: item.summary,
          };
        });
        return {
          source: src.source,
          found: src.found,
          candidates,
          warnings: src.warnings,
        };
      });
    },
  );

  const apply: HarnessLibraryImporter["Service"]["apply"] = Effect.fn(
    "HarnessLibraryImporter.apply",
  )(function* (input) {
    const overrides = yield* store.readProjectLibraryOverrides(input.workspaceRoot);
    if (!overrides.managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: `${overrides.managedPolicyOrganization ?? "Organization"}'s policy does not allow portable harness extensions.`,
      });
    }
    const [rawSources, currentSnapshot] = yield* Effect.all([
      scanRawSources(input.workspaceRoot),
      library.getSnapshot(input.workspaceRoot),
    ]);
    const lookup = new Map<string, RawLibraryImportItem>();
    for (const src of rawSources) {
      for (const item of src.items) {
        lookup.set(`${src.source}\u0000${item.kind}\u0000${item.id}`, item);
      }
    }

    const importedKeys: Array<string> = [];
    const skippedKeys: Array<string> = [];

    for (const req of input.items) {
      const lookupKey = `${req.source}\u0000${req.kind}\u0000${req.id}`;
      const displayKey = `${req.source}:${req.kind}:${req.id}`;
      const candidate = lookup.get(lookupKey);
      if (!candidate) {
        skippedKeys.push(displayKey);
        continue;
      }
      if (req.expectedDigest !== undefined && previewDigestFor(candidate) !== req.expectedDigest) {
        return yield* new HarnessError({
          code: "invalid_config",
          detail: `Import item "${displayKey}" changed since preview. Rescan and review before importing.`,
        });
      }
      const existing = existingContentFor(currentSnapshot, candidate.kind, candidate.id);
      if (existing !== null && input.overwriteExisting !== true) {
        skippedKeys.push(displayKey);
        continue;
      }
      if (req.expectedExistingDigest !== undefined) {
        const actualExisting =
          existing !== null ? existingDigestFor(candidate.kind, candidate.id, existing) : null;
        if (actualExisting !== req.expectedExistingDigest) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: `Existing target for "${displayKey}" changed since preview. Rescan and review before importing.`,
          });
        }
      }
      const payload = candidate.applyPayload;
      const wsOpt = input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {};
      if (payload.kind === "agents_md") {
        yield* library.saveUserAgentsMd({ body: payload.body, ...wsOpt });
      } else if (payload.kind === "skill") {
        yield* library.upsertUserSkill({
          id: payload.id,
          name: TrimmedNonEmptyString.make(payload.name),
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          body: payload.body,
          ...wsOpt,
        });
      } else if (payload.kind === "rule") {
        yield* library.upsertUserRule({
          id: payload.id,
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          apply: payload.apply,
          globs: [...payload.globs],
          body: payload.body,
          ...wsOpt,
        });
      } else {
        yield* library.upsertUserCommand({
          id: payload.id,
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.argumentHint !== undefined ? { argumentHint: payload.argumentHint } : {}),
          body: payload.body,
          ...wsOpt,
        });
      }
      importedKeys.push(displayKey);
    }

    const snapshot = yield* library.getSnapshot(input.workspaceRoot);
    return { importedKeys, skippedKeys, snapshot };
  });

  return HarnessLibraryImporter.of({ scan, apply });
});

export const layer = Layer.effect(HarnessLibraryImporter, make);
