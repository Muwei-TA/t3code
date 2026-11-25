import {
  type HarnessCommandEntry,
  type HarnessLibrarySnapshot,
  type HarnessModeEntry,
  type HarnessSkillEntry,
  NonNegativeInt,
  type OrchestrationV2HarnessCapabilities,
  type ThreadContextDegradedItem,
  type ThreadContextRuleItem,
  type ThreadContextSkillItem,
} from "@t3tools/contracts";
import { T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { isReservedHarnessCommandId } from "@t3tools/contracts";

const textEncoder = new TextEncoder();
const utf8Bytes = (text: string): number => textEncoder.encode(text).length;

/**
 * Pure glob matcher supporting `*`, `**`, `?`, and `{a,b}` alternatives for conditional `rules/*.md`.
 */
export function matchesRuleGlob(pattern: string, candidatePath: string): boolean {
  const normalizedPattern = pattern.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const normalizedPath = candidatePath.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalizedPattern.length === 0 || normalizedPath.length === 0) return false;

  const variants = expandBraces(normalizedPattern);
  for (const variant of variants) {
    const regex = globToRegExp(variant);
    if (regex.test(normalizedPath)) return true;
    // Also match basename when pattern has no slash (e.g. `*.tsx`).
    if (!variant.includes("/")) {
      const base = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
      if (regex.test(base)) return true;
    }
  }
  return false;
}

function expandBraces(pattern: string): ReadonlyArray<string> {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close === -1) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const options = pattern.slice(open + 1, close).split(",");
  const results: Array<string> = [];
  for (const option of options) {
    for (const expanded of expandBraces(`${prefix}${option}${suffix}`)) {
      results.push(expanded);
    }
  }
  return results;
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (/[.+^$()|[\]\\]/u.test(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  out += "$";
  return new RegExp(out, "u");
}

function tokenizeArguments(rawArgs: string): ReadonlyArray<string> {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) return [];
  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  return matches.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

export interface ExpandedPortableCommand {
  readonly expanded: boolean;
  readonly commandId?: string | undefined;
  readonly text: string;
}

/**
 * Expands leading `/<commandId> [arguments]` using enabled portable commands on the server so
 * Web, Mobile, MCP `t3_thread_send`, and Scheduled Tasks all share identical behavior.
 */
export function expandPortableCommand(input: {
  readonly text: string;
  readonly commands: ReadonlyArray<Pick<HarnessCommandEntry, "id" | "effectiveEnabled" | "body">>;
}): ExpandedPortableCommand {
  const trimmedStart = input.text.trimStart();
  if (!trimmedStart.startsWith("/")) {
    return { expanded: false, text: input.text };
  }
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?:[ \t]+([\s\S]*)|(?:\r?\n([\s\S]*))|$)/u.exec(
    trimmedStart,
  );
  if (!match) {
    return { expanded: false, text: input.text };
  }
  const rawName = match[1]!;
  if (isReservedHarnessCommandId(rawName)) {
    return { expanded: false, text: input.text };
  }
  const command = input.commands.find(
    (entry) => entry.effectiveEnabled && entry.id.toLowerCase() === rawName.toLowerCase(),
  );
  if (!command) {
    return { expanded: false, text: input.text };
  }
  const rawArgs = (match[2] ?? match[3] ?? "").trim();
  const positional = tokenizeArguments(rawArgs);
  const template = command.body.trim();
  const hadPlaceholder = /\$ARGUMENTS\b|\$[1-9]\b/u.test(template);
  let rendered = template
    .replaceAll(/\$ARGUMENTS\b/gu, rawArgs)
    .replaceAll(/\$([1-9])\b/gu, (_m, idxText: string) => positional[Number(idxText) - 1] ?? "");

  if (!hadPlaceholder && rawArgs.length > 0) {
    rendered = `${rendered}\n\n${rawArgs}`;
  }
  return {
    expanded: true,
    commandId: command.id,
    text: rendered.trim(),
  };
}

/** Extracts file-like path mentions from user text and attachments for `apply: "glob"` rules. */
export function extractReferencedPaths(input: {
  readonly promptText?: string | undefined;
  readonly attachmentPaths?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const item of input.attachmentPaths ?? []) {
    const cleaned = item.trim().replaceAll("\\", "/");
    if (cleaned.length > 0) paths.add(cleaned);
  }
  const text = input.promptText ?? "";
  // Match `@path/to/file.ext`, markdown links `](path/to/file.ext)`, or inline relative paths with extension.
  const pattern = /(?:@|\]\()?(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0].replace(/^[@]/u, "").replace(/^\]\(/u, "").trim();
    if (raw.length > 0 && !raw.startsWith("http://") && !raw.startsWith("https://")) {
      paths.add(raw);
    }
  }
  return Array.from(paths);
}

/** Extracts explicit `$skill-name` mentions from a user prompt. */
export function extractMentionedSkills(promptText?: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!promptText) return out;
  for (const match of promptText.matchAll(/(?:^|[\s(])\$([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\b/gu)) {
    out.add(match[1]!.toLowerCase());
  }
  return out;
}

export interface NativeDiscoveredSkill {
  readonly name: string;
  readonly path: string;
  readonly contentDigest?: string | undefined;
}

export interface HarnessContextSegment {
  readonly key: string;
  readonly text: string;
  readonly bytes: number;
}

export interface ProjectedHarnessContext {
  readonly segments: ReadonlyArray<HarnessContextSegment>;
  readonly skills: ReadonlyArray<ThreadContextSkillItem>;
  readonly rules: ReadonlyArray<ThreadContextRuleItem>;
  readonly degradedItems: ReadonlyArray<ThreadContextDegradedItem>;
  readonly contextBudgetBytes: typeof NonNegativeInt.Type;
  readonly contextUsedBytes: typeof NonNegativeInt.Type;
  readonly scaffoldBytes: typeof NonNegativeInt.Type;
  readonly needsGatewayTools: boolean;
  readonly nativeMountSkills: ReadonlyArray<HarnessSkillEntry>;
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function isSkillDeduplicatedByNative(
  skill: HarnessSkillEntry,
  nativeSkills: ReadonlyArray<NativeDiscoveredSkill>,
): boolean {
  const skillPath = normalizePath(skill.sourcePath);
  const skillName = skill.name.trim().toLowerCase();
  const skillId = skill.id.trim().toLowerCase();
  for (const native of nativeSkills) {
    const nativePath = normalizePath(native.path);
    if (nativePath === skillPath) return true;
    if (native.contentDigest !== undefined && native.contentDigest === skill.contentDigest) {
      return true;
    }
    const nativeName = native.name.trim().toLowerCase();
    if (
      skill.scope === "project" &&
      (nativeName === skillName || nativeName === skillId) &&
      nativePath.includes("/.agents/skills/")
    ) {
      return true;
    }
  }
  return false;
}

/** Evaluates whether a portable Mode allows the given MCP server ID. */
export function isMcpServerAllowedByMode(
  serverId: string,
  activeMode?: HarnessModeEntry | null | undefined,
): boolean {
  if (!activeMode) return true;
  if (activeMode.disabledMcpServers && activeMode.disabledMcpServers.includes(serverId as never)) {
    return false;
  }
  if (activeMode.allowedMcpServers !== undefined) {
    return activeMode.allowedMcpServers.includes(serverId as never);
  }
  return true;
}

/**
 * Pure projection of portable Harness modes, skills, personal `AGENTS.md`, and `rules/*.md` into
 * provider-bounded context segments without ever silently truncating user rules.
 */
export function projectHarnessContext(input: {
  readonly library: HarnessLibrarySnapshot;
  readonly harnessCapabilities: OrchestrationV2HarnessCapabilities;
  readonly activeMode?: HarnessModeEntry | null | undefined;
  readonly nativeSkills?: ReadonlyArray<NativeDiscoveredSkill> | undefined;
  readonly nativeReadsProjectAgentsMd?: boolean | undefined;
  readonly promptText?: string | undefined;
  readonly attachmentPaths?: ReadonlyArray<string> | undefined;
  readonly supportsMcpTools: boolean;
}): ProjectedHarnessContext {
  const { library, harnessCapabilities } = input;
  const totalBudget = library.maxSystemContextBytes;
  const maxSegmentBytes = harnessCapabilities.maxSystemContextBytes ?? totalBudget;

  if (!library.managedPolicyAllowsHarness) {
    return {
      segments: [],
      skills: [],
      rules: [],
      degradedItems: [],
      contextBudgetBytes: NonNegativeInt.make(totalBudget),
      contextUsedBytes: NonNegativeInt.make(0),
      scaffoldBytes: NonNegativeInt.make(0),
      needsGatewayTools: false,
      nativeMountSkills: [],
    };
  }

  const nativeSkills = input.nativeSkills ?? [];
  const referencedPaths = extractReferencedPaths({
    promptText: input.promptText,
    attachmentPaths: input.attachmentPaths,
  });
  const mentionedSkills = extractMentionedSkills(input.promptText);

  const skillItems: Array<ThreadContextSkillItem> = [];
  const ruleItems: Array<ThreadContextRuleItem> = [];
  const degradedItems: Array<ThreadContextDegradedItem> = [];
  const nativeMountSkills: Array<HarnessSkillEntry> = [];
  const gatewaySkills: Array<HarnessSkillEntry> = [];

  for (const skill of library.skills) {
    if (!skill.effectiveEnabled) {
      skillItems.push({
        id: skill.id,
        name: skill.name,
        scope: skill.scope,
        channel: "disabled",
        bytes: skill.bytes,
        reason: skill.overriddenByProject
          ? "Overridden or disabled by project configuration."
          : "Disabled in Harness settings.",
      });
      continue;
    }
    if (isSkillDeduplicatedByNative(skill, nativeSkills)) {
      skillItems.push({
        id: skill.id,
        name: skill.name,
        scope: skill.scope,
        channel: "deduplicated",
        bytes: skill.bytes,
        reason: "Already discovered natively by this provider (matched path/digest).",
      });
      continue;
    }
    if (harnessCapabilities.skillMount === "plugin-dir") {
      nativeMountSkills.push(skill);
      skillItems.push({
        id: skill.id,
        name: skill.name,
        scope: skill.scope,
        channel: "native-mount",
        bytes: skill.bytes,
      });
      continue;
    }
    gatewaySkills.push(skill);
    skillItems.push({
      id: skill.id,
      name: skill.name,
      scope: skill.scope,
      channel: "gateway",
      bytes: skill.bytes,
    });
  }

  // Decide which blocks want inline projection (strict priority, ZERO silent truncation).
  const candidateBlocks: Array<{
    readonly kind: "mode" | "agents_md" | "rule" | "skill_index" | "mentioned_skill";
    readonly id: string;
    readonly scope: "user" | "project";
    readonly apply: "always" | "glob" | "manual";
    readonly blockText: string;
    readonly rawBytes: number;
  }> = [];

  const activeMode = input.activeMode ?? null;
  const modeIncludedRules = new Set(
    (activeMode?.includedRules ?? []).map((id) => id.trim().toLowerCase()),
  );
  const modeIncludedSkills = new Set(
    (activeMode?.includedSkills ?? []).map((id) => id.trim().toLowerCase()),
  );

  // 0. Active declarative Mode instructions (highest priority)
  if (activeMode !== null && activeMode.effectiveEnabled && activeMode.body.trim().length > 0) {
    const readonlyAttr = activeMode.readonly ? ' readonly="true"' : "";
    const blockText = `<t3_mode id="${activeMode.id}" name="${activeMode.name}"${readonlyAttr}>\n${activeMode.body.trim()}\n</t3_mode>`;
    candidateBlocks.push({
      kind: "mode",
      id: activeMode.id,
      scope: "user",
      apply: "always",
      blockText,
      rawBytes: activeMode.bytes,
    });
  }

  // 1. User personal AGENTS.md (highest user rule priority)
  if (library.userAgentsMd.exists && library.userAgentsMd.body.trim().length > 0) {
    const blockText = `<t3_personal_rules source="~/.t3/harness/AGENTS.md">\n${library.userAgentsMd.body.trim()}\n</t3_personal_rules>`;
    candidateBlocks.push({
      kind: "agents_md",
      id: "user:AGENTS.md",
      scope: "user",
      apply: "always",
      blockText,
      rawBytes: library.userAgentsMd.bytes,
    });
  }

  // Project AGENTS.md: deduplicate when provider natively reads repository AGENTS.md
  if (
    library.projectAgentsMd !== null &&
    library.projectAgentsMd.exists &&
    library.projectAgentsMd.body.trim().length > 0
  ) {
    if (input.nativeReadsProjectAgentsMd !== false) {
      ruleItems.push({
        id: "project:AGENTS.md",
        scope: "project",
        apply: "always",
        status: "deduplicated",
        bytes: library.projectAgentsMd.bytes,
        reason: "Already loaded natively by this provider from the repository root.",
      });
    } else {
      const blockText = `<t3_project_rules source="AGENTS.md">\n${library.projectAgentsMd.body.trim()}\n</t3_project_rules>`;
      candidateBlocks.push({
        kind: "agents_md",
        id: "project:AGENTS.md",
        scope: "project",
        apply: "always",
        blockText,
        rawBytes: library.projectAgentsMd.bytes,
      });
    }
  }

  // 2. Conditional user rules (`rules/*.md`)
  let hasOnDemandOrDegradedRules = false;
  for (const rule of library.rules) {
    if (!rule.effectiveEnabled) {
      ruleItems.push({
        id: rule.id,
        scope: rule.scope,
        apply: rule.apply,
        status: "disabled",
        bytes: rule.bytes,
        reason: rule.overriddenByProject
          ? "Disabled by project t3.json."
          : "Disabled in Harness settings.",
      });
      continue;
    }
    const forcedByMode = modeIncludedRules.has(rule.id.toLowerCase());
    if (!forcedByMode && rule.apply === "manual") {
      hasOnDemandOrDegradedRules = true;
      ruleItems.push({
        id: rule.id,
        scope: rule.scope,
        apply: rule.apply,
        status: "on-demand",
        bytes: rule.bytes,
        reason: "Manual rule available on demand via harness_rule_read.",
      });
      continue;
    }
    if (!forcedByMode && rule.apply === "glob") {
      const matched =
        rule.globs.length > 0 &&
        referencedPaths.some((candidatePath) =>
          rule.globs.some((glob) => matchesRuleGlob(glob, candidatePath)),
        );
      if (!matched) {
        hasOnDemandOrDegradedRules = true;
        ruleItems.push({
          id: rule.id,
          scope: rule.scope,
          apply: rule.apply,
          status: "on-demand",
          bytes: rule.bytes,
          reason: `Glob rule (${rule.globs.join(", ")}) did not match this turn's referenced paths; readable via harness_rule_read.`,
        });
        continue;
      }
    }
    const blockText = `<t3_rule id="${rule.id}" apply="${rule.apply}">\n${rule.body.trim()}\n</t3_rule>`;
    candidateBlocks.push({
      kind: "rule",
      id: rule.id,
      scope: rule.scope,
      apply: rule.apply,
      blockText,
      rawBytes: rule.bytes,
    });
  }

  // 3. Explicit `$skill` mentions or Mode-included skills for non-native skills
  for (const skill of gatewaySkills) {
    if (
      mentionedSkills.has(skill.id.toLowerCase()) ||
      mentionedSkills.has(skill.name.toLowerCase()) ||
      modeIncludedSkills.has(skill.id.toLowerCase()) ||
      modeIncludedSkills.has(skill.name.toLowerCase())
    ) {
      const blockText = `<t3_skill name="${skill.name}" scope="${skill.scope}">\n${skill.body.trim()}\n</t3_skill>`;
      candidateBlocks.push({
        kind: "mentioned_skill",
        id: skill.id,
        scope: skill.scope,
        apply: "manual",
        blockText,
        rawBytes: skill.bytes,
      });
    }
  }

  // 4. Compact 1-line-per-skill index for gateway skills
  const indexableGatewaySkills = gatewaySkills.filter((skill) => !skill.userInvocationOnly);
  if (indexableGatewaySkills.length > 0) {
    const lines = indexableGatewaySkills.map((skill) => {
      const summary = (skill.shortDescription ?? skill.description ?? "")
        .replaceAll(/\s+/gu, " ")
        .trim();
      return summary.length > 0 ? `- ${skill.name}: ${summary}` : `- ${skill.name}`;
    });
    const indexText = `<t3_portable_skills>\n${lines.join("\n")}\n</t3_portable_skills>`;
    candidateBlocks.push({
      kind: "skill_index",
      id: "portable-skill-index",
      scope: "user",
      apply: "always",
      blockText: indexText,
      rawBytes: utf8Bytes(indexText),
    });
  }

  // Pack whole blocks into segments without EVER truncating a block AND guaranteeing
  // emitted total bytes (including fixed scaffold and `\n\n` inter-block separators) <= totalBudget.
  const preliminaryNeedsGateway =
    input.supportsMcpTools && (gatewaySkills.length > 0 || hasOnDemandOrDegradedRules);
  const scaffoldText = T3_CODE_HARNESS_SCAFFOLD_INSTRUCTIONS;
  const scaffoldByteSize = utf8Bytes(scaffoldText);

  const packWithScaffold = (includeScaffold: boolean) => {
    const accepted: Array<{ readonly text: string; readonly bytes: number }> = [];
    const packedRuleItems: Array<ThreadContextRuleItem> = [...ruleItems];
    const packedDegradedItems: Array<ThreadContextDegradedItem> = [...degradedItems];
    let hasDegraded = false;
    let extraOnDemandRules = false;
    let remainingBudget = totalBudget;
    let currentSegmentBytes = 0;
    let currentSegmentParts = 0;
    let usedScaffoldBytes = 0;

    if (
      includeScaffold &&
      scaffoldByteSize <= maxSegmentBytes &&
      scaffoldByteSize <= remainingBudget
    ) {
      remainingBudget -= scaffoldByteSize;
      currentSegmentBytes = scaffoldByteSize;
      currentSegmentParts = 1;
      usedScaffoldBytes = scaffoldByteSize;
    }

    for (const candidate of candidateBlocks) {
      const blockBytes = utf8Bytes(candidate.blockText);
      const fitsSegment = blockBytes <= maxSegmentBytes;
      const mergesIntoCurrent =
        currentSegmentParts > 0 && currentSegmentBytes + 2 + blockBytes <= maxSegmentBytes;
      const incrementalBytes = mergesIntoCurrent ? 2 + blockBytes : blockBytes;
      const fitsTotal = incrementalBytes <= remainingBudget;

      if (fitsSegment && fitsTotal) {
        accepted.push({ text: candidate.blockText, bytes: blockBytes });
        remainingBudget -= incrementalBytes;
        if (mergesIntoCurrent) {
          currentSegmentBytes += 2 + blockBytes;
          currentSegmentParts += 1;
        } else {
          currentSegmentBytes = blockBytes;
          currentSegmentParts = 1;
        }
        if (candidate.kind === "agents_md" || candidate.kind === "rule") {
          packedRuleItems.push({
            id: candidate.id,
            scope: candidate.scope,
            apply: candidate.apply,
            status: "inlined",
            bytes: NonNegativeInt.make(blockBytes),
          });
        }
      } else {
        hasDegraded = true;
        const readHint =
          candidate.kind === "mode"
            ? `Read on demand via harness_rule_read(id: "mode:${candidate.id}") without truncation.`
            : "Degraded whole-block to on-demand tool read without truncation.";
        const reason = !fitsSegment
          ? `Block (${blockBytes} B) exceeds provider per-entry cap (${maxSegmentBytes} B); ${readHint}`
          : `Block (${blockBytes} B) exceeds remaining harness context budget (${remainingBudget} B / ${totalBudget} B); ${readHint}`;
        if (candidate.kind === "mode") {
          packedDegradedItems.push({ kind: "mode", id: candidate.id, reason });
        } else if (candidate.kind === "agents_md" || candidate.kind === "rule") {
          extraOnDemandRules = true;
          packedRuleItems.push({
            id: candidate.id,
            scope: candidate.scope,
            apply: candidate.apply,
            status: "degraded",
            bytes: NonNegativeInt.make(candidate.rawBytes),
            reason,
          });
          packedDegradedItems.push({ kind: "rule", id: candidate.id, reason });
        } else {
          packedDegradedItems.push({ kind: "skill", id: candidate.id, reason });
        }
      }
    }

    return {
      accepted,
      packedRuleItems,
      packedDegradedItems,
      hasDegraded,
      extraOnDemandRules,
      usedScaffoldBytes,
    };
  };

  let packed = packWithScaffold(preliminaryNeedsGateway);
  let needsGatewayTools =
    input.supportsMcpTools &&
    (preliminaryNeedsGateway ||
      hasOnDemandOrDegradedRules ||
      packed.extraOnDemandRules ||
      packed.hasDegraded);
  // If degrading a block newly requires the gateway scaffold, re-pack reserving the scaffold bytes inside totalBudget.
  if (needsGatewayTools && !preliminaryNeedsGateway) {
    packed = packWithScaffold(true);
    needsGatewayTools =
      input.supportsMcpTools &&
      (hasOnDemandOrDegradedRules || packed.extraOnDemandRules || packed.hasDegraded);
  }

  const rawBlocks: Array<{ readonly text: string; readonly bytes: number }> = [];
  const scaffoldBytes = packed.usedScaffoldBytes;
  if (scaffoldBytes > 0) {
    rawBlocks.push({ text: scaffoldText, bytes: scaffoldByteSize });
  }
  rawBlocks.push(...packed.accepted);

  // Merge adjacent blocks into bounded segments where EVERY segment is guaranteed <= maxSegmentBytes
  // and total emitted bytes <= totalBudget.
  const segments: Array<HarnessContextSegment> = [];
  let currentParts: Array<string> = [];
  let currentBytes = 0;
  const flushSegment = () => {
    if (currentParts.length === 0) return;
    const text = currentParts.join("\n\n");
    const index = String(segments.length + 1).padStart(2, "0");
    segments.push({
      key: `t3_harness_${index}`,
      text,
      bytes: utf8Bytes(text),
    });
    currentParts = [];
    currentBytes = 0;
  };

  for (const block of rawBlocks) {
    const separatorBytes = currentParts.length === 0 ? 0 : 2;
    if (currentParts.length > 0 && currentBytes + separatorBytes + block.bytes > maxSegmentBytes) {
      flushSegment();
    }
    currentParts.push(block.text);
    currentBytes += (currentParts.length === 1 ? 0 : 2) + block.bytes;
  }
  flushSegment();

  const contextUsedBytes = segments.reduce((sum, seg) => sum + seg.bytes, 0);

  return {
    segments,
    skills: skillItems,
    rules: packed.packedRuleItems,
    degradedItems: packed.packedDegradedItems,
    contextBudgetBytes: NonNegativeInt.make(totalBudget),
    contextUsedBytes: NonNegativeInt.make(contextUsedBytes),
    scaffoldBytes: NonNegativeInt.make(scaffoldBytes),
    needsGatewayTools,
    nativeMountSkills,
  };
}
