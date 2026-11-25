import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { formatMobileTargetHost, formatMobileTransportBreakdown } from "./harness-confirmation";

describe("SettingsHarnessRouteScreen remote confirmation helpers", () => {
  it("formats target host with both label and explicit remote address", () => {
    expect(
      formatMobileTargetHost({
        environmentId: "env-mac-studio" as EnvironmentId,
        label: "Mac Studio",
        displayUrl: "https://mac-studio.tailnet.ts.net",
      }),
    ).toBe("Mac Studio (https://mac-studio.tailnet.ts.net)");

    expect(
      formatMobileTargetHost({
        environmentId: "env-local-1" as EnvironmentId,
        label: "Dev Box",
        displayUrl: null,
      }),
    ).toBe("Dev Box (env-local-1)");
  });

  it("formats exact stdio command, individual argv entries, cwd, env keys, route, and policy", () => {
    const breakdown = formatMobileTransportBreakdown({
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/my repo"],
        cwd: "/workspace/my repo",
        env: { GITHUB_TOKEN: "${secret:GH_TOKEN}" },
      },
      injectionMode: "gateway",
      approvalPolicy: "auto-read",
    });

    expect(breakdown).toContain("command: npx");
    expect(breakdown).toContain('argv[0]: "-y"');
    expect(breakdown).toContain('argv[1]: "@modelcontextprotocol/server-filesystem"');
    expect(breakdown).toContain('argv[2]: "/workspace/my repo"');
    expect(breakdown).toContain("cwd: /workspace/my repo");
    expect(breakdown).toContain("env keys: GITHUB_TOKEN");
    expect(breakdown).toContain("route: gateway · policy: auto-read");
  });

  it("formats HTTP/SSE destination URL, header keys, route, and policy", () => {
    const breakdown = formatMobileTransportBreakdown({
      enabled: true,
      transport: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${secret:LINEAR_KEY}" },
      },
      injectionMode: "native",
      approvalPolicy: "always-ask",
    });

    expect(breakdown).toContain("HTTP: https://mcp.linear.app/mcp");
    expect(breakdown).toContain("header keys: Authorization");
    expect(breakdown).toContain("route: native · policy: always-ask");
  });
});
