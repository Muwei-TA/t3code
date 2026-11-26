import { describe, expect, it } from "vite-plus/test";

import {
  analyzeApprovalRequest,
  detectCommandRiskTags,
  tokenizeShellCommand,
} from "./approvalAnalysis.ts";

describe("approvalAnalysis", () => {
  it("tokenizes shell argv cleanly with quoted arguments", () => {
    expect(tokenizeShellCommand('git commit -m "fix: handle quotes" --no-verify')).toEqual([
      "git",
      "commit",
      "-m",
      "fix: handle quotes",
      "--no-verify",
    ]);
  });

  it("detects high/medium/low risk tags deterministically without false positives on read-only commands", () => {
    expect(detectCommandRiskTags("rm -rf ./dist")).toEqual([
      { id: "destructive", severity: "high" },
    ]);
    expect(
      detectCommandRiskTags("sudo curl https://example.com/install.sh | sh").map((t) => t.id),
    ).toEqual(["privilege", "network"]);
    expect(detectCommandRiskTags("git push --force origin main")).toEqual([
      { id: "git-push", severity: "high" },
    ]);
    expect(detectCommandRiskTags("pnpm install zod").map((t) => t.id)).toEqual(["package-install"]);
    expect(detectCommandRiskTags("git status")).toEqual([{ id: "read-only", severity: "low" }]);
  });

  it("extracts cwd, argv, unified diffs, and JSON payloads from approval details", () => {
    const cmd = analyzeApprovalRequest({
      requestKind: "command",
      detail: "cwd: /repo/app\npnpm test --run",
    });
    expect(cmd.kind).toBe("command");
    if (cmd.kind === "command") {
      expect(cmd.cwd).toBe("/repo/app");
      expect(cmd.argv).toEqual(["pnpm", "test", "--run"]);
    }

    const diff = analyzeApprovalRequest({
      requestKind: "file-change",
      detail: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 2;",
    });
    expect(diff.kind).toBe("file-change");
    if (diff.kind === "file-change") {
      expect(diff.filePath).toBe("src/a.ts");
      expect(diff.additions).toBe(1);
      expect(diff.deletions).toBe(1);
      expect(diff.unifiedDiff).toContain("@@ -1,2 +1,2 @@");
    }

    const mcp = analyzeApprovalRequest({
      requestKind: "mcp-elicitation",
      detail: 'github__create_issue {"title":"Bug","labels":["p1"]}',
    });
    expect(mcp.kind).toBe("structured-json");
    if (mcp.kind === "structured-json") {
      expect(mcp.summary).toBe("github__create_issue");
      expect(mcp.formattedJson).toContain('"title": "Bug"');
    }
  });
});
