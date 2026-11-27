import { LIGHTNING_BRAND } from "@t3tools/shared/brand";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CLI_NPM_PACKAGE_NAME } from "@t3tools/shared/cliRelease";
import { resolveCommandPath } from "@t3tools/shared/shell";

import packageJson from "../../package.json" with { type: "json" };
import {
  findPosixLauncher,
  findWindowsShim,
  pinnedRuntimeVersionsDir,
  readPosixLauncherTarget,
  resolveLauncherPath,
} from "../cloud/pinnedRuntime.ts";

const PINNED_RUNTIME_ENTRY = /^(.*)\/runtime\/versions\/[^/]+\/t3(?:\.exe)?$/i;
const pinnedRuntimeHome = (executable: string) =>
  PINNED_RUNTIME_ENTRY.exec(executable.replaceAll("\\", "/"))?.[1];

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/** Detection is best-effort; callers fall back to the installed command. */
export function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || /\/bunx-[^/]+\/node_modules\//.test(path)) {
    return "bunx";
  }
  return null;
}

const InstallManifest = Schema.Struct({
  name: Schema.Literals([CLI_NPM_PACKAGE_NAME, "t3"]),
  version: Schema.String,
  bin: Schema.Struct({ lightning: Schema.String }),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));
const NPM_GLOBAL_ENTRY =
  /^(?<modulesParent>.*\/)node_modules\/(?<name>(?:@[^/]+\/)?[^/]+)\/(?:dist\/bin\.mjs|bin\/t3\.mjs)$/;

// npm's cmd-shim expands the Node shebang into this wrapper. An exact match rules out
// a custom wrapper that happens to mention or chain to the installed package.
const matchesNpmWindowsShim = (contents: string, relativeEntry: string) =>
  contents.replaceAll("\r\n", "\n") ===
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry.replaceAll("/", "\\")}" %*`,
    "",
  ].join("\n");

/**
 * `T3CODE_NPM_LAUNCHER_PATH` is inherited by child shells. Check the version and bin
 * target, since the legacy package name also belongs to upstream T3 Code.
 */
export const resolveEntryPath = Effect.gen(function* () {
  const npmLauncher = (yield* HostProcess.Environment).T3CODE_NPM_LAUNCHER_PATH?.trim();
  if (npmLauncher) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageRoot = path.dirname(path.dirname(npmLauncher));
    const manifest = yield* fs
      .readFileString(path.join(packageRoot, "package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest), Effect.option);
    if (
      Option.isSome(manifest) &&
      manifest.value.version === packageJson.version &&
      path.resolve(packageRoot, manifest.value.bin.lightning) === path.resolve(npmLauncher)
    ) {
      return npmLauncher;
    }
  }
  if (yield* HostProcess.IsExecutable) return yield* HostProcess.ExecutablePath;
  return (yield* HostProcess.Arguments)[1] ?? "";
});

export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(yield* resolveEntryPath);
  const runner = detectCliRunner(entry);
  if (runner !== null && (yield* HostProcess.IsExecutable)) {
    const executable = yield* HostProcess.ExecutablePath;
    const home = pinnedRuntimeHome(executable);
    if (home !== undefined) {
      return {
        kind: "t3-launcher",
        launcher: executable,
        baseDir: path.normalize(home || "/"),
      } satisfies ServerInstallation;
    }
  }
  const runtime = pinnedRuntimeHome(entry);
  if (platform === "win32" && runtime !== undefined) {
    const baseDir = path.normalize(runtime || "/");
    const launcher = yield* findWindowsShim(entry, pinnedRuntimeVersionsDir(path, baseDir));
    return {
      kind: "t3-launcher",
      launcher: launcher ?? entry,
      baseDir,
    } satisfies ServerInstallation;
  }
  if (runtime !== undefined) {
    const launchedAs = yield* resolveLauncherPath;
    if (launchedAs === undefined) return null;
    const link = yield* fs.readLink(launchedAs).pipe(Effect.option);
    // A launcher script execs the runtime itself, so look for the script that runs it.
    const launcher = Option.isSome(link)
      ? launchedAs
      : yield* findPosixLauncher({
          launchedAs,
          versionsDir: pinnedRuntimeVersionsDir(path, runtime || "/"),
        });
    // None for a runtime started directly, as SSH launches do, or through a copy.
    if (launcher === undefined) return null;
    const target = Option.isSome(link)
      ? path.resolve(path.dirname(launcher), link.value)
      : yield* readPosixLauncherTarget(launcher);
    // Keep the home as the launcher spells it; `t3 update` only repoints launchers into that spelling.
    const linked = target === undefined ? undefined : pinnedRuntimeHome(target);
    if (linked === undefined || (yield* fs.realPath(linked || "/")) !== (runtime || "/"))
      return null;
    return {
      kind: "t3-launcher",
      launcher,
      baseDir: linked || "/",
    } satisfies ServerInstallation;
  }
  if (runner !== null) {
    const node = yield* HostProcess.ExecutablePath;
    return {
      kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner,
      ...(path.isAbsolute(node) && !(yield* HostProcess.IsExecutable)
        ? { launch: { node, entry } }
        : {}),
    } satisfies ServerInstallation;
  }
  const windows = platform === "win32";
  const match = NPM_GLOBAL_ENTRY.exec(entry.replaceAll("\\", "/"))?.groups;
  const modulesParent = match?.modulesParent;
  const name = match?.name;
  if (
    modulesParent === undefined ||
    (!windows && !modulesParent.endsWith("/lib/")) ||
    (name !== CLI_NPM_PACKAGE_NAME && name !== "t3")
  )
    return null;
  const rawPrefix = windows ? modulesParent : modulesParent.slice(0, -"lib/".length);
  if (
    /(?:^|\/)node_modules\//i.test(rawPrefix) ||
    /\/(?:Cellar|Caskroom)\//i.test(rawPrefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(rawPrefix)
  )
    return null;

  const prefix = path.resolve(rawPrefix);
  const packageRoot = path.dirname(path.dirname(entry));
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== name) return null;
  const bin = path.resolve(packageRoot, manifest.bin.lightning);
  if ((yield* fs.realPath(bin)) !== entry) return null;
  if (windows) {
    const contents = yield* fs.readFileString(
      path.join(prefix, `${LIGHTNING_BRAND.cliCommand}.cmd`),
    );
    if (!matchesNpmWindowsShim(contents, path.relative(prefix, bin))) return null;
  } else {
    const globalBin = yield* fs.realPath(path.join(prefix, "bin", LIGHTNING_BRAND.cliCommand));
    if (globalBin !== entry) return null;
  }
  return {
    kind: "npm-global",
    prefix,
    packageName: manifest.name,
    ...(manifest.name === "t3" ? { legacyPackage: true } : {}),
  } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** PowerShell also treats typographic quotes as delimiters; escape them and suppress expansion. */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

export const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

export const resolveCliCommand = Effect.fn("invocation.resolveCliCommand")(function* (
  subcommand: string,
) {
  const entryPath = yield* resolveEntryPath;
  if (detectCliRunner(entryPath) === null) return `${LIGHTNING_BRAND.cliCommand} ${subcommand}`;
  const platform = yield* HostProcess.Platform;
  const node = hostShellWord(platform, yield* HostProcess.ExecutablePath);
  const invoke = platform === "win32" ? `& ${node}` : node;
  if (yield* HostProcess.IsExecutable) return `${invoke} ${subcommand}`;
  return `${invoke} ${hostShellWord(platform, entryPath)} ${subcommand}`;
});

/** Script installs have no single launcher; desktop shims and standalone binaries do. */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).LIGHTNING_CODE_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * Uses this install's command on PATH or its absolute executable or cached entry point.
 * Arguments are quoted for POSIX shells or PowerShell on Windows.
 */
export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const withArgs = (prefix: string) =>
    // An empty subcommand names the root `t3` command.
    [prefix.trimEnd(), ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
  const command = yield* resolveCliCommand(subcommand);
  if (command !== `${LIGHTNING_BRAND.cliCommand} ${subcommand}`)
    return { command: withArgs(command), launcher: true };
  const onPath = yield* resolveCommandPath(LIGHTNING_BRAND.cliCommand);
  if (onPath !== null) {
    const shim = (yield* HostProcess.Environment).LIGHTNING_CODE_CLI_PATH?.trim();
    const fs = yield* FileSystem.FileSystem;
    const real = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
    // Windows `t3.cmd` shims are text files that never realpath to the executable they run.
    const own = shim
      ? yield* real(shim)
      : platform !== "win32" && (yield* HostProcess.IsExecutable)
        ? yield* resolveEntryPath.pipe(
            Effect.flatMap((entry) =>
              real(entry).pipe(Effect.map((resolved) => resolved ?? entry)),
            ),
          )
        : null;
    if (own === null || own === (yield* real(onPath))) {
      return { command: withArgs(command), launcher: false };
    }
  }
  const launcher = yield* resolveInstallLauncher;
  if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
  // PowerShell runs a quoted path only through the call operator.
  const quoted = hostShellWord(platform, launcher.value);
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return { command: withArgs(`${call} ${subcommand}`), launcher: true };
});

/** A hint's command, run against the caller's `--base-dir` when one was given. */
export const resolveHostCliHint = (
  subcommand: string,
  baseDir: Option.Option<string>,
  args: ReadonlyArray<string> = [],
) =>
  resolveHostCliCommand(subcommand, [
    ...Option.match(baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
    ...args,
  ]).pipe(Effect.map(({ command }) => command));

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and its global commands. An absolute launcher uses
 * its own Node path.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand, args);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
