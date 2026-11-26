// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 digests, metadata fingerprints, and symlink-safe skill removal for portable library files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import {
  type HarnessAgentsMdView,
  type HarnessCommandEntry,
  HarnessCommandId,
  type HarnessCommandUpsertInput,
  HarnessError,
  type HarnessInvalidEntry,
  type HarnessLibrarySnapshot,
  HarnessMcpServerId,
  type HarnessModeEntry,
  HarnessModeId,
  type HarnessModeUpsertInput,
  HarnessRuleApplyMode,
  type HarnessRuleEntry,
  HarnessRuleId,
  type HarnessRuleUpsertInput,
  type HarnessSkillEntry,
  HarnessSkillId,
  type HarnessSkillUpsertInput,
  isReservedHarnessCommandId,
  NonNegativeInt,
  type PositiveInt,
  type ProviderInteractionMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import * as ServerConfig from "../config.ts";
import * as HarnessStore from "./HarnessStore.ts";
import { assertContainedNoSymlinks, safeWriteFileAtomic } from "./safeFileOps.ts";
import * as PluginHost from "./PluginHost.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_READ_BYTES = 262_144;
const MAX_COMPANION_FILES = 32;

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);
const encodeSnapshotFingerprint = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);
const decodeMcpServerId = Schema.decodeUnknownOption(HarnessMcpServerId);
const decodeRuleApplyMode = Schema.decodeUnknownOption(HarnessRuleApplyMode);

interface BuiltinModeSpec {
  readonly id: HarnessModeId;
  readonly name: typeof TrimmedNonEmptyString.Type;
  readonly description: string;
  readonly baseInteractionMode: ProviderInteractionMode;
  readonly readonly: boolean;
  readonly proposePlan: boolean;
  readonly body: string;
}

const BUILTIN_MODES: ReadonlyArray<BuiltinModeSpec> = [
  {
    id: HarnessModeId.make("build"),
    name: TrimmedNonEmptyString.make("Build"),
    description:
      "Default implementation mode with full tool access for writing and verifying code.",
    baseInteractionMode: "default",
    readonly: false,
    proposePlan: false,
    body: "",
  },
  {
    id: HarnessModeId.make("plan"),
    name: TrimmedNonEmptyString.make("Plan"),
    description:
      "Read-only exploration and structured architectural planning before making file edits.",
    baseInteractionMode: "plan",
    readonly: true,
    proposePlan: true,
    body: "",
  },
  {
    id: HarnessModeId.make("review"),
    name: TrimmedNonEmptyString.make("Review"),
    description:
      "Read-only code review mode focused on correctness, security, edge cases, and test gaps without modifying files.",
    baseInteractionMode: "plan",
    readonly: true,
    proposePlan: false,
    body: "You are in Review mode (read-only). Do not modify files or run mutating commands. Inspect diffs, architecture, error handling, security boundaries, and test coverage. Present findings grouped by severity (P0/P1/P2) with exact file paths, line numbers, concrete reproduction scenarios, and minimal recommended fixes.",
  },
  {
    id: HarnessModeId.make("creator"),
    name: TrimmedNonEmptyString.make("Creator"),
    description:
      "Authoring mode for creating and refining portable Skills, Rules, Commands, Modes, and Workflows.",
    baseInteractionMode: "default",
    readonly: false,
    proposePlan: false,
    body: "You are in Creator mode. Help the user author concise, portable T3 Harness extensions under ~/.t3/harness/ (SKILL.md skills, always/glob/manual rules, slash commands, declarative modes, and workflows). Prefer minimal, deterministic instructions, validate identifiers and YAML frontmatter, and avoid leaking secrets.",
  },
];

const RESERVED_MODE_IDS = new Set<string>(["default", ...BUILTIN_MODES.map((mode) => mode.id)]);

function formatModeMarkdown(input: {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly baseInteractionMode: ProviderInteractionMode;
  readonly readonly?: boolean | undefined;
  readonly proposePlan?: boolean | undefined;
  readonly defaultModel?: string | undefined;
  readonly allowedMcpServers?: ReadonlyArray<string> | undefined;
  readonly disabledMcpServers?: ReadonlyArray<string> | undefined;
  readonly includedRules?: ReadonlyArray<string> | undefined;
  readonly includedSkills?: ReadonlyArray<string> | undefined;
  readonly enabled?: boolean | undefined;
  readonly body: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    ...(input.name !== undefined && input.name.trim().length > 0
      ? { name: input.name.trim() }
      : {}),
    ...(input.description !== undefined && input.description.trim().length > 0
      ? { description: input.description.trim() }
      : {}),
    baseInteractionMode: input.baseInteractionMode,
    ...(input.readonly !== undefined ? { readonly: input.readonly } : {}),
    ...(input.proposePlan !== undefined ? { proposePlan: input.proposePlan } : {}),
    ...(input.defaultModel !== undefined && input.defaultModel.trim().length > 0
      ? { defaultModel: input.defaultModel.trim() }
      : {}),
    ...(input.allowedMcpServers && input.allowedMcpServers.length > 0
      ? { allowedMcpServers: [...input.allowedMcpServers] }
      : {}),
    ...(input.disabledMcpServers && input.disabledMcpServers.length > 0
      ? { disabledMcpServers: [...input.disabledMcpServers] }
      : {}),
    ...(input.includedRules && input.includedRules.length > 0
      ? { includedRules: [...input.includedRules] }
      : {}),
    ...(input.includedSkills && input.includedSkills.length > 0
      ? { includedSkills: [...input.includedSkills] }
      : {}),
    ...(input.enabled === false ? { enabled: false } : {}),
  };
  return formatMarkdownWithFrontmatter(frontmatter, input.body);
}

export function sha256Hex(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function utf8Bytes(text: string): typeof NonNegativeInt.Type {
  return NonNegativeInt.make(Buffer.byteLength(text, "utf8"));
}

function serializePluginSkillsDigest(skills: ReadonlyArray<HarnessSkillEntry>): string {
  return sha256Hex(
    JSON.stringify(skills.map((skill) => [skill.id, skill.sourcePath, skill.contentDigest])),
  ).slice(0, 16);
}

const CLAUDE_HARNESS_PLUGIN_MANIFEST = `${JSON.stringify(
  {
    name: "t3-harness",
    version: "1.0.0",
    description: "T3 Code portable harness skills",
  },
  null,
  2,
)}\n`;

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "on") return true;
    if (lower === "false" || lower === "no" || lower === "off") return false;
  }
  return undefined;
}

function parseStringList(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

export interface ParsedFrontmatter {
  readonly frontmatter: Record<string, unknown> | null;
  readonly body: string;
  readonly malformed: boolean;
}

export function parseMarkdownFrontmatter(raw: string): ParsedFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    return { frontmatter: null, body: raw, malformed: false };
  }
  const yamlText = match[1] ?? "";
  const body = raw.slice(match[0].length);
  try {
    const parsed = parseYaml(yamlText);
    if (parsed === null || parsed === undefined) {
      return { frontmatter: {}, body, malformed: false };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: null, body, malformed: true };
    }
    return { frontmatter: parsed as Record<string, unknown>, body, malformed: false };
  } catch {
    return { frontmatter: null, body, malformed: true };
  }
}

export function formatMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const cleanedEntries = Object.entries(frontmatter).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  const normalizedBody = body.replace(/^\r?\n/, "");
  if (cleanedEntries.length === 0) {
    return normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`;
  }
  const yamlBlock = stringifyYaml(Object.fromEntries(cleanedEntries)).trimEnd();
  const content = `---\n${yamlBlock}\n---\n\n${normalizedBody}`;
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function formatSkillMarkdown(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly shortDescription?: string | undefined;
  readonly userInvocable?: boolean | undefined;
  readonly userInvocationOnly?: boolean | undefined;
  readonly enabled?: boolean | undefined;
  readonly body: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
  };
  if (input.description !== undefined && input.description.trim().length > 0) {
    frontmatter.description = input.description.trim();
  }
  if (input.shortDescription !== undefined && input.shortDescription.trim().length > 0) {
    frontmatter["short-description"] = input.shortDescription.trim();
  }
  if (input.userInvocable === false) {
    frontmatter["user-invocable"] = false;
  }
  if (input.userInvocationOnly === true) {
    frontmatter["disable-model-invocation"] = true;
  }
  if (input.enabled === false) {
    frontmatter.enabled = false;
  }
  return formatMarkdownWithFrontmatter(frontmatter, input.body);
}

export function formatRuleMarkdown(input: {
  readonly description?: string | undefined;
  readonly apply: HarnessRuleApplyMode;
  readonly globs?: ReadonlyArray<string> | undefined;
  readonly enabled?: boolean | undefined;
  readonly body: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    apply: input.apply,
  };
  if (input.description !== undefined && input.description.trim().length > 0) {
    frontmatter.description = input.description.trim();
  }
  if (input.apply === "glob" && input.globs && input.globs.length > 0) {
    frontmatter.globs = [...input.globs];
  }
  if (input.enabled === false) {
    frontmatter.enabled = false;
  }
  return formatMarkdownWithFrontmatter(frontmatter, input.body);
}

export function formatCommandMarkdown(input: {
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly body: string;
}): string {
  const frontmatter: Record<string, unknown> = {};
  if (input.description !== undefined && input.description.trim().length > 0) {
    frontmatter.description = input.description.trim();
  }
  if (input.argumentHint !== undefined && input.argumentHint.trim().length > 0) {
    frontmatter["argument-hint"] = input.argumentHint.trim();
  }
  if (input.enabled === false) {
    frontmatter.enabled = false;
  }
  return formatMarkdownWithFrontmatter(frontmatter, input.body);
}

export interface HarnessSkillDetail {
  readonly skill: HarnessSkillEntry;
  readonly companionFiles: ReadonlyArray<string>;
}

export interface HarnessRuleDetail {
  readonly id: string;
  readonly scope: "user" | "project" | "builtin";
  readonly sourcePath: string | null;
  readonly apply: HarnessRuleApplyMode;
  readonly description?: string | undefined;
  readonly body: string;
  readonly bytes: number;
}

export class HarnessLibraryStore extends Context.Service<
  HarnessLibraryStore,
  {
    readonly getSnapshot: (
      workspaceRoot?: string | undefined,
    ) => Effect.Effect<HarnessLibrarySnapshot>;
    readonly saveUserAgentsMd: (input: {
      readonly body: string;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly upsertUserSkill: (
      input: HarnessSkillUpsertInput,
    ) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly removeUserSkill: (input: {
      readonly id: HarnessSkillId;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly setSkillEnabled: (input: {
      readonly id: HarnessSkillId;
      readonly enabled: boolean;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly upsertUserRule: (
      input: HarnessRuleUpsertInput,
    ) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly removeUserRule: (input: {
      readonly id: HarnessRuleId;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly setRuleEnabled: (input: {
      readonly id: HarnessRuleId;
      readonly enabled: boolean;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly upsertUserCommand: (
      input: HarnessCommandUpsertInput,
    ) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly removeUserCommand: (input: {
      readonly id: HarnessCommandId;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly setCommandEnabled: (input: {
      readonly id: HarnessCommandId;
      readonly enabled: boolean;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly upsertUserMode: (
      input: HarnessModeUpsertInput,
    ) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly createUserMode: (
      input: Omit<HarnessModeUpsertInput, "overrideBuiltin">,
    ) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly removeUserMode: (input: {
      readonly id: HarnessModeId;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly setModeEnabled: (input: {
      readonly id: HarnessModeId;
      readonly enabled: boolean;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly resolveMode: (input: {
      readonly modeId?: HarnessModeId | undefined;
      readonly interactionMode?: ProviderInteractionMode | undefined;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessModeEntry | null>;
    readonly updateSettings: (input: {
      readonly maxSystemContextBytes: typeof PositiveInt.Type | null;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<HarnessLibrarySnapshot, HarnessError>;
    readonly getSkillDetail: (input: {
      readonly nameOrId: string;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<Option.Option<HarnessSkillDetail>>;
    readonly getRuleDetail: (input: {
      readonly id: string;
      readonly workspaceRoot?: string | undefined;
    }) => Effect.Effect<Option.Option<HarnessRuleDetail>>;
    /** Materializes a read-only Claude local plugin directory for portable skills when `skillMount === "plugin-dir"`. */
    readonly materializeClaudePluginDir: (input: {
      readonly skills: ReadonlyArray<HarnessSkillEntry>;
    }) => Effect.Effect<string | undefined>;
    readonly materializeCodexSkillRoot: (input: {
      readonly skills: ReadonlyArray<HarnessSkillEntry>;
    }) => Effect.Effect<string | undefined>;
  }
>()("t3/harness/HarnessLibraryStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const store = yield* HarnessStore.HarnessStore;
  const pluginHostOption = yield* Effect.serviceOption(PluginHost.PluginHost);

  const harnessDir = store.harnessDir;
  const mountsRoot = path.join(serverConfig.stateDir, "harness-mounts");
  const writeLock = yield* Semaphore.make(1);

  const snapshots = new Map<
    string | null,
    {
      readonly fingerprint: string;
      readonly plugins: ReadonlyArray<PluginHost.PluginActiveContribution>;
      readonly snapshot: HarnessLibrarySnapshot;
    }
  >();
  let snapshotGeneration = 0;
  const invalidateSnapshots = Effect.sync(() => {
    snapshotGeneration++;
    snapshots.clear();
  });
  const withLibraryWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    writeLock.withPermits(1)(effect.pipe(Effect.ensuring(invalidateSnapshots)));

  const fileFingerprint = async (file: string): Promise<string> => {
    const stat = await NodeFSP.stat(file).catch(() => null);
    if (stat === null) return "";
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  };

  const directoryFingerprint = async (directory: string, skills = false) => {
    const entries = await NodeFSP.readdir(directory).catch(() => []);
    return [
      await fileFingerprint(directory),
      ...(await Promise.all(
        entries.toSorted().map(async (name) => {
          const item = path.join(directory, name);
          if (skills) {
            return [
              name,
              await fileFingerprint(item),
              await fileFingerprint(path.join(item, "SKILL.md")),
            ];
          }
          return name.endsWith(".md") ? [name, await fileFingerprint(item)] : [name];
        }),
      )),
    ];
  };

  const libraryFingerprint = async (workspaceRoot: string | null) => {
    const files = [
      fileFingerprint(path.join(harnessDir, "AGENTS.md")),
      directoryFingerprint(path.join(harnessDir, "skills"), true),
      ...["rules", "commands", "modes"].map((dir) =>
        directoryFingerprint(path.join(harnessDir, dir)),
      ),
    ];
    if (workspaceRoot !== null) {
      files.push(
        fileFingerprint(path.join(workspaceRoot, "AGENTS.md")),
        directoryFingerprint(path.join(workspaceRoot, ".agents", "skills"), true),
      );
    }
    return await Promise.all(files);
  };

  const isWithinRoot = (rootRealPath: string, candidateRealPath: string): boolean => {
    const rel = path.relative(rootRealPath, candidateRealPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  const resolveContainedPath = Effect.fn("HarnessLibraryStore.resolveContainedPath")(function* (
    rootDir: string,
    targetPath: string,
  ) {
    const rootReal = yield* fs
      .realPath(rootDir)
      .pipe(Effect.orElseSucceed(() => path.resolve(rootDir)));
    const targetReal = yield* fs
      .realPath(targetPath)
      .pipe(Effect.orElseSucceed(() => path.resolve(targetPath)));
    return isWithinRoot(rootReal, targetReal) ? targetReal : null;
  });

  const readBoundedContainedFile = Effect.fn("HarnessLibraryStore.readBoundedContainedFile")(
    function* (rootDir: string, filePath: string) {
      const contained = yield* resolveContainedPath(rootDir, filePath);
      if (contained === null)
        return Option.none<{ readonly text: string; readonly realPath: string }>();
      const info = yield* fs.stat(contained).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") {
        return Option.none<{ readonly text: string; readonly realPath: string }>();
      }
      if (Number(info.value.size) > MAX_READ_BYTES) {
        return Option.none<{ readonly text: string; readonly realPath: string }>();
      }
      const text = yield* fs.readFileString(contained).pipe(Effect.option);
      return Option.map(text, (content) => ({ text: content, realPath: contained }));
    },
  );

  const writeFileAtomic = Effect.fn("HarnessLibraryStore.writeFileAtomic")(function* (
    targetPath: string,
    contents: string,
  ) {
    yield* Effect.tryPromise({
      try: () => safeWriteFileAtomic(store.harnessDir, targetPath, contents),
      catch: (error) =>
        new HarnessError({
          code: "io_error",
          detail: `Failed to write ${path.basename(targetPath)}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  });

  const removeLibraryEntry = Effect.fn("HarnessLibraryStore.removeLibraryEntry")(function* (
    targetPath: string,
    label: string,
    options?: { readonly recursive?: boolean; readonly allowMissing?: boolean },
  ) {
    yield* Effect.tryPromise({
      try: async () => {
        const { resolvedTarget: parent } = await assertContainedNoSymlinks(
          harnessDir,
          path.dirname(targetPath),
        );
        const target = path.join(parent, path.basename(targetPath));
        const stat = await NodeFSP.lstat(target);
        if (options?.recursive && !stat.isSymbolicLink()) {
          await NodeFSP.rm(target, { recursive: true, force: true });
        } else {
          await NodeFSP.unlink(target);
        }
      },
      catch: (error) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
          ? new HarnessError({ code: "not_found", detail: `${label} was not found.` })
          : new HarnessError({ code: "io_error", detail: `Failed to safely remove ${label}.` }),
    }).pipe(
      Effect.catchIf(
        (error) => options?.allowMissing === true && error.code === "not_found",
        () => Effect.void,
      ),
    );
  });

  const assertPolicyAllows = Effect.fn("HarnessLibraryStore.assertPolicyAllows")(function* () {
    const overrides = yield* store.readProjectLibraryOverrides(undefined);
    if (!overrides.managedPolicyAllowsHarness) {
      return yield* new HarnessError({
        code: "policy_denied",
        detail: `${overrides.managedPolicyOrganization ?? "Organization"}'s policy does not allow portable harness extensions.`,
      });
    }
  });

  const readAgentsMdView = Effect.fn("HarnessLibraryStore.readAgentsMdView")(function* (
    scope: "user" | "project",
    rootDir: string,
  ): Effect.fn.Return<HarnessAgentsMdView> {
    const filePath = path.join(rootDir, "AGENTS.md");
    const loaded = yield* readBoundedContainedFile(rootDir, filePath);
    if (Option.isNone(loaded)) {
      return {
        scope,
        path: filePath,
        exists: false,
        contentDigest: sha256Hex(""),
        bytes: NonNegativeInt.make(0),
        body: "",
      };
    }
    return {
      scope,
      path: loaded.value.realPath,
      exists: true,
      contentDigest: sha256Hex(loaded.value.text),
      bytes: utf8Bytes(loaded.value.text),
      body: loaded.value.text,
    };
  });

  const loadSkillsFromDir = Effect.fn("HarnessLibraryStore.loadSkillsFromDir")(function* (input: {
    readonly scope: "user" | "project";
    readonly containmentRoot: string;
    readonly skillsDir: string;
    readonly invalidEntries: Array<HarnessInvalidEntry>;
  }) {
    const entries = yield* fs.readDirectory(input.skillsDir).pipe(Effect.orElseSucceed(() => []));
    const out: Array<
      Omit<HarnessSkillEntry, "effectiveEnabled" | "overriddenByProject"> & {
        readonly frontmatterEnabled: boolean;
      }
    > = [];
    for (const rawDirName of entries) {
      const skillDir = path.join(input.skillsDir, rawDirName);
      const stat = yield* fs.stat(skillDir).pipe(Effect.option);
      if (Option.isNone(stat) || stat.value.type !== "Directory") continue;
      const decodedId = decodeSkillId(rawDirName);
      if (Option.isNone(decodedId)) {
        input.invalidEntries.push({
          source: skillDir,
          id: rawDirName,
          message: `Skill directory "${rawDirName}" is not a valid skill identifier and was skipped.`,
        });
        continue;
      }
      const skillFilePath = path.join(skillDir, "SKILL.md");
      const loaded = yield* readBoundedContainedFile(input.containmentRoot, skillFilePath);
      if (Option.isNone(loaded)) continue;
      const parsed = parseMarkdownFrontmatter(loaded.value.text);
      if (parsed.malformed) {
        input.invalidEntries.push({
          source: loaded.value.realPath,
          id: decodedId.value,
          message: `Skill "${decodedId.value}" has malformed YAML frontmatter and was skipped.`,
        });
        continue;
      }
      const fm = parsed.frontmatter ?? {};
      const rawName = typeof fm.name === "string" ? fm.name.trim() : "";
      const name = TrimmedNonEmptyString.make(rawName.length > 0 ? rawName : decodedId.value);
      const description =
        typeof fm.description === "string" && fm.description.trim().length > 0
          ? fm.description.trim()
          : undefined;
      const shortDescription =
        typeof fm["short-description"] === "string" && fm["short-description"].trim().length > 0
          ? fm["short-description"].trim()
          : undefined;
      const userInvocable = parseBool(fm["user-invocable"]) ?? true;
      const userInvocationOnly = parseBool(fm["disable-model-invocation"]) ?? false;
      const frontmatterEnabled = parseBool(fm.enabled) ?? true;
      out.push({
        id: decodedId.value,
        name,
        scope: input.scope,
        ...(description !== undefined ? { description } : {}),
        ...(shortDescription !== undefined ? { shortDescription } : {}),
        userInvocable,
        userInvocationOnly,
        enabled: frontmatterEnabled,
        frontmatterEnabled,
        sourcePath: loaded.value.realPath,
        contentDigest: sha256Hex(loaded.value.text),
        bytes: utf8Bytes(loaded.value.text),
        body: parsed.body,
        origin: {
          kind: input.scope,
          source: input.scope === "project" ? ".agents/skills" : "harness",
          sourcePath: loaded.value.realPath,
        },
      });
    }
    return out;
  });

  const loadRulesFromDir = Effect.fn("HarnessLibraryStore.loadRulesFromDir")(function* (input: {
    readonly rulesDir: string;
    readonly invalidEntries: Array<HarnessInvalidEntry>;
  }) {
    const entries = yield* fs.readDirectory(input.rulesDir).pipe(Effect.orElseSucceed(() => []));
    const out: Array<
      Omit<HarnessRuleEntry, "effectiveEnabled" | "overriddenByProject"> & {
        readonly frontmatterEnabled: boolean;
      }
    > = [];
    for (const fileName of entries) {
      if (!fileName.endsWith(".md")) continue;
      const rawId = fileName.slice(0, -3);
      const filePath = path.join(input.rulesDir, fileName);
      const decodedId = decodeRuleId(rawId);
      if (Option.isNone(decodedId)) {
        input.invalidEntries.push({
          source: filePath,
          id: rawId,
          message: `Rule file "${fileName}" is not a valid rule identifier and was skipped.`,
        });
        continue;
      }
      const loaded = yield* readBoundedContainedFile(harnessDir, filePath);
      if (Option.isNone(loaded)) continue;
      const parsed = parseMarkdownFrontmatter(loaded.value.text);
      if (parsed.malformed) {
        input.invalidEntries.push({
          source: loaded.value.realPath,
          id: decodedId.value,
          message: `Rule "${decodedId.value}" has malformed YAML frontmatter and was skipped.`,
        });
        continue;
      }
      const fm = parsed.frontmatter ?? {};
      const applyOpt =
        fm.apply === undefined ? Option.some("always" as const) : decodeRuleApplyMode(fm.apply);
      const apply: HarnessRuleApplyMode = Option.isSome(applyOpt)
        ? applyOpt.value
        : parseBool(fm.alwaysApply) === true
          ? "always"
          : parseStringList(fm.globs).length > 0
            ? "glob"
            : "always";
      const globs = parseStringList(fm.globs);
      const description =
        typeof fm.description === "string" && fm.description.trim().length > 0
          ? fm.description.trim()
          : undefined;
      const frontmatterEnabled = parseBool(fm.enabled) ?? true;
      out.push({
        id: decodedId.value,
        scope: "user",
        ...(description !== undefined ? { description } : {}),
        apply,
        globs,
        enabled: frontmatterEnabled,
        frontmatterEnabled,
        sourcePath: loaded.value.realPath,
        contentDigest: sha256Hex(loaded.value.text),
        bytes: utf8Bytes(loaded.value.text),
        body: parsed.body,
        origin: { kind: "user", source: "harness", sourcePath: loaded.value.realPath },
      });
    }
    return out;
  });

  const loadCommandsFromDir = Effect.fn("HarnessLibraryStore.loadCommandsFromDir")(
    function* (input: {
      readonly commandsDir: string;
      readonly invalidEntries: Array<HarnessInvalidEntry>;
    }) {
      const entries = yield* fs
        .readDirectory(input.commandsDir)
        .pipe(Effect.orElseSucceed(() => []));
      const out: Array<
        Omit<HarnessCommandEntry, "effectiveEnabled" | "overriddenByProject"> & {
          readonly frontmatterEnabled: boolean;
        }
      > = [];
      for (const fileName of entries) {
        if (!fileName.endsWith(".md")) continue;
        const rawId = fileName.slice(0, -3);
        const filePath = path.join(input.commandsDir, fileName);
        if (isReservedHarnessCommandId(rawId)) {
          input.invalidEntries.push({
            source: filePath,
            id: rawId,
            message: `Command "/${rawId}" is reserved by T3 Code and was skipped.`,
          });
          continue;
        }
        const decodedId = decodeCommandId(rawId);
        if (Option.isNone(decodedId)) {
          input.invalidEntries.push({
            source: filePath,
            id: rawId,
            message: `Command file "${fileName}" is not a valid command identifier and was skipped.`,
          });
          continue;
        }
        const loaded = yield* readBoundedContainedFile(harnessDir, filePath);
        if (Option.isNone(loaded)) continue;
        const parsed = parseMarkdownFrontmatter(loaded.value.text);
        if (parsed.malformed) {
          input.invalidEntries.push({
            source: loaded.value.realPath,
            id: decodedId.value,
            message: `Command "/${decodedId.value}" has malformed YAML frontmatter and was skipped.`,
          });
          continue;
        }
        const fm = parsed.frontmatter ?? {};
        const description =
          typeof fm.description === "string" && fm.description.trim().length > 0
            ? fm.description.trim()
            : undefined;
        const argumentHint =
          typeof fm["argument-hint"] === "string" && fm["argument-hint"].trim().length > 0
            ? fm["argument-hint"].trim()
            : typeof fm.argumentHint === "string" && fm.argumentHint.trim().length > 0
              ? fm.argumentHint.trim()
              : undefined;
        const frontmatterEnabled = parseBool(fm.enabled) ?? true;
        out.push({
          id: decodedId.value,
          name: TrimmedNonEmptyString.make(decodedId.value),
          scope: "user",
          ...(description !== undefined ? { description } : {}),
          ...(argumentHint !== undefined ? { argumentHint } : {}),
          enabled: frontmatterEnabled,
          frontmatterEnabled,
          sourcePath: loaded.value.realPath,
          contentDigest: sha256Hex(loaded.value.text),
          bytes: utf8Bytes(loaded.value.text),
          body: parsed.body,
          origin: { kind: "user", source: "harness", sourcePath: loaded.value.realPath },
        });
      }
      return out;
    },
  );

  const snapshotLock = Semaphore.makeUnsafe(1);
  const getSnapshot: HarnessLibraryStore["Service"]["getSnapshot"] = Effect.fn(
    "HarnessLibraryStore.getSnapshot",
  )(function* (workspaceRoot) {
    const generation = snapshotGeneration;
    const [{ config: userConfig }, overrides] = yield* Effect.all([
      store.loadUserConfig,
      store.readProjectLibraryOverrides(workspaceRoot),
    ]);
    const plugins =
      Option.isSome(pluginHostOption) && overrides.managedPolicyAllowsHarness
        ? pluginHostOption.value.getActiveContributions()
        : [];
    const fingerprint = yield* encodeSnapshotFingerprint([
      yield* Effect.promise(() => libraryFingerprint(overrides.normalizedRepo)),
      userConfig.disabledSkills,
      userConfig.disabledRules,
      userConfig.disabledCommands,
      userConfig.disabledModes,
      [...overrides.disabledSkills],
      [...overrides.disabledRules],
      [...overrides.disabledCommands],
      [...overrides.disabledModes],
      overrides.invalidEntries,
      overrides.maxSystemContextBytes,
      overrides.managedPolicyAllowsHarness,
      overrides.managedPolicyOrganization,
    ]).pipe(Effect.orDie);
    const cached = snapshots.get(overrides.normalizedRepo);
    if (
      cached?.fingerprint === fingerprint &&
      cached.plugins.length === plugins.length &&
      plugins.every((plugin, index) => plugin === cached.plugins[index])
    ) {
      return cached.snapshot;
    }
    const invalidEntries: Array<HarnessInvalidEntry> = [...overrides.invalidEntries];
    const userDisabledSkills = new Set<string>(userConfig.disabledSkills);
    const userDisabledRules = new Set<string>(userConfig.disabledRules);
    const userDisabledCommands = new Set<string>(userConfig.disabledCommands);

    const userAgentsMd = yield* readAgentsMdView("user", harnessDir);
    const projectAgentsMd =
      overrides.normalizedRepo !== null
        ? yield* readAgentsMdView("project", overrides.normalizedRepo)
        : null;

    const rawUserSkills = yield* loadSkillsFromDir({
      scope: "user",
      containmentRoot: harnessDir,
      skillsDir: path.join(harnessDir, "skills"),
      invalidEntries,
    });
    const rawProjectSkills =
      overrides.normalizedRepo !== null
        ? yield* loadSkillsFromDir({
            scope: "project",
            containmentRoot: overrides.normalizedRepo,
            skillsDir: path.join(overrides.normalizedRepo, ".agents", "skills"),
            invalidEntries,
          })
        : [];
    const projectSkillNames = new Set(rawProjectSkills.map((item) => item.id.toLowerCase()));

    const skills: Array<HarnessSkillEntry> = [];
    for (const item of rawUserSkills) {
      const enabled = item.frontmatterEnabled && !userDisabledSkills.has(item.id);
      const overriddenByProject =
        projectSkillNames.has(item.id.toLowerCase()) || overrides.disabledSkills.has(item.id);
      const effectiveEnabled =
        overrides.managedPolicyAllowsHarness && enabled && !overriddenByProject;
      const { frontmatterEnabled: _fm, ...rest } = item;
      skills.push({ ...rest, enabled, effectiveEnabled, overriddenByProject });
    }
    for (const item of rawProjectSkills) {
      const enabled = item.frontmatterEnabled && !userDisabledSkills.has(item.id);
      const effectiveEnabled =
        overrides.managedPolicyAllowsHarness && enabled && !overrides.disabledSkills.has(item.id);
      const { frontmatterEnabled: _fm, ...rest } = item;
      skills.push({ ...rest, enabled, effectiveEnabled, overriddenByProject: false });
    }
    skills.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));

    const rawUserRules = yield* loadRulesFromDir({
      rulesDir: path.join(harnessDir, "rules"),
      invalidEntries,
    });
    const rules: Array<HarnessRuleEntry> = rawUserRules
      .map((item) => {
        const enabled = item.frontmatterEnabled && !userDisabledRules.has(item.id);
        const overriddenByProject = overrides.disabledRules.has(item.id);
        const effectiveEnabled =
          overrides.managedPolicyAllowsHarness && enabled && !overriddenByProject;
        const { frontmatterEnabled: _fm, ...rest } = item;
        return { ...rest, enabled, effectiveEnabled, overriddenByProject };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const rawUserCommands = yield* loadCommandsFromDir({
      commandsDir: path.join(harnessDir, "commands"),
      invalidEntries,
    });
    const commands: Array<HarnessCommandEntry> = rawUserCommands
      .map((item) => {
        const enabled = item.frontmatterEnabled && !userDisabledCommands.has(item.id);
        const overriddenByProject = overrides.disabledCommands.has(item.id);
        const effectiveEnabled =
          overrides.managedPolicyAllowsHarness && enabled && !overriddenByProject;
        const { frontmatterEnabled: _fm, ...rest } = item;
        return { ...rest, enabled, effectiveEnabled, overriddenByProject };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const userDisabledModes = new Set<string>(userConfig.disabledModes);
    const rawUserModes = yield* loadModesFromDir({
      modesDir: path.join(harnessDir, "modes"),
      invalidEntries,
    });
    const userModesById = new Map(rawUserModes.map((m) => [m.id, m] as const));
    const builtinIds = new Set<string>(BUILTIN_MODES.map((m) => m.id));
    const modes: Array<HarnessModeEntry> = [];

    for (const builtin of BUILTIN_MODES) {
      const override = userModesById.get(builtin.id);
      if (override !== undefined) {
        const enabled = override.frontmatterEnabled && !userDisabledModes.has(override.id);
        const overriddenByProject = overrides.disabledModes.has(override.id);
        const effectiveEnabled =
          overrides.managedPolicyAllowsHarness && enabled && !overriddenByProject;
        const { frontmatterEnabled: _fm, ...rest } = override;
        modes.push({
          ...rest,
          overriddenBuiltin: true,
          enabled,
          effectiveEnabled,
          overriddenByProject,
        });
      } else {
        const enabled = !userDisabledModes.has(builtin.id);
        const overriddenByProject = overrides.disabledModes.has(builtin.id);
        const effectiveEnabled =
          builtin.id === "build" || builtin.id === "plan"
            ? true
            : overrides.managedPolicyAllowsHarness && enabled && !overriddenByProject;
        modes.push({
          id: builtin.id,
          name: builtin.name,
          scope: "builtin",
          description: builtin.description,
          baseInteractionMode: builtin.baseInteractionMode,
          readonly: builtin.readonly,
          proposePlan: builtin.proposePlan,
          enabled,
          effectiveEnabled,
          overriddenByProject,
          sourcePath: null,
          contentDigest: sha256Hex(`${builtin.id}:${builtin.baseInteractionMode}:${builtin.body}`),
          bytes: utf8Bytes(builtin.body),
          body: builtin.body,
        });
      }
    }

    for (const item of rawUserModes) {
      if (builtinIds.has(item.id)) continue;
      const enabled = item.frontmatterEnabled && !userDisabledModes.has(item.id);
      const overriddenByProject = overrides.disabledModes.has(item.id);
      const effectiveEnabled =
        overrides.managedPolicyAllowsHarness && enabled && !overriddenByProject;
      const { frontmatterEnabled: _fm, ...rest } = item;
      modes.push({ ...rest, enabled, effectiveEnabled, overriddenByProject });
    }

    // Merge active (trusted + enabled) plugin contributions without overriding user/project ids.
    if (plugins.length > 0) {
      const existingSkillIds = new Set(skills.map((s) => s.id));
      const existingRuleIds = new Set(rules.map((r) => r.id));
      const existingCommandIds = new Set(commands.map((c) => c.id));
      const existingModeIds = new Set(modes.map((m) => m.id));
      for (const contrib of plugins) {
        for (const s of contrib.skills) {
          if (!existingSkillIds.has(s.id)) {
            existingSkillIds.add(s.id);
            skills.push(s);
          }
        }
        for (const r of contrib.rules) {
          if (!existingRuleIds.has(r.id)) {
            existingRuleIds.add(r.id);
            rules.push(r);
          }
        }
        for (const c of contrib.commands) {
          if (!existingCommandIds.has(c.id)) {
            existingCommandIds.add(c.id);
            commands.push(c);
          }
        }
        for (const m of contrib.modes) {
          if (!existingModeIds.has(m.id)) {
            existingModeIds.add(m.id);
            modes.push(m);
          }
        }
      }
    }

    const snapshot: HarnessLibrarySnapshot = {
      harnessDir,
      workspaceRoot: overrides.normalizedRepo,
      userAgentsMd,
      projectAgentsMd,
      skills,
      rules,
      commands,
      modes,
      maxSystemContextBytes: overrides.maxSystemContextBytes,
      invalidEntries,
      managedPolicyAllowsHarness: overrides.managedPolicyAllowsHarness,
      managedPolicyOrganization: overrides.managedPolicyOrganization,
    };
    if (generation === snapshotGeneration) {
      snapshots.delete(overrides.normalizedRepo);
      snapshots.set(overrides.normalizedRepo, { fingerprint, plugins, snapshot });
      if (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value ?? null);
    }
    return snapshot;
  }, snapshotLock.withPermits(1));

  const saveUserAgentsMd: HarnessLibraryStore["Service"]["saveUserAgentsMd"] = Effect.fn(
    "HarnessLibraryStore.saveUserAgentsMd",
  )(function* ({ body, workspaceRoot }) {
    yield* assertPolicyAllows();
    const targetPath = path.join(harnessDir, "AGENTS.md");
    yield* withLibraryWrite(
      body.trim().length === 0
        ? removeLibraryEntry(targetPath, "AGENTS.md", { allowMissing: true })
        : writeFileAtomic(targetPath, body.endsWith("\n") ? body : `${body}\n`),
    );
    return yield* getSnapshot(workspaceRoot);
  });

  const upsertUserSkill: HarnessLibraryStore["Service"]["upsertUserSkill"] = Effect.fn(
    "HarnessLibraryStore.upsertUserSkill",
  )(function* (input) {
    yield* assertPolicyAllows();
    const skillPath = path.join(harnessDir, "skills", input.id, "SKILL.md");
    const content = formatSkillMarkdown({
      name: input.name ?? input.id,
      description: input.description,
      shortDescription: input.shortDescription,
      userInvocable: input.userInvocable,
      userInvocationOnly: input.userInvocationOnly,
      enabled: input.enabled,
      body: input.body,
    });
    yield* withLibraryWrite(writeFileAtomic(skillPath, content));
    if (input.enabled !== undefined) {
      yield* store.setLibraryItemDisabled({
        kind: "skill",
        id: input.id,
        disabled: !input.enabled,
      });
    }
    return yield* getSnapshot(input.workspaceRoot);
  });

  const removeUserSkill: HarnessLibraryStore["Service"]["removeUserSkill"] = Effect.fn(
    "HarnessLibraryStore.removeUserSkill",
  )(function* ({ id, workspaceRoot }) {
    yield* assertPolicyAllows();
    const skillDir = path.join(harnessDir, "skills", id);
    yield* withLibraryWrite(
      removeLibraryEntry(skillDir, `Portable skill "${id}"`, { recursive: true }),
    );
    yield* store.setLibraryItemDisabled({ kind: "skill", id, disabled: false }).pipe(Effect.ignore);
    return yield* getSnapshot(workspaceRoot);
  });

  const setSkillEnabled: HarnessLibraryStore["Service"]["setSkillEnabled"] = Effect.fn(
    "HarnessLibraryStore.setSkillEnabled",
  )(function* ({ id, enabled, workspaceRoot }) {
    yield* assertPolicyAllows();
    yield* store.setLibraryItemDisabled({ kind: "skill", id, disabled: !enabled });
    return yield* getSnapshot(workspaceRoot);
  });

  const upsertUserRule: HarnessLibraryStore["Service"]["upsertUserRule"] = Effect.fn(
    "HarnessLibraryStore.upsertUserRule",
  )(function* (input) {
    yield* assertPolicyAllows();
    const rulePath = path.join(harnessDir, "rules", `${input.id}.md`);
    const content = formatRuleMarkdown({
      description: input.description,
      apply: input.apply,
      globs: input.globs,
      enabled: input.enabled,
      body: input.body,
    });
    yield* withLibraryWrite(writeFileAtomic(rulePath, content));
    if (input.enabled !== undefined) {
      yield* store.setLibraryItemDisabled({
        kind: "rule",
        id: input.id,
        disabled: !input.enabled,
      });
    }
    return yield* getSnapshot(input.workspaceRoot);
  });

  const removeUserRule: HarnessLibraryStore["Service"]["removeUserRule"] = Effect.fn(
    "HarnessLibraryStore.removeUserRule",
  )(function* ({ id, workspaceRoot }) {
    yield* assertPolicyAllows();
    const rulePath = path.join(harnessDir, "rules", `${id}.md`);
    yield* withLibraryWrite(removeLibraryEntry(rulePath, `Portable rule "${id}"`));
    yield* store.setLibraryItemDisabled({ kind: "rule", id, disabled: false }).pipe(Effect.ignore);
    return yield* getSnapshot(workspaceRoot);
  });

  const setRuleEnabled: HarnessLibraryStore["Service"]["setRuleEnabled"] = Effect.fn(
    "HarnessLibraryStore.setRuleEnabled",
  )(function* ({ id, enabled, workspaceRoot }) {
    yield* assertPolicyAllows();
    yield* store.setLibraryItemDisabled({ kind: "rule", id, disabled: !enabled });
    return yield* getSnapshot(workspaceRoot);
  });

  const upsertUserCommand: HarnessLibraryStore["Service"]["upsertUserCommand"] = Effect.fn(
    "HarnessLibraryStore.upsertUserCommand",
  )(function* (input) {
    yield* assertPolicyAllows();
    if (isReservedHarnessCommandId(input.id)) {
      return yield* new HarnessError({
        code: "invalid_config",
        detail: `Command "/${input.id}" is reserved by T3 Code.`,
      });
    }
    const commandPath = path.join(harnessDir, "commands", `${input.id}.md`);
    const content = formatCommandMarkdown({
      description: input.description,
      argumentHint: input.argumentHint,
      enabled: input.enabled,
      body: input.body,
    });
    yield* withLibraryWrite(writeFileAtomic(commandPath, content));
    if (input.enabled !== undefined) {
      yield* store.setLibraryItemDisabled({
        kind: "command",
        id: input.id,
        disabled: !input.enabled,
      });
    }
    return yield* getSnapshot(input.workspaceRoot);
  });

  const removeUserCommand: HarnessLibraryStore["Service"]["removeUserCommand"] = Effect.fn(
    "HarnessLibraryStore.removeUserCommand",
  )(function* ({ id, workspaceRoot }) {
    yield* assertPolicyAllows();
    const commandPath = path.join(harnessDir, "commands", `${id}.md`);
    yield* withLibraryWrite(removeLibraryEntry(commandPath, `Portable command "/${id}"`));
    yield* store
      .setLibraryItemDisabled({ kind: "command", id, disabled: false })
      .pipe(Effect.ignore);
    return yield* getSnapshot(workspaceRoot);
  });

  const setCommandEnabled: HarnessLibraryStore["Service"]["setCommandEnabled"] = Effect.fn(
    "HarnessLibraryStore.setCommandEnabled",
  )(function* ({ id, enabled, workspaceRoot }) {
    yield* assertPolicyAllows();
    yield* store.setLibraryItemDisabled({ kind: "command", id, disabled: !enabled });
    return yield* getSnapshot(workspaceRoot);
  });

  const updateSettings: HarnessLibraryStore["Service"]["updateSettings"] = Effect.fn(
    "HarnessLibraryStore.updateSettings",
  )(function* ({ maxSystemContextBytes, workspaceRoot }) {
    yield* store.updateSettings({ maxSystemContextBytes });
    return yield* getSnapshot(workspaceRoot);
  });

  const listCompanionFiles = Effect.fn("HarnessLibraryStore.listCompanionFiles")(function* (
    skillDir: string,
  ) {
    const out: Array<string> = [];
    const queue: Array<string> = [skillDir];
    let visitedDirectories = 0;
    while (queue.length > 0 && out.length < MAX_COMPANION_FILES && visitedDirectories < 256) {
      visitedDirectories += 1;
      const current = queue.shift()!;
      const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const full = path.join(current, name);
        const rel = path.relative(skillDir, full).replaceAll("\\", "/");
        if (rel === "SKILL.md") continue;
        const info = yield* Effect.promise(() => NodeFSP.lstat(full).catch(() => null));
        if (info === null) continue;
        if (info.isDirectory() && visitedDirectories + queue.length < 256) {
          queue.push(full);
        } else if (info.isFile()) {
          out.push(rel);
          if (out.length >= MAX_COMPANION_FILES) break;
        }
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  });

  const getSkillDetail: HarnessLibraryStore["Service"]["getSkillDetail"] = Effect.fn(
    "HarnessLibraryStore.getSkillDetail",
  )(function* ({ nameOrId, workspaceRoot }) {
    const snapshot = yield* getSnapshot(workspaceRoot);
    if (!snapshot.managedPolicyAllowsHarness) return Option.none();
    const target = nameOrId.trim().toLowerCase();
    // Prefer project skill over user skill when effectiveEnabled.
    const candidates = snapshot.skills.filter(
      (skill) =>
        skill.effectiveEnabled &&
        (skill.id.toLowerCase() === target || skill.name.toLowerCase() === target),
    );
    const chosen = candidates.find((skill) => skill.scope === "project") ?? candidates[0];
    if (!chosen) return Option.none();
    const companionFiles = yield* listCompanionFiles(path.dirname(chosen.sourcePath));
    return Option.some({ skill: chosen, companionFiles });
  });

  const getRuleDetail: HarnessLibraryStore["Service"]["getRuleDetail"] = Effect.fn(
    "HarnessLibraryStore.getRuleDetail",
  )(function* ({ id, workspaceRoot }) {
    const snapshot = yield* getSnapshot(workspaceRoot);
    if (!snapshot.managedPolicyAllowsHarness) return Option.none();
    const normalized = id.trim();
    if (normalized === "user:AGENTS.md" || normalized === "AGENTS.md") {
      if (!snapshot.userAgentsMd.exists || snapshot.userAgentsMd.body.trim().length === 0) {
        return Option.none();
      }
      return Option.some({
        id: "user:AGENTS.md",
        scope: "user" as const,
        sourcePath: snapshot.userAgentsMd.path,
        apply: "always" as const,
        description: "Personal cross-CLI AGENTS.md rules",
        body: snapshot.userAgentsMd.body,
        bytes: snapshot.userAgentsMd.bytes,
      });
    }
    if (normalized === "project:AGENTS.md") {
      if (
        snapshot.projectAgentsMd === null ||
        !snapshot.projectAgentsMd.exists ||
        snapshot.projectAgentsMd.body.trim().length === 0
      ) {
        return Option.none();
      }
      return Option.some({
        id: "project:AGENTS.md",
        scope: "project" as const,
        sourcePath: snapshot.projectAgentsMd.path,
        apply: "always" as const,
        description: "Repository AGENTS.md rules",
        body: snapshot.projectAgentsMd.body,
        bytes: snapshot.projectAgentsMd.bytes,
      });
    }
    if (normalized.toLowerCase().startsWith("mode:")) {
      const modeQuery = normalized.slice("mode:".length).trim().toLowerCase();
      if (modeQuery.length === 0) return Option.none();
      const foundMode = snapshot.modes.find(
        (mode) => mode.effectiveEnabled && mode.id.toLowerCase() === modeQuery,
      );
      if (!foundMode) return Option.none();
      return Option.some({
        id: `mode:${foundMode.id}`,
        scope: foundMode.scope,
        sourcePath: foundMode.sourcePath,
        apply: "manual" as const,
        description: foundMode.description ?? `Declarative mode "${foundMode.name}"`,
        body: foundMode.body,
        bytes: foundMode.bytes,
      });
    }
    const found = snapshot.rules.find(
      (rule) => rule.effectiveEnabled && rule.id.toLowerCase() === normalized.toLowerCase(),
    );
    if (!found) return Option.none();
    return Option.some({
      id: found.id,
      scope: found.scope,
      sourcePath: found.sourcePath,
      apply: found.apply,
      ...(found.description !== undefined ? { description: found.description } : {}),
      body: found.body,
      bytes: found.bytes,
    });
  });

  const materializeSkillMount = Effect.fn("HarnessLibraryStore.materializeSkillMount")(function* (
    kind: "claude-plugin" | "codex-skills",
    skills: ReadonlyArray<HarnessSkillEntry>,
  ) {
    if (skills.length === 0) return undefined;
    const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
    const digest = serializePluginSkillsDigest(sorted);
    const mountName = `${kind}-${digest}`;
    const mountDir = path.join(mountsRoot, mountName);
    const readyPath =
      kind === "claude-plugin"
        ? path.join(mountDir, ".claude-plugin", "plugin.json")
        : path.join(mountDir, ".ready");
    const checkedReady = Effect.tryPromise({
      try: () => assertContainedNoSymlinks(mountsRoot, readyPath, { createRoot: true }),
      catch: () => new HarnessError({ code: "io_error", detail: "Invalid skill mount path." }),
    }).pipe(Effect.option);
    const checked = yield* checkedReady;
    if (Option.isNone(checked)) return undefined;
    const alreadyExists = yield* fs
      .exists(checked.value.resolvedTarget)
      .pipe(Effect.orElseSucceed(() => false));
    if (alreadyExists) return path.join(checked.value.canonicalRoot, mountName);

    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const fresh = yield* checkedReady;
        if (Option.isNone(fresh)) return undefined;
        const target = path.join(fresh.value.canonicalRoot, mountName);
        if (yield* fs.exists(fresh.value.resolvedTarget).pipe(Effect.orElseSucceed(() => false))) {
          return target;
        }
        const stageDir = `${target}.${NodeCrypto.randomUUID()}.stage`;
        const stage = Effect.gen(function* () {
          yield* fs.makeDirectory(stageDir, { mode: 0o700 });
          const skillRoot = kind === "claude-plugin" ? path.join(stageDir, "skills") : stageDir;
          for (const skill of sorted) {
            const targetSkillDir = path.join(skillRoot, skill.id);
            const sourceSkillDir = path.dirname(skill.sourcePath);
            const raw = yield* readBoundedContainedFile(sourceSkillDir, skill.sourcePath);
            if (Option.isNone(raw) || sha256Hex(raw.value.text) !== skill.contentDigest)
              return false;
            yield* fs.makeDirectory(targetSkillDir, { recursive: true });
            yield* fs.writeFileString(path.join(targetSkillDir, "SKILL.md"), raw.value.text);

            // Copy bounded non-escaping companion files (e.g., references/, scripts/, checklists)
            // alongside SKILL.md so Claude plugin-dir skills have full relative asset access.
            const companions = yield* listCompanionFiles(sourceSkillDir);
            for (const relPath of companions) {
              const srcFile = path.join(sourceSkillDir, relPath);
              const contained = yield* resolveContainedPath(sourceSkillDir, srcFile);
              if (contained === null) continue;
              const info = yield* fs.stat(contained).pipe(Effect.option);
              if (
                Option.isNone(info) ||
                info.value.type !== "File" ||
                Number(info.value.size) > MAX_READ_BYTES
              )
                continue;
              const destFile = path.join(targetSkillDir, relPath);
              const fileBytes = yield* fs.readFile(contained).pipe(
                Effect.asSome,
                Effect.orElseSucceed(() => Option.none<Uint8Array>()),
              );
              if (Option.isNone(fileBytes) || fileBytes.value.byteLength > MAX_READ_BYTES) {
                continue;
              }
              yield* fs.makeDirectory(path.dirname(destFile), { recursive: true });
              yield* fs.writeFile(destFile, fileBytes.value);
            }
          }
          const marker = path.join(stageDir, path.relative(mountDir, readyPath));
          yield* fs.makeDirectory(path.dirname(marker), { recursive: true });
          yield* fs.writeFileString(
            marker,
            kind === "claude-plugin" ? CLAUDE_HARNESS_PLUGIN_MANIFEST : "",
          );
          yield* fs.rename(stageDir, target);
          return true;
        });
        const promoted = yield* stage.pipe(
          Effect.orElseSucceed(() => false),
          Effect.ensuring(
            fs.remove(stageDir, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
        if (!promoted) return undefined;

        if (kind === "codex-skills") return target;

        // Prune older staging directories beyond the 6 most recent to avoid stateDir bloat.
        const mountEntries = yield* fs
          .readDirectory(mountsRoot)
          .pipe(Effect.orElseSucceed(() => []));
        const stale = mountEntries.filter(
          (name) => name.startsWith("claude-plugin-") && name !== mountName,
        );
        if (stale.length > 6) {
          for (const oldName of stale.slice(0, stale.length - 6)) {
            yield* fs
              .remove(path.join(mountsRoot, oldName), { recursive: true, force: true })
              .pipe(Effect.ignore);
          }
        }
        return target;
      }),
    );
  });

  const materializeClaudePluginDir: HarnessLibraryStore["Service"]["materializeClaudePluginDir"] =
    ({ skills }) => materializeSkillMount("claude-plugin", skills);
  const materializeCodexSkillRoot: HarnessLibraryStore["Service"]["materializeCodexSkillRoot"] = ({
    skills,
  }) => materializeSkillMount("codex-skills", skills);

  const loadModesFromDir = Effect.fn("HarnessLibraryStore.loadModesFromDir")(function* (input: {
    readonly modesDir: string;
    readonly invalidEntries: Array<HarnessInvalidEntry>;
  }) {
    const entries = yield* fs.readDirectory(input.modesDir).pipe(Effect.orElseSucceed(() => []));
    const out: Array<
      Omit<HarnessModeEntry, "effectiveEnabled" | "overriddenByProject"> & {
        readonly frontmatterEnabled: boolean;
      }
    > = [];
    for (const fileName of entries) {
      if (!fileName.endsWith(".md")) continue;
      const rawId = fileName.slice(0, -3);
      const filePath = path.join(input.modesDir, fileName);
      const decodedId = decodeModeId(rawId);
      if (Option.isNone(decodedId)) {
        input.invalidEntries.push({
          source: filePath,
          id: rawId,
          message: `Mode file "${fileName}" is not a valid mode identifier and was skipped.`,
        });
        continue;
      }
      const loaded = yield* readBoundedContainedFile(harnessDir, filePath);
      if (Option.isNone(loaded)) continue;
      const parsed = parseMarkdownFrontmatter(loaded.value.text);
      if (parsed.malformed) {
        input.invalidEntries.push({
          source: filePath,
          id: decodedId.value,
          message: `Mode "${decodedId.value}" has malformed YAML frontmatter and was skipped.`,
        });
        continue;
      }
      const fm = parsed.frontmatter ?? {};
      const nameStr =
        typeof fm.name === "string" && fm.name.trim().length > 0
          ? fm.name.trim().slice(0, 128)
          : decodedId.value;
      const description =
        typeof fm.description === "string" && fm.description.trim().length > 0
          ? fm.description.trim().slice(0, 512)
          : undefined;
      const baseInteractionMode: ProviderInteractionMode =
        fm.baseInteractionMode === "plan" || fm.interactionMode === "plan" ? "plan" : "default";
      const readonly = parseBool(fm.readonly) ?? baseInteractionMode === "plan";
      const proposePlan =
        parseBool(fm.proposePlan) ?? (decodedId.value === "plan" && baseInteractionMode === "plan");
      const defaultModel =
        typeof fm.defaultModel === "string" && fm.defaultModel.trim().length > 0
          ? TrimmedNonEmptyString.make(fm.defaultModel.trim().slice(0, 128))
          : undefined;
      const parseMcpIds = (raw: unknown): ReadonlyArray<HarnessMcpServerId> =>
        parseStringList(raw).flatMap((v) => {
          const d = decodeMcpServerId(v);
          return Option.isSome(d) ? [d.value] : [];
        });
      const parseRuleIds = (raw: unknown): ReadonlyArray<HarnessRuleId> =>
        parseStringList(raw).flatMap((v) => {
          const d = decodeRuleId(v);
          return Option.isSome(d) ? [d.value] : [];
        });
      const parseSkillIds = (raw: unknown): ReadonlyArray<HarnessSkillId> =>
        parseStringList(raw).flatMap((v) => {
          const d = decodeSkillId(v);
          return Option.isSome(d) ? [d.value] : [];
        });
      const allowedMcpServers = parseMcpIds(fm.allowedMcpServers);
      const disabledMcpServers = parseMcpIds(fm.disabledMcpServers);
      const includedRules = parseRuleIds(fm.includedRules);
      const includedSkills = parseSkillIds(fm.includedSkills);
      const frontmatterEnabled = parseBool(fm.enabled) ?? true;
      out.push({
        id: decodedId.value,
        name: TrimmedNonEmptyString.make(nameStr),
        scope: "user",
        ...(description !== undefined ? { description } : {}),
        baseInteractionMode,
        readonly,
        proposePlan,
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        ...(allowedMcpServers.length > 0 ? { allowedMcpServers } : {}),
        ...(disabledMcpServers.length > 0 ? { disabledMcpServers } : {}),
        ...(includedRules.length > 0 ? { includedRules } : {}),
        ...(includedSkills.length > 0 ? { includedSkills } : {}),
        enabled: frontmatterEnabled,
        frontmatterEnabled,
        sourcePath: loaded.value.realPath,
        contentDigest: sha256Hex(loaded.value.text),
        bytes: utf8Bytes(parsed.body),
        body: parsed.body,
      });
    }
    return out;
  });

  const saveUserMode = Effect.fn("HarnessLibraryStore.saveUserMode")(function* (
    input: HarnessModeUpsertInput,
    createOnly: boolean,
  ) {
    yield* assertPolicyAllows();
    if (RESERVED_MODE_IDS.has(input.id) && (createOnly || input.overrideBuiltin !== true)) {
      return yield* new HarnessError({
        code: "invalid_config",
        detail: `Mode "${input.id}" is built in. Customize it in Harness Settings.`,
      });
    }
    const modePath = path.join(harnessDir, "modes", `${input.id}.md`);
    const content = formatModeMarkdown({
      name: input.name ?? input.id,
      description: input.description,
      baseInteractionMode: input.baseInteractionMode,
      readonly: input.readonly ?? input.baseInteractionMode === "plan",
      proposePlan:
        input.proposePlan ?? (input.id === "plan" && input.baseInteractionMode === "plan"),
      defaultModel: input.defaultModel,
      allowedMcpServers: input.allowedMcpServers,
      disabledMcpServers: input.disabledMcpServers,
      includedRules: input.includedRules,
      includedSkills: input.includedSkills,
      enabled: input.enabled,
      body: input.body,
    });
    yield* withLibraryWrite(
      Effect.gen(function* () {
        if (createOnly) {
          const existsOnDisk = yield* fs.exists(modePath).pipe(Effect.orElseSucceed(() => false));
          const existsInPlugin = Option.getOrUndefined(pluginHostOption)
            ?.getActiveContributions()
            .some((plugin) => plugin.modes.some((mode) => mode.id === input.id));
          if (existsOnDisk || existsInPlugin) {
            return yield* new HarnessError({
              code: "invalid_config",
              detail: `Mode "${input.id}" already exists. Edit it in Harness Settings.`,
            });
          }
        }
        yield* writeFileAtomic(modePath, content);
        if (input.enabled !== undefined) {
          yield* store.setLibraryItemDisabled({
            kind: "mode",
            id: input.id,
            disabled: !input.enabled,
          });
        }
      }),
    );
    return yield* getSnapshot(input.workspaceRoot);
  });

  const removeUserMode: HarnessLibraryStore["Service"]["removeUserMode"] = Effect.fn(
    "HarnessLibraryStore.removeUserMode",
  )(function* ({ id, workspaceRoot }) {
    yield* assertPolicyAllows();
    const modePath = path.join(harnessDir, "modes", `${id}.md`);
    yield* withLibraryWrite(removeLibraryEntry(modePath, `Portable mode "${id}"`));
    return yield* getSnapshot(workspaceRoot);
  });

  const setModeEnabled: HarnessLibraryStore["Service"]["setModeEnabled"] = Effect.fn(
    "HarnessLibraryStore.setModeEnabled",
  )(function* ({ id, enabled, workspaceRoot }) {
    yield* assertPolicyAllows();
    yield* store.setLibraryItemDisabled({ kind: "mode", id, disabled: !enabled });
    return yield* getSnapshot(workspaceRoot);
  });

  const resolveMode: HarnessLibraryStore["Service"]["resolveMode"] = Effect.fn(
    "HarnessLibraryStore.resolveMode",
  )(function* ({ modeId, interactionMode, workspaceRoot }) {
    const snapshot = yield* getSnapshot(workspaceRoot);
    const targetId =
      modeId ??
      (interactionMode === "plan" ? HarnessModeId.make("plan") : HarnessModeId.make("build"));
    const exact = snapshot.modes.find(
      (mode) => mode.id.toLowerCase() === targetId.toLowerCase() && mode.effectiveEnabled,
    );
    if (exact !== undefined) return exact;
    const fallbackId = interactionMode === "plan" ? "plan" : "build";
    return snapshot.modes.find((mode) => mode.id === fallbackId) ?? null;
  });

  return HarnessLibraryStore.of({
    getSnapshot,
    saveUserAgentsMd,
    upsertUserSkill,
    removeUserSkill,
    setSkillEnabled,
    upsertUserRule,
    removeUserRule,
    setRuleEnabled,
    upsertUserCommand,
    removeUserCommand,
    setCommandEnabled,
    upsertUserMode: Effect.fn("HarnessLibraryStore.upsertUserMode")((input) =>
      saveUserMode(input, false),
    ),
    createUserMode: Effect.fn("HarnessLibraryStore.createUserMode")((input) =>
      saveUserMode(input, true),
    ),
    removeUserMode,
    setModeEnabled,
    resolveMode,
    updateSettings,
    getSkillDetail,
    getRuleDetail,
    materializeClaudePluginDir,
    materializeCodexSkillRoot,
  });
});

export const layer = Layer.effect(HarnessLibraryStore, make);
