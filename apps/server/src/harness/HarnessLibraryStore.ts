// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous SHA-256 digests and temp-file UUIDs for portable library entries and staging mounts.
import * as NodeCrypto from "node:crypto";
import {
  type HarnessAgentsMdView,
  type HarnessCommandEntry,
  HarnessCommandId,
  type HarnessCommandUpsertInput,
  HarnessError,
  type HarnessInvalidEntry,
  type HarnessLibrarySnapshot,
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

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_READ_BYTES = 262_144;
const MAX_COMPANION_FILES = 32;

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);
const decodeRuleApplyMode = Schema.decodeUnknownOption(HarnessRuleApplyMode);

export function sha256Hex(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function utf8Bytes(text: string): typeof NonNegativeInt.Type {
  return NonNegativeInt.make(Buffer.byteLength(text, "utf8"));
}

function serializePluginSkillsDigest(skills: ReadonlyArray<HarnessSkillEntry>): string {
  return sha256Hex(
    JSON.stringify(skills.map((skill) => [skill.id, skill.name, skill.contentDigest])),
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
  readonly scope: "user" | "project";
  readonly sourcePath: string;
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
  }
>()("t3/harness/HarnessLibraryStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const store = yield* HarnessStore.HarnessStore;

  const harnessDir = store.harnessDir;
  const mountsRoot = path.join(serverConfig.stateDir, "harness-mounts");
  const writeLock = yield* Semaphore.make(1);

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
    const dir = path.dirname(targetPath);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new HarnessError({
            code: "io_error",
            detail: `Could not create directory for ${path.basename(targetPath)}.`,
          }),
      ),
    );
    const tmpPath = `${targetPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(tmpPath, contents).pipe(
      Effect.andThen(fs.rename(tmpPath, targetPath)),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(
        () =>
          new HarnessError({
            code: "io_error",
            detail: `Failed to write ${path.basename(targetPath)}.`,
          }),
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

  const getSnapshot: HarnessLibraryStore["Service"]["getSnapshot"] = Effect.fn(
    "HarnessLibraryStore.getSnapshot",
  )(function* (workspaceRoot) {
    const [{ config: userConfig }, overrides] = yield* Effect.all([
      store.loadUserConfig,
      store.readProjectLibraryOverrides(workspaceRoot),
    ]);
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

    return {
      harnessDir,
      workspaceRoot: overrides.normalizedRepo,
      userAgentsMd,
      projectAgentsMd,
      skills,
      rules,
      commands,
      maxSystemContextBytes: overrides.maxSystemContextBytes,
      invalidEntries,
      managedPolicyAllowsHarness: overrides.managedPolicyAllowsHarness,
      managedPolicyOrganization: overrides.managedPolicyOrganization,
    };
  });

  const saveUserAgentsMd: HarnessLibraryStore["Service"]["saveUserAgentsMd"] = Effect.fn(
    "HarnessLibraryStore.saveUserAgentsMd",
  )(function* ({ body, workspaceRoot }) {
    yield* assertPolicyAllows();
    const targetPath = path.join(harnessDir, "AGENTS.md");
    yield* writeLock.withPermits(1)(
      body.trim().length === 0
        ? fs.remove(targetPath, { force: true }).pipe(
            Effect.mapError(
              () =>
                new HarnessError({
                  code: "io_error",
                  detail: "Failed to remove AGENTS.md.",
                }),
            ),
          )
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
    yield* writeLock.withPermits(1)(writeFileAtomic(skillPath, content));
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
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const exists = yield* fs.exists(skillDir).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* new HarnessError({
            code: "not_found",
            detail: `Portable skill "${id}" was not found.`,
          });
        }
        const contained = yield* resolveContainedPath(harnessDir, skillDir);
        if (contained === null) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: `Skill path for "${id}" escapes the harness directory.`,
          });
        }
        yield* fs.remove(contained, { recursive: true, force: true }).pipe(
          Effect.mapError(
            () =>
              new HarnessError({
                code: "io_error",
                detail: `Failed to remove skill "${id}".`,
              }),
          ),
        );
      }),
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
    yield* writeLock.withPermits(1)(writeFileAtomic(rulePath, content));
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
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const exists = yield* fs.exists(rulePath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* new HarnessError({
            code: "not_found",
            detail: `Portable rule "${id}" was not found.`,
          });
        }
        const contained = yield* resolveContainedPath(harnessDir, rulePath);
        if (contained === null) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: `Rule path for "${id}" escapes the harness directory.`,
          });
        }
        yield* fs.remove(contained, { force: true }).pipe(
          Effect.mapError(
            () =>
              new HarnessError({
                code: "io_error",
                detail: `Failed to remove rule "${id}".`,
              }),
          ),
        );
      }),
    );
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
    yield* writeLock.withPermits(1)(writeFileAtomic(commandPath, content));
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
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const exists = yield* fs.exists(commandPath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* new HarnessError({
            code: "not_found",
            detail: `Portable command "/${id}" was not found.`,
          });
        }
        const contained = yield* resolveContainedPath(harnessDir, commandPath);
        if (contained === null) {
          return yield* new HarnessError({
            code: "invalid_config",
            detail: `Command path for "/${id}" escapes the harness directory.`,
          });
        }
        yield* fs.remove(contained, { force: true }).pipe(
          Effect.mapError(
            () =>
              new HarnessError({
                code: "io_error",
                detail: `Failed to remove command "/${id}".`,
              }),
          ),
        );
      }),
    );
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
    while (queue.length > 0 && out.length < MAX_COMPANION_FILES) {
      const current = queue.shift()!;
      const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const full = path.join(current, name);
        const rel = path.relative(skillDir, full).replaceAll("\\", "/");
        if (rel === "SKILL.md") continue;
        const info = yield* fs.stat(full).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          queue.push(full);
        } else if (info.value.type === "File") {
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

  const materializeClaudePluginDir: HarnessLibraryStore["Service"]["materializeClaudePluginDir"] =
    Effect.fn("HarnessLibraryStore.materializeClaudePluginDir")(function* ({ skills }) {
      if (skills.length === 0) return undefined;
      const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
      const digest = serializePluginSkillsDigest(sorted);
      const pluginDir = path.join(mountsRoot, `claude-plugin-${digest}`);
      const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
      const alreadyExists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
      if (alreadyExists) return pluginDir;

      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          if (yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false))) {
            return pluginDir;
          }
          const stageDir = `${pluginDir}.${NodeCrypto.randomUUID()}.stage`;
          yield* fs
            .makeDirectory(path.join(stageDir, ".claude-plugin"), { recursive: true })
            .pipe(Effect.ignore);
          yield* fs
            .writeFileString(
              path.join(stageDir, ".claude-plugin", "plugin.json"),
              CLAUDE_HARNESS_PLUGIN_MANIFEST,
            )
            .pipe(Effect.ignore);

          for (const skill of sorted) {
            const targetSkillDir = path.join(stageDir, "skills", skill.id);
            const raw = yield* fs
              .readFileString(skill.sourcePath)
              .pipe(Effect.orElseSucceed(() => ""));
            if (raw.length === 0) continue;
            yield* fs.makeDirectory(targetSkillDir, { recursive: true }).pipe(Effect.ignore);
            yield* fs
              .writeFileString(path.join(targetSkillDir, "SKILL.md"), raw)
              .pipe(Effect.ignore);

            // Copy bounded non-escaping companion files (e.g., references/, scripts/, checklists)
            // alongside SKILL.md so Claude plugin-dir skills have full relative asset access.
            const sourceSkillDir = path.dirname(skill.sourcePath);
            const companions = yield* listCompanionFiles(sourceSkillDir);
            for (const relPath of companions) {
              const srcFile = path.join(sourceSkillDir, relPath);
              const contained = yield* resolveContainedPath(sourceSkillDir, srcFile);
              if (contained === null) continue;
              const destFile = path.join(targetSkillDir, relPath);
              const fileBytes = yield* fs.readFile(contained).pipe(
                Effect.asSome,
                Effect.orElseSucceed(() => Option.none<Uint8Array>()),
              );
              if (Option.isNone(fileBytes) || fileBytes.value.byteLength > MAX_READ_BYTES) {
                continue;
              }
              yield* fs
                .makeDirectory(path.dirname(destFile), { recursive: true })
                .pipe(Effect.ignore);
              yield* fs.writeFile(destFile, fileBytes.value).pipe(Effect.ignore);
            }
          }

          const promoted = yield* fs.rename(stageDir, pluginDir).pipe(
            Effect.as(true),
            Effect.catch(() =>
              fs
                .remove(stageDir, { recursive: true, force: true })
                .pipe(Effect.ignore, Effect.as(false)),
            ),
          );
          if (
            !promoted &&
            !(yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false)))
          ) {
            return undefined;
          }

          // Prune older staging directories beyond the 6 most recent to avoid stateDir bloat.
          const mountEntries = yield* fs
            .readDirectory(mountsRoot)
            .pipe(Effect.orElseSucceed(() => []));
          const stale = mountEntries.filter(
            (name) => name.startsWith("claude-plugin-") && name !== `claude-plugin-${digest}`,
          );
          if (stale.length > 6) {
            for (const oldName of stale.slice(0, stale.length - 6)) {
              yield* fs
                .remove(path.join(mountsRoot, oldName), { recursive: true, force: true })
                .pipe(Effect.ignore);
            }
          }
          return pluginDir;
        }),
      );
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
    updateSettings,
    getSkillDetail,
    getRuleDetail,
    materializeClaudePluginDir,
  });
});

export const layer = Layer.effect(HarnessLibraryStore, make);
