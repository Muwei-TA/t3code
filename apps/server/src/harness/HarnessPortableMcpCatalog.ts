// @effect-diagnostics nodeBuiltinImport:off -- Checks machine-local paths in portable MCP definitions.
import * as NodePath from "node:path";
import {
  type HarnessMcpServerConfig,
  HarnessPortableMcpCatalog,
  isReservedHarnessMcpServerId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  configContainsSecretPlaceholder,
  isSafePlaceholderValue,
  redactHarnessServerConfig,
} from "./HarnessSecrets.ts";

export const PORTABLE_MCP_FILE = "mcp-servers.portable.json";

const parseCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(HarnessPortableMcpCatalog), {
  onExcessProperty: "error",
});

function isMachineLocalPath(value: string): boolean {
  return (
    NodePath.posix.isAbsolute(value) ||
    NodePath.win32.isAbsolute(value) ||
    /^~(?:[/\\]|$)/u.test(value)
  );
}

function isPortableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !(url.username || url.password || url.search || url.hash);
  } catch {
    return false;
  }
}

function hasPortableValues(record: Readonly<Record<string, string>> | undefined): boolean {
  return Object.values(record ?? {}).every(
    (value) =>
      value.trim() === "" || (value.includes("${secret:") && isSafePlaceholderValue(value)),
  );
}

export function portableMcpConfig(config: HarnessMcpServerConfig): HarnessMcpServerConfig | null {
  if (config.origin?.kind === "project") return null;
  const { origin: _origin, ...portable } = config;
  const transport = portable.transport;
  if (transport.type === "stdio") {
    const redacted = redactHarnessServerConfig(config).transport;
    if (
      !/^[\w.-]+$/u.test(transport.command) ||
      (transport.cwd !== undefined && isMachineLocalPath(transport.cwd)) ||
      transport.args?.some((arg, index) => {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
        return (
          isMachineLocalPath(value) || (redacted.type === "stdio" && redacted.args?.[index] !== arg)
        );
      }) ||
      !hasPortableValues(transport.env)
    )
      return null;
  } else if (
    !isPortableUrl(transport.url) ||
    (transport.oauth?.authorizationServerUrl !== undefined &&
      !isPortableUrl(transport.oauth.authorizationServerUrl)) ||
    !hasPortableValues(transport.headers)
  )
    return null;
  return portable;
}

export function isPortableMcpCatalog(catalog: HarnessPortableMcpCatalog): boolean {
  const seen = new Set<string>();
  return (
    catalog.servers.length <= 128 &&
    catalog.servers.every(({ id, config }) => {
      const key = id.toLowerCase();
      if (seen.has(key) || isReservedHarnessMcpServerId(id) || config.origin !== undefined)
        return false;
      seen.add(key);
      return portableMcpConfig(config) !== null;
    })
  );
}

export function readPortableMcpCatalog(text: string): HarnessPortableMcpCatalog | null {
  try {
    const catalog = parseCatalog(text);
    return isPortableMcpCatalog(catalog) ? catalog : null;
  } catch {
    return null;
  }
}

export function importedMcpConfig(config: HarnessMcpServerConfig): HarnessMcpServerConfig {
  return config.transport.type === "stdio" || configContainsSecretPlaceholder(config)
    ? { ...config, enabled: false }
    : config;
}
