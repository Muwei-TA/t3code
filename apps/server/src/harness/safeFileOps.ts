// @effect-diagnostics nodeBuiltinImport:off -- Symlink-safe canonical root containment and O_NOFOLLOW file operations for portable Harness storage.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const O_NOFOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Verifies that `rootDir` exists (creating it if `createRoot` is true) and is not a symlink,
 * then walks every path segment from `rootDir` to `targetPath` rejecting any symlink or `..` escape.
 */
export async function assertContainedNoSymlinks(
  rootDir: string,
  targetPath: string,
  options?: { readonly createRoot?: boolean | undefined },
): Promise<{ readonly canonicalRoot: string; readonly resolvedTarget: string }> {
  const absRoot = NodePath.resolve(rootDir);
  if (options?.createRoot) {
    // Check existing root before mkdir so an existing symlink root is rejected immediately.
    const existingRootStat = await NodeFSP.lstat(absRoot).catch(() => null);
    if (existingRootStat?.isSymbolicLink()) {
      throw new Error(`Refusing symlinked root directory: ${absRoot}`);
    }
    await NodeFSP.mkdir(absRoot, { recursive: true });
  } else {
    const existingRootStat = await NodeFSP.lstat(absRoot).catch(() => null);
    if (existingRootStat?.isSymbolicLink()) {
      throw new Error(`Refusing symlinked root directory: ${absRoot}`);
    }
  }

  const canonicalRoot = await NodeFSP.realpath(absRoot);
  const absTarget = NodePath.resolve(targetPath);
  const relFromAbs = NodePath.relative(absRoot, absTarget);
  const relFromCanonical = NodePath.relative(canonicalRoot, absTarget);
  const rel =
    !relFromCanonical.startsWith("..") && !NodePath.isAbsolute(relFromCanonical)
      ? relFromCanonical
      : relFromAbs;

  if (rel.startsWith("..") || NodePath.isAbsolute(rel)) {
    throw new Error(`Path escapes allowed root directory: ${targetPath}`);
  }

  const segments = rel
    .split(NodePath.sep)
    .filter((segment) => segment.length > 0 && segment !== ".");
  let current = canonicalRoot;
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(`Path traversal segment rejected: ${targetPath}`);
    }
    current = NodePath.join(current, segment);
    const st = await NodeFSP.lstat(current).catch((error) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (st?.isSymbolicLink()) {
      throw new Error(`Refusing to follow symbolic link at ${current}`);
    }
  }

  return { canonicalRoot, resolvedTarget: current };
}

/** Creates directories segment-by-segment inside `rootDir`, refusing any symlink segment. */
async function safeEnsureDir(rootDir: string, dirPath: string): Promise<string> {
  const { canonicalRoot, resolvedTarget } = await assertContainedNoSymlinks(rootDir, dirPath, {
    createRoot: true,
  });
  const rel = NodePath.relative(canonicalRoot, resolvedTarget);
  const segments = rel
    .split(NodePath.sep)
    .filter((segment) => segment.length > 0 && segment !== ".");
  let current = canonicalRoot;
  for (const segment of segments) {
    current = NodePath.join(current, segment);
    const st = await NodeFSP.lstat(current).catch((error) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (st === null) {
      await NodeFSP.mkdir(current);
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing non-directory or symlink path segment at ${current}`);
    }
  }
  return current;
}

/** Reads a UTF-8 file strictly contained inside `rootDir`, opening with `O_NOFOLLOW`. */
export async function safeReadFileUtf8(rootDir: string, targetPath: string): Promise<string> {
  const { resolvedTarget } = await assertContainedNoSymlinks(rootDir, targetPath);
  const handle = await NodeFSP.open(resolvedTarget, NodeFS.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Refusing non-regular file: ${resolvedTarget}`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/** Atomically writes a regular file inside `rootDir`, rejecting symlinks on all ancestors and target. */
export async function safeWriteFileAtomic(
  rootDir: string,
  targetPath: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<string> {
  const parentDir = NodePath.dirname(NodePath.resolve(targetPath));
  const safeParent = await safeEnsureDir(rootDir, parentDir);
  const safeTarget = NodePath.join(safeParent, NodePath.basename(targetPath));
  await assertContainedNoSymlinks(rootDir, safeTarget);

  const existingTarget = await NodeFSP.lstat(safeTarget).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (existingTarget !== null && (existingTarget.isSymbolicLink() || !existingTarget.isFile())) {
    throw new Error(`Refusing to overwrite symlink or non-regular file: ${safeTarget}`);
  }

  const tmpPath = NodePath.join(
    safeParent,
    `.${NodePath.basename(safeTarget)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  const flags =
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | O_NOFOLLOW;
  const handle = await NodeFSP.open(tmpPath, flags, 0o600);
  try {
    await handle.writeFile(content);
    if (mode !== undefined) await handle.chmod(mode);
  } catch (error) {
    await handle.close().catch(() => {});
    await NodeFSP.unlink(tmpPath).catch(() => {});
    throw error;
  }
  await handle.close();

  try {
    // Re-verify right before rename to narrow TOCTOU window.
    await assertContainedNoSymlinks(rootDir, safeTarget);
    await NodeFSP.rename(tmpPath, safeTarget);
  } catch (error) {
    await NodeFSP.unlink(tmpPath).catch(() => {});
    throw error;
  }
  return safeTarget;
}

/** Removes a regular file inside `rootDir` without following symlinks on parent or target. */
export async function safeRemoveFile(rootDir: string, targetPath: string): Promise<void> {
  const { resolvedTarget } = await assertContainedNoSymlinks(rootDir, targetPath);
  const st = await NodeFSP.lstat(resolvedTarget).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing to remove symlink or non-regular file: ${resolvedTarget}`);
  }
  await NodeFSP.unlink(resolvedTarget);
}

export async function replaceDirectory(
  root: string,
  target: string,
  createOnly: boolean,
  populate: (staged: string) => Promise<void>,
) {
  const parent = await safeEnsureDir(root, NodePath.dirname(target));
  await assertContainedNoSymlinks(root, target);
  const stage = await NodeFSP.mkdtemp(NodePath.join(parent, ".install-"));
  const staged = NodePath.join(stage, "new");
  const backup = NodePath.join(stage, "old");
  let backedUp = false;
  try {
    await NodeFSP.mkdir(staged, { mode: 0o700 });
    await populate(staged);
    await assertContainedNoSymlinks(root, target);
    if (createOnly) {
      if (
        await NodeFSP.lstat(target).catch((error) => {
          if (isEnoent(error)) return null;
          throw error;
        })
      )
        throw new Error("Package id is already installed.");
    } else {
      try {
        await NodeFSP.rename(target, backup);
        backedUp = true;
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
    await NodeFSP.rename(staged, target);
    backedUp = false;
  } finally {
    if (backedUp) await NodeFSP.rename(backup, target);
    await NodeFSP.rm(stage, { recursive: true, force: true });
  }
}
