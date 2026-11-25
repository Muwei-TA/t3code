import type { EnvironmentId, HarnessMcpServerConfig } from "@t3tools/contracts";

export function formatMobileTargetHost(environment: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
}): string {
  const address = environment.displayUrl ?? environment.environmentId;
  return `${environment.label} (${address})`;
}

export function formatMobileTransportBreakdown(config: HarnessMcpServerConfig): string {
  const lines: Array<string> = [];
  if (config.transport.type === "stdio") {
    lines.push(`command: ${config.transport.command}`);
    const args = config.transport.args ?? [];
    if (args.length === 0) {
      lines.push("argv: []");
    } else {
      args.forEach((arg, index) => {
        lines.push(`argv[${index}]: ${JSON.stringify(arg)}`);
      });
    }
    if (config.transport.cwd) {
      lines.push(`cwd: ${config.transport.cwd}`);
    }
    const envKeys = Object.keys(config.transport.env ?? {});
    if (envKeys.length > 0) {
      lines.push(`env keys: ${envKeys.join(", ")}`);
    }
  } else {
    lines.push(`${config.transport.type.toUpperCase()}: ${config.transport.url}`);
    const headerKeys = Object.keys(config.transport.headers ?? {});
    if (headerKeys.length > 0) {
      lines.push(`header keys: ${headerKeys.join(", ")}`);
    }
  }
  lines.push(`route: ${config.injectionMode} · policy: ${config.approvalPolicy}`);
  return lines.join("\n");
}
