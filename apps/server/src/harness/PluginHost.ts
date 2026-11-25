// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Uses SHA-256 hashing, realpath containment, and out-of-process JSON-RPC child execution for trusted SDK plugins.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import {
  type HarnessCommandEntry,
  HarnessCommandId,
  HarnessError,
  type HarnessHookDefinition,
  HarnessHookEvent,
  HarnessHookId,
  HarnessHookTarget,
  type HarnessModeEntry,
  HarnessModeId,
  type HarnessPluginFormat,
  HarnessPluginId,
  type HarnessPluginInstallInput,
  type HarnessPluginReloadInput,
  type HarnessPluginRemoveInput,
  type HarnessPluginSetEnabledInput,
  type HarnessPluginsSnapshot,
  type HarnessPluginTrustInput,
  type HarnessPluginTrustStatus,
  type HarnessPluginView,
  type HarnessRuleApplyMode,
  type HarnessRuleEntry,
  HarnessRuleId,
  type HarnessSkillEntry,
  HarnessSkillId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { parse as parseYaml } from "yaml";

import * as HarnessHooksService from "./HarnessHooksService.ts";
import * as HarnessStore from "./HarnessStore.ts";

const PLUGINS_DIR_NAME = "plugins";
const PLUGINS_STATE_FILE = "plugins-state.json";
const MAX_PLUGIN_FILES = 256;
const MAX_PLUGIN_TOTAL_BYTES = 4 * 1024 * 1024;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const decodePluginId = Schema.decodeUnknownOption(HarnessPluginId);
const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);
const decodeRuleId = Schema.decodeUnknownOption(HarnessRuleId);
const decodeCommandId = Schema.decodeUnknownOption(HarnessCommandId);
const decodeModeId = Schema.decodeUnknownOption(HarnessModeId);
const decodeHookId = Schema.decodeUnknownOption(HarnessHookId);
const decodeHookEvent = Schema.decodeUnknownOption(HarnessHookEvent);
const decodeHookTarget = Schema.decodeUnknownOption(HarnessHookTarget);

interface PluginsPersistedState {
  readonly version: 1;
  readonly trustedDigests: Record<string, string>;
  readonly enabled: Record<string, boolean>;
}

const DEFAULT_PERSISTED_STATE: PluginsPersistedState = {
  version: 1,
  trustedDigests: {},
  enabled: {},
};

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function sha256Hex(input: string | Buffer): string {
  return NodeCrypto.createHash("sha256").update(input).digest("hex");
}

function parseFrontmatter(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    const parsed = parseYaml(match[1] ?? "");
    const frontmatter =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: raw.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: raw.slice(match[0].length) };
  }
}

function parseStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isContainedIn(rootReal: string, candidateReal: string): boolean {
  const rel = NodePath.relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !NodePath.isAbsolute(rel));
}

async function walkContainedFiles(
  rootDir: string,
): Promise<
  ReadonlyArray<{ readonly relPath: string; readonly fullPath: string; readonly content: Buffer }>
> {
  const rootReal = await NodeFSP.realpath(rootDir);
  const files: Array<{
    readonly relPath: string;
    readonly fullPath: string;
    readonly content: Buffer;
  }> = [];
  let totalBytes = 0;

  const visit = async (dir: string): Promise<void> => {
    const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = NodePath.join(dir, entry.name);
      const real = await NodeFSP.realpath(fullPath);
      if (!isContainedIn(rootReal, real)) {
        throw new Error(`Plugin path escapes plugin root via symlink: ${entry.name}`);
      }
      const stat = await NodeFSP.stat(real);
      if (stat.isDirectory()) {
        await visit(real);
      } else if (stat.isFile()) {
        if (files.length >= MAX_PLUGIN_FILES) {
          throw new Error(`Plugin exceeds maximum file limit (${MAX_PLUGIN_FILES}).`);
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
          throw new Error(`Plugin exceeds maximum size limit (${MAX_PLUGIN_TOTAL_BYTES} bytes).`);
        }
        const content = await NodeFSP.readFile(real);
        const relPath = NodePath.relative(rootReal, real).split(NodePath.sep).join("/");
        files.push({ relPath, fullPath: real, content });
      }
    }
  };

  await visit(rootReal);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

async function copyContainedDirectory(sourceDir: string, destDir: string): Promise<void> {
  const files = await walkContainedFiles(sourceDir);
  await NodeFSP.rm(destDir, { recursive: true, force: true });
  await NodeFSP.mkdir(destDir, { recursive: true });
  for (const file of files) {
    const target = NodePath.join(destDir, file.relPath);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, file.content);
  }
}

export interface PluginSdkExposedTool {
  readonly pluginId: HarnessPluginId;
  readonly exposedName: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface PluginSdkToolCallResult {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}

interface OutOfProcessSdkRuntime {
  readonly tools: ReadonlyArray<PluginSdkExposedTool>;
  readonly modes: ReadonlyArray<HarnessModeEntry>;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly workspaceRoot?: string | undefined;
    readonly threadId?: string | undefined;
  }) => Promise<PluginSdkToolCallResult>;
  readonly close: () => void;
}

function canonicalPluginToolName(pluginId: HarnessPluginId, toolName: string): string {
  return `plugin__${pluginId}__${toolName}`;
}

async function spawnOutOfProcessSdkPlugin(
  pluginId: HarnessPluginId,
  pluginDir: string,
  entrypointRel: string,
  platform: NodeJS.Platform,
): Promise<OutOfProcessSdkRuntime> {
  const entrypointAbs = NodePath.resolve(pluginDir, entrypointRel);
  const child = NodeChildProcess.spawn(process.execPath, [entrypointAbs], {
    cwd: pluginDir,
    stdio: ["pipe", "pipe", "pipe"],
    detached: platform !== "win32",
  });

  let closed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      readonly resolve: (val: Record<string, unknown>) => void;
      readonly reject: (err: Error) => void;
    }
  >();

  const rl = child.stdout ? NodeReadline.createInterface({ input: child.stdout }) : null;
  rl?.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (typeof msg.id === "number") {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });

  const killChild = () => {
    if (closed) return;
    closed = true;
    rl?.close();
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(`Plugin "${pluginId}" process closed.`));
      pending.delete(id);
    }
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "shutdown", params: {} })}\n`,
        );
        child.stdin.end();
      }
    } catch {
      // Ignore write error during teardown.
    }
    const pid = child.pid;
    if (pid !== undefined) {
      if (platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // Already gone.
          }
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }, 1_500);
        timer.unref();
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited.
        }
      }
    }
  };

  child.on("exit", () => {
    closed = true;
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(`Plugin "${pluginId}" exited unexpectedly.`));
      pending.delete(id);
    }
  });

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (closed || !child.stdin || child.stdin.destroyed) {
        reject(new Error(`Plugin "${pluginId}" is not running.`));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Plugin "${pluginId}" timed out on ${method}.`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  let initMsg: Record<string, unknown>;
  try {
    initMsg = await request("initialize", {}, 5_000);
  } catch (error) {
    killChild();
    throw error;
  }

  const initResult =
    initMsg.result !== null && typeof initMsg.result === "object"
      ? (initMsg.result as Record<string, unknown>)
      : {};
  const descriptor =
    initResult.plugin !== null && typeof initResult.plugin === "object"
      ? (initResult.plugin as Record<string, unknown>)
      : {};

  const rawTools = Array.isArray(descriptor.tools) ? descriptor.tools : [];
  const tools: Array<PluginSdkExposedTool> = [];
  for (const raw of rawTools) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name.trim()) continue;
    const inputSchema =
      rec.inputSchema !== null &&
      typeof rec.inputSchema === "object" &&
      !Array.isArray(rec.inputSchema)
        ? (rec.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    tools.push({
      pluginId,
      exposedName: canonicalPluginToolName(pluginId, rec.name.trim()),
      name: rec.name.trim(),
      description: typeof rec.description === "string" ? rec.description : "",
      inputSchema,
      readOnly: rec.readOnly === true,
    });
  }

  const rawModes = Array.isArray(descriptor.modes) ? descriptor.modes : [];
  const modes: Array<HarnessModeEntry> = [];
  for (const raw of rawModes) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const decodedModeId = decodeModeId(typeof rec.id === "string" ? rec.id.trim() : "");
    if (decodedModeId._tag === "None") continue;
    const body = typeof rec.body === "string" ? rec.body : "";
    modes.push({
      id: decodedModeId.value,
      name: TrimmedNonEmptyString.make(
        typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : decodedModeId.value,
      ),
      ...(typeof rec.description === "string" && rec.description.trim()
        ? { description: rec.description.trim() }
        : {}),
      scope: "user",
      baseInteractionMode: rec.baseInteractionMode === "plan" ? "plan" : "default",
      readonly: rec.readonly === true,
      proposePlan: rec.proposePlan === true,
      body,
      sourcePath: `${entrypointAbs}#mode:${decodedModeId.value}`,
      contentDigest: sha256Hex(body),
      bytes: NonNegativeInt.make(Buffer.byteLength(body, "utf8")),
      enabled: true,
      effectiveEnabled: true,
      overriddenByProject: false,
    });
  }

  return {
    tools,
    modes,
    callTool: async (callInput) => {
      const msg = await request(
        "tools/call",
        {
          name: callInput.name,
          arguments: callInput.arguments,
          ...(callInput.workspaceRoot ? { workspaceRoot: callInput.workspaceRoot } : {}),
          ...(callInput.threadId ? { threadId: callInput.threadId } : {}),
        },
        30_000,
      );
      if (msg.error !== undefined && typeof msg.error === "object" && msg.error !== null) {
        const errMessage = Reflect.get(msg.error, "message");
        return {
          isError: true,
          content: [
            { type: "text", text: typeof errMessage === "string" ? errMessage : "SDK tool error." },
          ],
        };
      }
      const res =
        msg.result !== null && typeof msg.result === "object"
          ? (msg.result as Record<string, unknown>)
          : {};
      const content = Array.isArray(res.content)
        ? res.content.filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object" && !Array.isArray(item),
          )
        : [{ type: "text", text: "" }];
      return {
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
        ...(res.structuredContent !== undefined
          ? { structuredContent: res.structuredContent }
          : {}),
        ...(res.isError === true ? { isError: true } : {}),
      };
    },
    close: killChild,
  };
}

export interface PluginActiveContribution {
  readonly pluginId: HarnessPluginId;
  readonly skills: ReadonlyArray<HarnessSkillEntry>;
  readonly rules: ReadonlyArray<HarnessRuleEntry>;
  readonly commands: ReadonlyArray<HarnessCommandEntry>;
  readonly modes: ReadonlyArray<HarnessModeEntry>;
  readonly hooks: ReadonlyArray<HarnessHookDefinition>;
}

interface ParsedPluginBundle {
  readonly id: HarnessPluginId;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly author?: string | undefined;
  readonly format: HarnessPluginFormat;
  readonly sourcePath: string;
  readonly contentDigest: string;
  readonly entrypoint?: string | undefined;
  readonly hasCommandHooks: boolean;
  readonly hasStdioMcp: boolean;
  readonly skills: ReadonlyArray<HarnessSkillEntry>;
  readonly rules: ReadonlyArray<HarnessRuleEntry>;
  readonly commands: ReadonlyArray<HarnessCommandEntry>;
  readonly modes: ReadonlyArray<HarnessModeEntry>;
  readonly hooks: ReadonlyArray<HarnessHookDefinition>;
  readonly mcpServerIds: ReadonlyArray<string>;
  readonly workflowFiles: ReadonlyArray<string>;
}

async function parsePluginDirectory(
  pluginDir: string,
  fallbackId: string,
): Promise<ParsedPluginBundle> {
  const files = await walkContainedFiles(pluginDir);
  const fileByRel = new Map(files.map((f) => [f.relPath, f]));

  const hasher = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hasher.update(file.relPath, "utf8");
    hasher.update("\0", "utf8");
    hasher.update(file.content);
    hasher.update("\0", "utf8");
  }
  const contentDigest = hasher.digest("hex");

  const t3ManifestFile = fileByRel.get("t3-plugin.json");
  const claudeManifestFile = fileByRel.get(".claude-plugin/plugin.json");
  const manifestFile = t3ManifestFile ?? claudeManifestFile;
  if (!manifestFile) {
    throw new Error(
      `Directory "${pluginDir}" is missing t3-plugin.json or .claude-plugin/plugin.json.`,
    );
  }
  const format: HarnessPluginFormat = t3ManifestFile ? "t3-plugin" : "claude-plugin";
  const manifest = tryParseJsonObject(manifestFile.content.toString("utf8"));
  if (!manifest) {
    throw new Error(`Plugin manifest "${manifestFile.relPath}" is not valid JSON.`);
  }

  const rawId =
    typeof manifest.id === "string" && manifest.id.trim() ? manifest.id.trim() : fallbackId;
  const decodedId = decodePluginId(rawId);
  if (decodedId._tag === "None") {
    throw new Error(`Invalid plugin id "${rawId}".`);
  }
  const pluginId = decodedId.value;
  const name =
    typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : pluginId;
  const version =
    typeof manifest.version === "string" && manifest.version.trim().length > 0
      ? manifest.version.trim()
      : "0.1.0";
  const description =
    typeof manifest.description === "string" && manifest.description.trim().length > 0
      ? manifest.description.trim()
      : undefined;
  const author =
    typeof manifest.author === "string" && manifest.author.trim().length > 0
      ? manifest.author.trim()
      : undefined;

  let entrypoint: string | undefined;
  if (typeof manifest.entrypoint === "string" && manifest.entrypoint.trim().length > 0) {
    const normalized = manifest.entrypoint.trim().replace(/^\.\//u, "").replace(/^\/+/u, "");
    if (!fileByRel.has(normalized)) {
      throw new Error(
        `Plugin entrypoint "${manifest.entrypoint}" does not exist inside the plugin directory.`,
      );
    }
    entrypoint = normalized;
  }

  const skillsPrefix =
    typeof manifest.skillsDir === "string"
      ? manifest.skillsDir.replace(/^\/+|\/+$/g, "")
      : "skills";
  const rulesPrefix =
    typeof manifest.rulesDir === "string" ? manifest.rulesDir.replace(/^\/+|\/+$/g, "") : "rules";
  const commandsPrefix =
    typeof manifest.commandsDir === "string"
      ? manifest.commandsDir.replace(/^\/+|\/+$/g, "")
      : "commands";
  const modesPrefix =
    typeof manifest.modesDir === "string" ? manifest.modesDir.replace(/^\/+|\/+$/g, "") : "modes";
  const workflowsPrefix =
    typeof manifest.workflowsDir === "string"
      ? manifest.workflowsDir.replace(/^\/+|\/+$/g, "")
      : "workflows";

  const skills: Array<HarnessSkillEntry> = [];
  const rules: Array<HarnessRuleEntry> = [];
  const commands: Array<HarnessCommandEntry> = [];
  const modes: Array<HarnessModeEntry> = [];
  const workflowFiles: Array<string> = [];

  for (const file of files) {
    if (file.relPath.startsWith(`${skillsPrefix}/`) && file.relPath.endsWith("/SKILL.md")) {
      const segs = file.relPath.slice(skillsPrefix.length + 1).split("/");
      const rawSkillId = segs[0] ?? "";
      const idOpt = decodeSkillId(rawSkillId);
      if (idOpt._tag === "Some") {
        const text = file.content.toString("utf8");
        const { frontmatter, body } = parseFrontmatter(text);
        const skillName =
          typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
            ? frontmatter.name.trim()
            : idOpt.value;
        skills.push({
          id: idOpt.value,
          name: TrimmedNonEmptyString.make(skillName),
          ...(typeof frontmatter.description === "string" && frontmatter.description.trim()
            ? { description: frontmatter.description.trim() }
            : {}),
          scope: "user",
          sourcePath: file.fullPath,
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          userInvocable: frontmatter.userInvocable !== false,
          userInvocationOnly: frontmatter.userInvocationOnly === true,
          body,
          bytes: NonNegativeInt.make(Buffer.byteLength(body, "utf8")),
          contentDigest: sha256Hex(text),
        });
      }
    } else if (file.relPath.startsWith(`${rulesPrefix}/`) && file.relPath.endsWith(".md")) {
      const base = NodePath.basename(file.relPath, ".md");
      const idOpt = decodeRuleId(base);
      if (idOpt._tag === "Some") {
        const text = file.content.toString("utf8");
        const { frontmatter, body } = parseFrontmatter(text);
        const rawApply = frontmatter.apply;
        const apply: HarnessRuleApplyMode =
          rawApply === "glob" || rawApply === "manual" ? rawApply : "always";
        rules.push({
          id: idOpt.value,
          ...(typeof frontmatter.description === "string" && frontmatter.description.trim()
            ? { description: frontmatter.description.trim() }
            : {}),
          apply,
          globs: parseStringArray(frontmatter.globs),
          scope: "user",
          sourcePath: file.fullPath,
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          body,
          bytes: NonNegativeInt.make(Buffer.byteLength(body, "utf8")),
          contentDigest: sha256Hex(text),
        });
      }
    } else if (file.relPath.startsWith(`${commandsPrefix}/`) && file.relPath.endsWith(".md")) {
      const base = NodePath.basename(file.relPath, ".md");
      const idOpt = decodeCommandId(base);
      if (idOpt._tag === "Some") {
        const text = file.content.toString("utf8");
        const { frontmatter, body } = parseFrontmatter(text);
        commands.push({
          id: idOpt.value,
          name: TrimmedNonEmptyString.make(idOpt.value),
          ...(typeof frontmatter.description === "string" && frontmatter.description.trim()
            ? { description: frontmatter.description.trim() }
            : {}),
          ...(typeof frontmatter.argumentHint === "string" && frontmatter.argumentHint.trim()
            ? { argumentHint: frontmatter.argumentHint.trim() }
            : {}),
          scope: "user",
          sourcePath: file.fullPath,
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          body,
          bytes: NonNegativeInt.make(Buffer.byteLength(body, "utf8")),
          contentDigest: sha256Hex(text),
        });
      }
    } else if (file.relPath.startsWith(`${modesPrefix}/`) && file.relPath.endsWith(".md")) {
      const base = NodePath.basename(file.relPath, ".md");
      const idOpt = decodeModeId(base);
      if (idOpt._tag === "Some") {
        const text = file.content.toString("utf8");
        const { frontmatter, body } = parseFrontmatter(text);
        const baseInteractionMode = frontmatter.baseInteractionMode === "plan" ? "plan" : "default";
        const modeName =
          typeof frontmatter.name === "string" && frontmatter.name.trim()
            ? frontmatter.name.trim()
            : idOpt.value;
        const includedRules = parseStringArray(frontmatter.includedRules).flatMap((r) => {
          const decoded = decodeRuleId(r);
          return decoded._tag === "Some" ? [decoded.value] : [];
        });
        const includedSkills = parseStringArray(frontmatter.includedSkills).flatMap((s) => {
          const decoded = decodeSkillId(s);
          return decoded._tag === "Some" ? [decoded.value] : [];
        });
        modes.push({
          id: idOpt.value,
          name: TrimmedNonEmptyString.make(modeName),
          ...(typeof frontmatter.description === "string" && frontmatter.description.trim()
            ? { description: frontmatter.description.trim() }
            : {}),
          baseInteractionMode,
          readonly: frontmatter.readonly === true,
          proposePlan: frontmatter.proposePlan === true,
          ...(includedRules.length > 0 ? { includedRules } : {}),
          ...(includedSkills.length > 0 ? { includedSkills } : {}),
          scope: "user",
          sourcePath: file.fullPath,
          enabled: true,
          effectiveEnabled: true,
          overriddenByProject: false,
          body,
          bytes: NonNegativeInt.make(Buffer.byteLength(body, "utf8")),
          contentDigest: sha256Hex(text),
        });
      }
    } else if (
      file.relPath.startsWith(`${workflowsPrefix}/`) &&
      (file.relPath.endsWith(".yaml") || file.relPath.endsWith(".yml"))
    ) {
      workflowFiles.push(file.relPath);
    }
  }

  // Parse declared hooks from manifest (t3-plugin.json `hooks` array or `.claude-plugin` hooks).
  const hooks: Array<HarnessHookDefinition> = [];
  if (Array.isArray(manifest.hooks)) {
    for (let index = 0; index < manifest.hooks.length; index += 1) {
      const rawHook = manifest.hooks[index];
      if (rawHook === null || typeof rawHook !== "object" || Array.isArray(rawHook)) continue;
      const obj = rawHook as Record<string, unknown>;
      const rawHookId =
        typeof obj.id === "string" && obj.id.trim().length > 0
          ? `${pluginId}.${obj.id.trim()}`
          : `${pluginId}.hook-${index + 1}`;
      const hookIdOpt = decodeHookId(rawHookId.slice(0, 64));
      const eventOpt = decodeHookEvent(obj.event);
      const targetOpt = decodeHookTarget(obj.target);
      if (hookIdOpt._tag === "Some" && eventOpt._tag === "Some" && targetOpt._tag === "Some") {
        hooks.push({
          id: hookIdOpt.value,
          event: eventOpt.value,
          enabled: obj.enabled !== false,
          ...(typeof obj.matcher === "string" && obj.matcher.trim()
            ? { matcher: TrimmedNonEmptyString.make(obj.matcher.trim()) }
            : {}),
          ...(typeof obj.timeoutMs === "number" &&
          Number.isInteger(obj.timeoutMs) &&
          obj.timeoutMs > 0
            ? { timeoutMs: PositiveInt.make(obj.timeoutMs) }
            : {}),
          ...(typeof obj.failClosed === "boolean" ? { failClosed: obj.failClosed } : {}),
          target: targetOpt.value,
          ...(typeof obj.description === "string" && obj.description.trim()
            ? { description: obj.description.trim() }
            : {}),
          source: "plugin",
          pluginId,
        });
      }
    }
  }

  const mcpServerIds: Array<string> = [];
  let hasStdioMcp = false;
  if (
    manifest.mcpServers !== null &&
    typeof manifest.mcpServers === "object" &&
    !Array.isArray(manifest.mcpServers)
  ) {
    for (const [serverId, cfg] of Object.entries(manifest.mcpServers as Record<string, unknown>)) {
      mcpServerIds.push(serverId);
      if (cfg !== null && typeof cfg === "object") {
        const transport = Reflect.get(cfg, "transport");
        const command = Reflect.get(cfg, "command");
        if (
          typeof command === "string" ||
          (transport !== null &&
            typeof transport === "object" &&
            Reflect.get(transport, "type") === "stdio")
        ) {
          hasStdioMcp = true;
        }
      }
    }
  }

  return {
    id: pluginId,
    name,
    version,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    format,
    sourcePath: pluginDir,
    contentDigest,
    ...(entrypoint ? { entrypoint } : {}),
    hasCommandHooks: hooks.some((hook) => hook.target.type === "command"),
    hasStdioMcp,
    skills,
    rules,
    commands,
    modes,
    hooks,
    mcpServerIds,
    workflowFiles,
  };
}

export interface PluginPackInput {
  readonly id: HarnessPluginId;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly author?: string | undefined;
}

export interface PluginPackResult {
  readonly id: HarnessPluginId;
  readonly pluginDir: string;
  readonly manifestPath: string;
  readonly contentDigest: string;
  readonly fileCount: number;
}

export interface PluginHostShape {
  readonly list: () => Effect.Effect<HarnessPluginsSnapshot, HarnessError>;
  readonly install: (
    input: HarnessPluginInstallInput,
  ) => Effect.Effect<HarnessPluginsSnapshot, HarnessError>;
  readonly trust: (
    input: HarnessPluginTrustInput,
  ) => Effect.Effect<HarnessPluginsSnapshot, HarnessError>;
  readonly setEnabled: (
    input: HarnessPluginSetEnabledInput,
  ) => Effect.Effect<HarnessPluginsSnapshot, HarnessError>;
  readonly remove: (
    input: HarnessPluginRemoveInput,
  ) => Effect.Effect<HarnessPluginsSnapshot, HarnessError>;
  readonly reload: (
    input?: HarnessPluginReloadInput,
  ) => Effect.Effect<HarnessPluginsSnapshot, HarnessError>;
  readonly packPlugin: (input: PluginPackInput) => Effect.Effect<PluginPackResult, HarnessError>;
  /** Returns merged contributions from all currently active (trusted + enabled) plugins. */
  readonly getActiveContributions: () => ReadonlyArray<PluginActiveContribution>;
  /** Returns tools declared by active out-of-process `@t3tools/plugin-sdk` plugins. */
  readonly listActiveSdkTools: () => ReadonlyArray<PluginSdkExposedTool>;
  readonly callActiveSdkTool: (input: {
    readonly exposedName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly workspaceRoot?: string | undefined;
    readonly threadId?: string | undefined;
  }) => Effect.Effect<PluginSdkToolCallResult, HarnessError>;
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()(
  "t3/harness/PluginHost",
) {}

export const layer = Layer.effect(
  PluginHost,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const store = yield* HarnessStore.HarnessStore;
    const hooksService = yield* HarnessHooksService.HarnessHooksService;

    const activeScopes = new Map<HarnessPluginId, Scope.Closeable>();
    const activeContributions = new Map<HarnessPluginId, PluginActiveContribution>();
    const activeSdkRuntimes = new Map<HarnessPluginId, OutOfProcessSdkRuntime>();
    const activationErrors = new Map<HarnessPluginId, string>();

    // Ensure every active plugin Scope is closed cleanly when the PluginHost layer shuts down.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(activeScopes.entries()),
        ([pluginId, pluginScope]) =>
          Scope.close(pluginScope, Exit.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                activeScopes.delete(pluginId);
                activeContributions.delete(pluginId);
                activeSdkRuntimes.delete(pluginId);
              }),
            ),
          ),
        { discard: true },
      ),
    );

    const pluginsDir = () => path.join(store.harnessDir, PLUGINS_DIR_NAME);
    const stateFilePath = () => path.join(store.harnessDir, PLUGINS_STATE_FILE);

    const readPolicy = Effect.fn("PluginHost.readPolicy")(function* () {
      const resolved = yield* store.resolveWorkspace();
      return {
        allowsHarness: resolved.managedPolicyAllowsHarness,
        allowsStdio: resolved.managedPolicyAllowsStdio,
        organization: resolved.managedPolicyOrganization,
      };
    });

    const readState = Effect.fn("PluginHost.readState")(function* () {
      const file = stateFilePath();
      const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return DEFAULT_PERSISTED_STATE;
      const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const obj = tryParseJsonObject(raw);
      if (!obj) return DEFAULT_PERSISTED_STATE;
      const trustedDigests: Record<string, string> = {};
      if (obj.trustedDigests && typeof obj.trustedDigests === "object") {
        for (const [k, v] of Object.entries(obj.trustedDigests as Record<string, unknown>)) {
          if (typeof v === "string") trustedDigests[k] = v;
        }
      }
      const enabled: Record<string, boolean> = {};
      if (obj.enabled && typeof obj.enabled === "object") {
        for (const [k, v] of Object.entries(obj.enabled as Record<string, unknown>)) {
          if (typeof v === "boolean") enabled[k] = v;
        }
      }
      return { version: 1, trustedDigests, enabled } satisfies PluginsPersistedState;
    });

    const writeState = Effect.fn("PluginHost.writeState")(function* (state: PluginsPersistedState) {
      const dir = store.harnessDir;
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(
        Effect.mapError(
          (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to create harness directory: ${error.message}`,
            }),
        ),
      );
      const target = stateFilePath();
      const tmp = `${target}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
      yield* fs.writeFileString(tmp, encodePrettyJson(state)).pipe(
        Effect.andThen(fs.rename(tmp, target)),
        Effect.mapError(
          (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to write plugins-state.json: ${error.message}`,
            }),
        ),
      );
    });

    const deactivatePlugin = Effect.fn("PluginHost.deactivatePlugin")(function* (
      pluginId: HarnessPluginId,
    ) {
      const existingScope = activeScopes.get(pluginId);
      if (existingScope) {
        activeScopes.delete(pluginId);
        yield* Scope.close(existingScope, Exit.void);
      }
      activeContributions.delete(pluginId);
      activeSdkRuntimes.delete(pluginId);
      activationErrors.delete(pluginId);
    });

    const activatePlugin = Effect.fn("PluginHost.activatePlugin")(function* (
      bundle: ParsedPluginBundle,
    ) {
      yield* deactivatePlugin(bundle.id);
      const pluginScope = yield* Scope.make();
      const activationResult = yield* Effect.gen(function* () {
        let sdkModes: ReadonlyArray<HarnessModeEntry> = [];
        if (bundle.entrypoint) {
          const runtime = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                spawnOutOfProcessSdkPlugin(
                  bundle.id,
                  bundle.sourcePath,
                  bundle.entrypoint!,
                  platform,
                ),
              catch: (error) =>
                new HarnessError({
                  code: "upstream_error",
                  detail: `Failed to start plugin "${bundle.id}" entrypoint "${bundle.entrypoint}": ${error instanceof Error ? error.message : String(error)}`,
                }),
            }),
            (rt) =>
              Effect.sync(() => {
                activeSdkRuntimes.delete(bundle.id);
                rt.close();
              }),
          );
          activeSdkRuntimes.set(bundle.id, runtime);
          sdkModes = runtime.modes;
        }
        const contribution: PluginActiveContribution = {
          pluginId: bundle.id,
          skills: bundle.skills,
          rules: bundle.rules,
          commands: bundle.commands,
          modes: [...bundle.modes, ...sdkModes],
          hooks: bundle.hooks,
        };
        yield* hooksService.registerPluginHooks(bundle.id, bundle.hooks);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            activeContributions.set(bundle.id, contribution);
          }),
          () =>
            Effect.sync(() => {
              activeContributions.delete(bundle.id);
            }),
        );
      }).pipe(Scope.provide(pluginScope), Effect.result);

      if (Result.isFailure(activationResult)) {
        yield* Scope.close(pluginScope, Exit.void);
        activationErrors.set(bundle.id, activationResult.failure.detail);
        return;
      }
      activationErrors.delete(bundle.id);
      activeScopes.set(bundle.id, pluginScope);
    });

    const reconcileAndSnapshot = Effect.fn("PluginHost.reconcileAndSnapshot")(function* (
      forceReloadId?: HarnessPluginId,
    ) {
      const policy = yield* readPolicy();
      const root = pluginsDir();
      const state = yield* readState();
      const dirExists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
      const discovered = new Map<
        HarnessPluginId,
        { readonly bundle?: ParsedPluginBundle; readonly error?: string; readonly dirPath: string }
      >();

      if (dirExists) {
        const entries = yield* Effect.promise(() =>
          NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []),
        );
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dirPath = NodePath.join(root, entry.name);
          const parsed = yield* Effect.tryPromise({
            try: () => parsePluginDirectory(dirPath, entry.name),
            catch: (error) => (error instanceof Error ? error.message : String(error)),
          }).pipe(Effect.result);

          if (Result.isSuccess(parsed)) {
            discovered.set(parsed.success.id, { bundle: parsed.success, dirPath });
          } else {
            const fallback = decodePluginId(entry.name);
            if (fallback._tag === "Some") {
              discovered.set(fallback.value, { error: parsed.failure, dirPath });
            }
          }
        }
      }

      // Close scopes for any plugin that disappeared from disk.
      for (const activeId of Array.from(activeScopes.keys())) {
        if (!discovered.has(activeId)) {
          yield* deactivatePlugin(activeId);
        }
      }

      const views: Array<HarnessPluginView> = [];
      for (const [pluginId, entry] of Array.from(discovered.entries()).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const trustedDigest = state.trustedDigests[pluginId] ?? null;
        const enabled = state.enabled[pluginId] ?? false;

        if (!entry.bundle) {
          yield* deactivatePlugin(pluginId);
          views.push({
            id: pluginId,
            name: pluginId,
            version: "0.0.0",
            format: "t3-plugin",
            sourcePath: entry.dirPath,
            contentDigest: "",
            trustedDigest,
            trustStatus: "untrusted",
            enabled,
            active: false,
            hasCommandHooks: false,
            hasStdioMcp: false,
            skillIds: [],
            ruleIds: [],
            commandIds: [],
            modeIds: [],
            hookIds: [],
            mcpServerIds: [],
            workflowFiles: [],
            lastError: entry.error ?? "Invalid plugin directory.",
          });
          continue;
        }

        const bundle = entry.bundle;
        const trustStatus: HarnessPluginTrustStatus =
          trustedDigest === null
            ? "untrusted"
            : trustedDigest === bundle.contentDigest
              ? "trusted"
              : "digest_changed";

        const shouldBeActive =
          policy.allowsHarness &&
          enabled &&
          trustStatus === "trusted" &&
          (!bundle.hasCommandHooks || policy.allowsStdio) &&
          (!bundle.hasStdioMcp || policy.allowsStdio) &&
          (!bundle.entrypoint || policy.allowsStdio);

        if (shouldBeActive) {
          const alreadyActive = activeScopes.has(pluginId);
          if (!alreadyActive || forceReloadId === pluginId || forceReloadId === undefined) {
            yield* activatePlugin(bundle);
          }
        } else {
          yield* deactivatePlugin(pluginId);
        }

        const sdkRuntime = activeSdkRuntimes.get(pluginId);
        const activeModeIds = Array.from(
          new Set([
            ...bundle.modes.map((m) => m.id),
            ...(sdkRuntime ? sdkRuntime.modes.map((m) => m.id) : []),
          ]),
        );

        views.push({
          id: bundle.id,
          name: bundle.name,
          version: bundle.version,
          ...(bundle.description ? { description: bundle.description } : {}),
          ...(bundle.author ? { author: bundle.author } : {}),
          format: bundle.format,
          sourcePath: bundle.sourcePath,
          contentDigest: bundle.contentDigest,
          trustedDigest,
          trustStatus,
          enabled,
          active: activeScopes.has(pluginId),
          hasCommandHooks: bundle.hasCommandHooks,
          hasStdioMcp: bundle.hasStdioMcp,
          skillIds: bundle.skills.map((s) => s.id),
          ruleIds: bundle.rules.map((r) => r.id),
          commandIds: bundle.commands.map((c) => c.id),
          modeIds: activeModeIds,
          hookIds: bundle.hooks.map((h) => h.id),
          mcpServerIds: bundle.mcpServerIds,
          workflowFiles: bundle.workflowFiles,
          ...(bundle.entrypoint ? { entrypoint: bundle.entrypoint } : {}),
          ...(sdkRuntime ? { toolNames: sdkRuntime.tools.map((t) => t.exposedName) } : {}),
          lastError: activationErrors.get(pluginId) ?? null,
        });
      }

      return {
        pluginsDir: root,
        plugins: views,
        managedPolicyAllowsHarness: policy.allowsHarness,
        managedPolicyOrganization: policy.organization,
      } satisfies HarnessPluginsSnapshot;
    });

    // Initial reconciliation on startup (activates already-trusted + enabled plugins).
    yield* reconcileAndSnapshot();

    return PluginHost.of({
      list: Effect.fn("PluginHost.list")(function* () {
        return yield* reconcileAndSnapshot();
      }),

      install: Effect.fn("PluginHost.install")(function* (input) {
        const policy = yield* readPolicy();
        if (!policy.allowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness plugins are disabled by managed policy.",
          });
        }
        const sourceDir = NodePath.resolve(input.sourcePath);
        const fallbackId = input.id ?? NodePath.basename(sourceDir);
        const parsed = yield* Effect.tryPromise({
          try: () => parsePluginDirectory(sourceDir, fallbackId),
          catch: (error) =>
            new HarnessError({
              code: "invalid_config",
              detail: error instanceof Error ? error.message : String(error),
            }),
        });
        const targetId = input.id ?? parsed.id;
        const destDir = NodePath.join(pluginsDir(), targetId);
        yield* Effect.tryPromise({
          try: () => copyContainedDirectory(sourceDir, destDir),
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to copy plugin into ${destDir}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const state = yield* readState();
        const nextTrusted = { ...state.trustedDigests };
        const nextEnabled = { ...state.enabled };
        if (input.trustOnInstall === true) {
          nextTrusted[targetId] = parsed.contentDigest;
          nextEnabled[targetId] = true;
        } else {
          delete nextTrusted[targetId];
          nextEnabled[targetId] = false;
        }
        yield* writeState({ version: 1, trustedDigests: nextTrusted, enabled: nextEnabled });
        return yield* reconcileAndSnapshot(targetId);
      }),

      trust: Effect.fn("PluginHost.trust")(function* (input) {
        const policy = yield* readPolicy();
        if (!policy.allowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness plugins are disabled by managed policy.",
          });
        }
        const dirPath = NodePath.join(pluginsDir(), input.id);
        const parsed = yield* Effect.tryPromise({
          try: () => parsePluginDirectory(dirPath, input.id),
          catch: (error) =>
            new HarnessError({
              code: "not_found",
              detail: error instanceof Error ? error.message : String(error),
            }),
        });
        if (parsed.contentDigest !== input.expectedDigest) {
          return yield* new HarnessError({
            code: "untrusted",
            detail: `Plugin "${input.id}" digest changed on disk (expected ${input.expectedDigest.slice(0, 12)}, found ${parsed.contentDigest.slice(0, 12)}). Review again before trusting.`,
          });
        }
        const state = yield* readState();
        yield* writeState({
          version: 1,
          trustedDigests: { ...state.trustedDigests, [input.id]: parsed.contentDigest },
          enabled: { ...state.enabled, [input.id]: true },
        });
        return yield* reconcileAndSnapshot(input.id);
      }),

      setEnabled: Effect.fn("PluginHost.setEnabled")(function* (input) {
        const state = yield* readState();
        yield* writeState({
          version: 1,
          trustedDigests: state.trustedDigests,
          enabled: { ...state.enabled, [input.id]: input.enabled },
        });
        return yield* reconcileAndSnapshot(input.id);
      }),

      remove: Effect.fn("PluginHost.remove")(function* (input) {
        yield* deactivatePlugin(input.id);
        const dirPath = NodePath.join(pluginsDir(), input.id);
        yield* Effect.tryPromise({
          try: () => NodeFSP.rm(dirPath, { recursive: true, force: true }),
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to remove plugin directory: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        const state = yield* readState();
        const nextTrusted = { ...state.trustedDigests };
        const nextEnabled = { ...state.enabled };
        delete nextTrusted[input.id];
        delete nextEnabled[input.id];
        yield* writeState({ version: 1, trustedDigests: nextTrusted, enabled: nextEnabled });
        return yield* reconcileAndSnapshot();
      }),

      reload: Effect.fn("PluginHost.reload")(function* (input) {
        return yield* reconcileAndSnapshot(input?.id);
      }),

      packPlugin: Effect.fn("PluginHost.packPlugin")(function* (input) {
        const policy = yield* readPolicy();
        if (!policy.allowsHarness) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness plugins are disabled by managed policy.",
          });
        }
        const root = pluginsDir();
        const pluginDir = NodePath.join(root, input.id);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(pluginDir, { recursive: true });
            const manifestPath = NodePath.join(pluginDir, "t3-plugin.json");
            const existingRaw = await NodeFSP.readFile(manifestPath, "utf8").catch(() => null);
            const existingObj = existingRaw ? tryParseJsonObject(existingRaw) : null;
            const nextManifest = {
              ...existingObj,
              id: input.id,
              name: input.name,
              version: input.version,
              ...(input.description ? { description: input.description } : {}),
              ...(input.author ? { author: input.author } : {}),
            };
            await NodeFSP.writeFile(manifestPath, encodePrettyJson(nextManifest), "utf8");
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to pack plugin "${input.id}": ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        const files = yield* Effect.tryPromise({
          try: () => walkContainedFiles(pluginDir),
          catch: (error) =>
            new HarnessError({
              code: "invalid_config",
              detail: error instanceof Error ? error.message : String(error),
            }),
        });
        const parsed = yield* Effect.tryPromise({
          try: () => parsePluginDirectory(pluginDir, input.id),
          catch: (error) =>
            new HarnessError({
              code: "invalid_config",
              detail: error instanceof Error ? error.message : String(error),
            }),
        });
        // Reconcile without trusting — owner must explicitly review and trust the packed plugin.
        yield* reconcileAndSnapshot(input.id);
        return {
          id: input.id,
          pluginDir,
          manifestPath: NodePath.join(pluginDir, "t3-plugin.json"),
          contentDigest: parsed.contentDigest,
          fileCount: files.length,
        } satisfies PluginPackResult;
      }),

      getActiveContributions: () => Array.from(activeContributions.values()),
      listActiveSdkTools: () =>
        Array.from(activeSdkRuntimes.values()).flatMap((runtime) => runtime.tools),
      callActiveSdkTool: Effect.fn("PluginHost.callActiveSdkTool")(function* (input) {
        for (const runtime of activeSdkRuntimes.values()) {
          const tool = runtime.tools.find(
            (candidate) => candidate.exposedName === input.exposedName,
          );
          if (!tool) continue;
          return yield* Effect.tryPromise({
            try: () =>
              runtime.callTool({
                name: tool.name,
                arguments: input.arguments,
                workspaceRoot: input.workspaceRoot,
                threadId: input.threadId,
              }),
            catch: (error) =>
              new HarnessError({
                code: "upstream_error",
                detail: `Plugin tool "${input.exposedName}" failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
          });
        }
        return yield* new HarnessError({
          code: "not_found",
          detail: `Plugin SDK tool "${input.exposedName}" is not active.`,
        });
      }),
    });
  }),
);
