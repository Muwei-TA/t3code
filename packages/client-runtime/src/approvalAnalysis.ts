import type { ProviderRequestKind } from "@t3tools/contracts";

export type ApprovalRiskTagId =
  | "destructive"
  | "privilege"
  | "network"
  | "git-push"
  | "package-install"
  | "fs-write"
  | "read-only";

export type ApprovalRiskSeverity = "high" | "medium" | "low";

export interface ApprovalRiskTag {
  readonly id: ApprovalRiskTagId;
  readonly severity: ApprovalRiskSeverity;
}

export interface ApprovalCommandAnalysis {
  readonly kind: "command";
  readonly rawCommand: string;
  readonly cwd: string | null;
  readonly argv: ReadonlyArray<string>;
  readonly riskTags: ReadonlyArray<ApprovalRiskTag>;
}

export interface ApprovalDiffLine {
  readonly kind: "context" | "add" | "del" | "hunk" | "header";
  readonly text: string;
}

export interface ApprovalFileChangeAnalysis {
  readonly kind: "file-change";
  readonly filePath: string | null;
  readonly unifiedDiff: string | null;
  readonly previewLines: ReadonlyArray<ApprovalDiffLine>;
  readonly additions: number;
  readonly deletions: number;
}

export interface ApprovalJsonPayloadAnalysis {
  readonly kind: "structured-json";
  readonly summary: string;
  readonly formattedJson: string;
}

export interface ApprovalPlainAnalysis {
  readonly kind: "plain";
  readonly text: string;
}

export type ApprovalAnalysis =
  | ApprovalCommandAnalysis
  | ApprovalFileChangeAnalysis
  | ApprovalJsonPayloadAnalysis
  | ApprovalPlainAnalysis;

/** Tokenizes a shell command line into argv tokens without executing anything. */
export function tokenizeShellCommand(command: string): ReadonlyArray<string> {
  const tokens: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function extractCwdAndCommand(detail: string): {
  readonly cwd: string | null;
  readonly command: string;
} {
  const trimmed = detail.trim();
  const cwdLineMatch = /^(?:cwd|dir|directory)\s*:\s*([^\n]+)\n+([\s\S]+)$/iu.exec(trimmed);
  if (cwdLineMatch) {
    return { cwd: cwdLineMatch[1]!.trim(), command: cwdLineMatch[2]!.trim() };
  }
  const inDirMatch = /^([\s\S]+?)\s+\(in\s+([^)\n]+)\)\s*$/u.exec(trimmed);
  if (inDirMatch) {
    return { cwd: inDirMatch[2]!.trim(), command: inDirMatch[1]!.trim() };
  }
  return { cwd: null, command: trimmed };
}

/** Deterministic shell command risk analyzer used for inline approval badges (never enforces policy). */
export function detectCommandRiskTags(command: string): ReadonlyArray<ApprovalRiskTag> {
  const tags: Array<ApprovalRiskTag> = [];
  const seen = new Set<ApprovalRiskTagId>();
  const add = (id: ApprovalRiskTagId, severity: ApprovalRiskSeverity) => {
    if (seen.has(id)) return;
    seen.add(id);
    tags.push({ id, severity });
  };

  if (
    /\brm\s+[^\n]*-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b|\bmkfs\b|\bdd\s+if=|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+[^\n]*-[a-zA-Z]*f|\bDROP\s+(?:TABLE|DATABASE)\b|\btruncate\s+-s\s*0\b/iu.test(
      command,
    )
  ) {
    add("destructive", "high");
  }
  if (/\b(?:sudo|doas|su|chmod\s+[0-7]*7[0-7]{2}|chown|launchctl|systemctl)\b/u.test(command)) {
    add("privilege", "high");
  }
  if (/\bgit\s+push\b/u.test(command)) {
    add("git-push", /\s--force(?:-with-lease)?\b|\s-f\b/u.test(command) ? "high" : "medium");
  }
  if (
    /\b(?:curl|wget|ssh|scp|rsync|nc|netcat|telnet|ftp|gh\s+api|http\s+|https?:\/\/)\b/iu.test(
      command,
    )
  ) {
    add("network", "medium");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|cargo|brew|apt|apt-get)\s+(?:install|add|i|upgrade|uninstall|remove)\b/u.test(
      command,
    )
  ) {
    add("package-install", "medium");
  }
  if (
    /(?:^|[\s;&|])(?:mv|cp|rm|mkdir|touch|tee|sed\s+-i|perl\s+-pi)\b|>>?\s*\S/u.test(command) &&
    !seen.has("destructive")
  ) {
    add("fs-write", "low");
  }
  if (
    tags.length === 0 &&
    /^\s*(?:ls|cat|head|tail|pwd|echo|git\s+(?:status|diff|log|show|branch)|rg|grep|find|wc|which|stat)\b/u.test(
      command,
    )
  ) {
    add("read-only", "low");
  }

  return tags;
}

function parseUnifiedDiffPreview(detail: string): ApprovalFileChangeAnalysis | null {
  const trimmed = detail.trim();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split(/\r?\n/u);
  const hasUnifiedMarkers =
    lines.some((line) => line.startsWith("@@ ")) ||
    (lines.some((line) => line.startsWith("--- ")) &&
      lines.some((line) => line.startsWith("+++ ")));

  const fileHeader = lines.find((line) => line.startsWith("+++ "));
  const diffGitHeader = lines.find((line) => line.startsWith("diff --git "));
  let filePath: string | null = null;
  if (fileHeader) {
    const candidate = fileHeader.slice(4).trim().replace(/^b\//u, "");
    if (candidate && candidate !== "/dev/null") filePath = candidate;
  } else if (diffGitHeader) {
    const parts = diffGitHeader.split(/\s+/u);
    if (parts[3]) filePath = parts[3].replace(/^b\//u, "");
  } else {
    const pathMatch = /(?:^|\s)([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,12})(?:\s|$|:)/u.exec(
      lines[0] ?? "",
    );
    if (pathMatch) filePath = pathMatch[1] ?? null;
  }

  if (!hasUnifiedMarkers) {
    // Still extract file path if present, without fabricating a unified diff.
    if (filePath === null) return null;
    return {
      kind: "file-change",
      filePath,
      unifiedDiff: null,
      previewLines: lines.slice(0, 60).map((text) => ({ kind: "context", text })),
      additions: 0,
      deletions: 0,
    };
  }

  let additions = 0;
  let deletions = 0;
  const previewLines: Array<ApprovalDiffLine> = [];
  for (const line of lines.slice(0, 200)) {
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      previewLines.push({ kind: "header", text: line });
    } else if (line.startsWith("@@ ")) {
      previewLines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      additions += 1;
      previewLines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      deletions += 1;
      previewLines.push({ kind: "del", text: line });
    } else {
      previewLines.push({ kind: "context", text: line });
    }
  }

  const normalizedDiff = lines.some((l) => l.startsWith("--- "))
    ? trimmed
    : `--- a/${filePath ?? "file"}\n+++ b/${filePath ?? "file"}\n${trimmed}`;

  return {
    kind: "file-change",
    filePath,
    unifiedDiff: normalizedDiff,
    previewLines,
    additions,
    deletions,
  };
}

function tryExtractJsonPayload(detail: string): ApprovalJsonPayloadAnalysis | null {
  const trimmed = detail.trim();
  const braceIdx = trimmed.indexOf("{");
  const bracketIdx = trimmed.indexOf("[");
  const startIdx =
    braceIdx === -1 ? bracketIdx : bracketIdx === -1 ? braceIdx : Math.min(braceIdx, bracketIdx);
  if (startIdx === -1) return null;
  const candidate = trimmed.slice(startIdx).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object") return null;
    return {
      kind: "structured-json",
      summary: trimmed.slice(0, startIdx).trim(),
      formattedJson: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return null;
  }
}

/** Pure analyzer turning raw approval request text into structured diff, argv/risk, or JSON views. */
export function analyzeApprovalRequest(input: {
  readonly requestKind: ProviderRequestKind;
  readonly detail?: string | undefined;
}): ApprovalAnalysis {
  const raw = (input.detail ?? "").trim();
  if (raw.length === 0) {
    return { kind: "plain", text: "" };
  }

  if (input.requestKind === "command") {
    const { cwd, command } = extractCwdAndCommand(raw);
    return {
      kind: "command",
      rawCommand: command,
      cwd,
      argv: tokenizeShellCommand(command),
      riskTags: detectCommandRiskTags(command),
    };
  }

  if (input.requestKind === "file-change") {
    const parsed = parseUnifiedDiffPreview(raw);
    if (parsed !== null) return parsed;
  }

  if (input.requestKind === "mcp-elicitation" || input.requestKind === "permission") {
    const jsonPayload = tryExtractJsonPayload(raw);
    if (jsonPayload !== null) return jsonPayload;
  }

  return { kind: "plain", text: raw };
}
