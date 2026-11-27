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

async function statIfPresent(path: string) {
  return NodeFSP.lstat(path).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
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
  if ((await statIfPresent(absRoot))?.isSymbolicLink())
    throw new Error(`Refusing symlinked root directory: ${absRoot}`);
  if (options?.createRoot) await NodeFSP.mkdir(absRoot, { recursive: true });

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
    const st = await statIfPresent(current);
    if (st?.isSymbolicLink()) {
      throw new Error(`Refusing to follow symbolic link at ${current}`);
    }
  }

  return { canonicalRoot, resolvedTarget: current };
}

function sameFile(a: NodeFS.Stats, b: NodeFS.Stats) {
  return a.dev === b.dev && a.ino === b.ino;
}

async function withFileHandles<A>(use: (handles: NodeFSP.FileHandle[]) => Promise<A>) {
  const handles: NodeFSP.FileHandle[] = [];
  try {
    return await use(handles);
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

async function pinDirectory(path: string, handles: NodeFSP.FileHandle[]) {
  const before = await NodeFSP.lstat(path);
  if (!before.isDirectory()) throw new Error("Expected a non-symlink directory.");
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_DIRECTORY ?? 0) |
      O_NOFOLLOW |
      NodeFS.constants.O_NONBLOCK,
  );
  handles.push(handle);
  const opened = await handle.stat();
  if (!opened.isDirectory() || !sameFile(before, opened))
    throw new Error("Directory changed while opening.");
  return async () => {
    if (!sameFile(opened, await NodeFSP.lstat(path)) || (await NodeFSP.realpath(path)) !== path)
      throw new Error("Directory changed during file operation.");
  };
}

async function pinParent(
  rootDir: string,
  targetPath: string,
  create: boolean,
  handles: NodeFSP.FileHandle[],
) {
  const { canonicalRoot, resolvedTarget } = await assertContainedNoSymlinks(rootDir, targetPath, {
    createRoot: create,
  });
  if (resolvedTarget === canonicalRoot) throw new Error("Expected a target below the root.");
  const parent = NodePath.dirname(resolvedTarget);
  const verifyRoot = await pinDirectory(canonicalRoot, handles);
  const verifyRootPath = async () => {
    await verifyRoot();
    if (
      (await NodeFSP.realpath(rootDir)) !== canonicalRoot ||
      (await NodeFSP.lstat(rootDir)).isSymbolicLink()
    )
      throw new Error("Root directory changed during file operation.");
  };
  let verifyParent = verifyRootPath;
  if (parent !== canonicalRoot) {
    if (create) {
      let current = canonicalRoot;
      for (const segment of NodePath.relative(canonicalRoot, parent).split(NodePath.sep)) {
        await verifyParent();
        current = NodePath.join(current, segment);
        try {
          await NodeFSP.mkdir(current);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        verifyParent = await pinDirectory(current, handles);
      }
    } else {
      verifyParent = await pinDirectory(parent, handles);
    }
  }
  const verify = async () => {
    await verifyRootPath();
    if (parent !== canonicalRoot) await verifyParent();
  };
  await verify();
  return { resolvedTarget, parent, verify };
}

export async function readContainedFile(
  rootDir: string,
  targetPath: string,
  maxBytes = 8 * 1024 * 1024,
) {
  return withFileHandles(async (handles) => {
    const { resolvedTarget, verify: verifyParent } = await pinParent(
      rootDir,
      targetPath,
      false,
      handles,
    );
    const before = await NodeFSP.lstat(resolvedTarget);
    const handle = await NodeFSP.open(
      resolvedTarget,
      NodeFS.constants.O_RDONLY | O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Refusing non-regular file.");
      if (stat.size > maxBytes) throw new Error("Refusing oversized regular file.");
      if (before.dev !== stat.dev || before.ino !== stat.ino)
        throw new Error("File changed while opening.");
      const verify = async () => {
        await verifyParent();
        const fileNow = await NodeFSP.lstat(resolvedTarget);
        if (
          !sameFile(stat, fileNow) ||
          stat.size !== fileNow.size ||
          stat.ctimeMs !== fileNow.ctimeMs
        )
          throw new Error("File changed while reading.");
      };
      await verify();
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("File changed while reading.");
        offset += bytesRead;
      }
      await verify();
      return {
        bytes,
        mode: stat.mode & 0o777,
        executable: (stat.mode & 0o111) !== 0,
        executeBits: stat.mode & 0o111,
        path: resolvedTarget,
      };
    } finally {
      await handle.close();
    }
  });
}

export async function safeReadFileUtf8(rootDir: string, targetPath: string): Promise<string> {
  return (await readContainedFile(rootDir, targetPath)).bytes.toString("utf8");
}

/** Atomically writes a regular file inside `rootDir`, rejecting symlinks on all ancestors and target. */
export async function safeWriteFileAtomic(
  rootDir: string,
  targetPath: string,
  content: string | Uint8Array,
  mode?: number,
  beforePublish?: () => Promise<void>,
): Promise<string> {
  return withFileHandles(async (handles) => {
    const {
      resolvedTarget: safeTarget,
      parent: safeParent,
      verify,
    } = await pinParent(rootDir, targetPath, true, handles);
    const existingTarget = await statIfPresent(safeTarget);
    if (existingTarget !== null && (existingTarget.isSymbolicLink() || !existingTarget.isFile())) {
      throw new Error(`Refusing to overwrite symlink or non-regular file: ${safeTarget}`);
    }

    const tmpPath = NodePath.join(
      safeParent,
      `.${NodePath.basename(safeTarget)}.${NodeCrypto.randomUUID()}.tmp`,
    );
    const flags =
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | O_NOFOLLOW;
    await verify();
    const handle = await NodeFSP.open(tmpPath, flags, 0o600);
    handles.push(handle);
    const identity = await handle.stat();
    let published = false;
    try {
      await verify();
      await handle.writeFile(content);
      if (mode !== undefined) await handle.chmod(mode);
      await beforePublish?.();
      await verify();
      await assertContainedNoSymlinks(rootDir, safeTarget);
      if (!sameFile(identity, await NodeFSP.lstat(tmpPath)))
        throw new Error("Temporary file changed before publication.");
      await NodeFSP.rename(tmpPath, safeTarget);
      published = true;
      await verify();
      if (!sameFile(identity, await NodeFSP.lstat(safeTarget)))
        throw new Error("Published file changed.");
    } finally {
      if (!published) {
        await verify();
        if (sameFile(identity, await NodeFSP.lstat(tmpPath))) await NodeFSP.unlink(tmpPath);
      }
    }
    return safeTarget;
  });
}

/** Removes a regular file inside `rootDir` without following symlinks on parent or target. */
export async function safeRemoveFile(rootDir: string, targetPath: string): Promise<void> {
  const { resolvedTarget } = await assertContainedNoSymlinks(rootDir, targetPath);
  const st = await statIfPresent(resolvedTarget);
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing to remove symlink or non-regular file: ${resolvedTarget}`);
  }
  return withFileHandles(async (handles) => {
    const { verify } = await pinParent(rootDir, resolvedTarget, false, handles);
    if (!sameFile(st, await NodeFSP.lstat(resolvedTarget)))
      throw new Error("File changed before removal.");
    await NodeFSP.unlink(resolvedTarget);
    await verify();
  });
}

export async function replaceDirectory(
  root: string,
  target: string,
  createOnly: boolean,
  populate: (staged: string) => Promise<void>,
  verifyPrevious?: (backup: string) => Promise<void>,
) {
  return withFileHandles(async (handles) => {
    const { parent, resolvedTarget, verify } = await pinParent(root, target, true, handles);
    const stage = await NodeFSP.mkdtemp(NodePath.join(parent, ".install-"));
    const verifyStage = await pinDirectory(stage, handles);
    const check = async () => {
      await verify();
      await verifyStage();
    };
    const staged = NodePath.join(stage, "new");
    const backup = NodePath.join(stage, "old");
    let backedUp = false;
    try {
      await check();
      await NodeFSP.mkdir(staged, { mode: 0o700 });
      await withFileHandles(async (stageHandles) => {
        const verifyNew = await pinDirectory(staged, stageHandles);
        await populate(staged);
        await check();
        await verifyNew();
        await assertContainedNoSymlinks(root, resolvedTarget);
        if (createOnly) {
          if (await statIfPresent(resolvedTarget))
            throw new Error("Package id is already installed.");
        } else {
          try {
            await NodeFSP.rename(resolvedTarget, backup);
            backedUp = true;
          } catch (error) {
            if (verifyPrevious || !isEnoent(error)) throw error;
          }
          await check();
          if (verifyPrevious) await verifyPrevious(backup);
        }
        await check();
        await verifyNew();
        await NodeFSP.rename(staged, resolvedTarget);
        backedUp = false;
        await check();
      });
    } catch (error) {
      if (backedUp) {
        await check();
        if (await statIfPresent(resolvedTarget))
          throw new Error("Package target changed during rollback; recovery copy retained.");
        await NodeFSP.rename(backup, resolvedTarget);
        backedUp = false;
      }
      throw error;
    } finally {
      // A failed rollback leaves the recovery copy available.
      if (!backedUp) {
        await check();
        await NodeFSP.rm(stage, { recursive: true, force: true });
      }
    }
  });
}
