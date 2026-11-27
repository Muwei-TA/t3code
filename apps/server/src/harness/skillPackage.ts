// @effect-diagnostics nodeBuiltinImport:off -- Package copies require bounded binary reads, POSIX modes and same-volume renames.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NonNegativeInt, type HarnessPackageFile, type HarnessSkillFile } from "@t3tools/contracts";
import { assertContainedNoSymlinks, replaceDirectory } from "./safeFileOps.ts";

const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PACKAGE_BYTES = 8 * MAX_FILE_BYTES;
const MAX_FILES = 512;

function validatePackagePath(relativePath: string) {
  if (
    !relativePath ||
    relativePath.length > 512 ||
    /[\\<>:"|?*\x00-\x1f]/u.test(relativePath) ||
    relativePath
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === ".git" ||
          /[. ]$/u.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
      )
  ) {
    throw new Error("Invalid package-relative path.");
  }
  return relativePath;
}

export async function readPackageFile(root: string, relativePath: string) {
  const target = NodePath.join(root, validatePackagePath(relativePath));
  const { resolvedTarget } = await assertContainedNoSymlinks(root, target);
  const handle = await NodeFSP.open(
    resolvedTarget,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error("Invalid or oversized package file.");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Package file changed while reading.");
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== info.size)
      throw new Error("Package file changed while reading.");
    return {
      bytes,
      executable: (info.mode & 0o111) !== 0,
      executeBits: info.mode & 0o111,
      path: resolvedTarget,
    };
  } finally {
    await handle.close();
  }
}

export async function listPackageFiles(root: string, limit = MAX_FILES) {
  const files: HarnessSkillFile[] = [];
  const pending = [""];
  let directories = 0;
  while (pending.length) {
    const parent = pending.pop()!;
    const { resolvedTarget } = await assertContainedNoSymlinks(root, NodePath.join(root, parent));
    for (const entry of (await NodeFSP.readdir(resolvedTarget, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relativePath = validatePackagePath(parent ? parent + "/" + entry.name : entry.name);
      if (entry.isDirectory()) {
        if (++directories > 512) return { files, truncated: true };
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error("Unsupported package entry: " + relativePath);
      if (files.length >= limit) return { files, truncated: true };
      const stat = await NodeFSP.lstat(NodePath.join(root, relativePath));
      const executable = (stat.mode & 0o111) !== 0;
      files.push({
        relativePath,
        sizeBytes: NonNegativeInt.make(stat.size),
        executable,
        kind:
          executable || relativePath.startsWith("scripts/")
            ? "script"
            : /\.(md|txt|rst)$/iu.test(relativePath)
              ? "doc"
              : "asset",
      });
    }
  }
  return { files, truncated: false };
}

export async function loadPackage(root: string) {
  const listing = await listPackageFiles(root);
  if (
    listing.truncated ||
    listing.files.reduce((n, file) => n + file.sizeBytes, 0) > MAX_PACKAGE_BYTES
  )
    throw new Error("Package exceeds size or entry limits.");
  const files: HarnessPackageFile[] = [];
  let total = 0;
  for (const { relativePath } of listing.files) {
    const file = await readPackageFile(root, relativePath);
    total += file.bytes.length;
    if (total > MAX_PACKAGE_BYTES) throw new Error("Package exceeds size limit.");
    files.push({
      relativePath,
      encoding: "base64",
      content: file.bytes.toString("base64"),
      executable: file.executable,
    });
  }
  return files;
}

function decodePackageFile(file: HarnessPackageFile) {
  const bytes = Buffer.from(file.content, file.encoding ?? "utf8");
  if (
    bytes.length > MAX_FILE_BYTES ||
    (file.encoding === "base64" && bytes.toString("base64") !== file.content)
  )
    throw new Error("Invalid or oversized package content.");
  return bytes;
}

export async function replacePackage(
  root: string,
  target: string,
  files: readonly HarnessPackageFile[],
  validateManifest: (raw: string) => void,
) {
  if (!files.length || files.length > MAX_FILES) throw new Error("Invalid package file count.");
  await replaceDirectory(root, target, false, async (staged) => {
    let total = 0;
    let hasManifest = false;
    for (const file of files) {
      const dest = NodePath.join(staged, validatePackagePath(file.relativePath));
      const bytes = decodePackageFile(file);
      if ((total += bytes.length) > MAX_PACKAGE_BYTES)
        throw new Error("Package exceeds size limit.");
      if (file.relativePath === "SKILL.md") {
        if (bytes.length > 262144) throw new Error("Oversized skill manifest.");
        validateManifest(new TextDecoder("utf8", { fatal: true }).decode(bytes));
        hasManifest = true;
      }
      await NodeFSP.mkdir(NodePath.dirname(dest), { recursive: true });
      await NodeFSP.writeFile(dest, bytes, { flag: "wx", mode: 0o600 });
      await NodeFSP.chmod(dest, file.executable ? 0o755 : 0o644);
    }
    if (!hasManifest) throw new Error("Missing SKILL.md.");
  });
}
