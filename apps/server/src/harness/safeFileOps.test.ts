// @effect-diagnostics nodeBuiltinImport:off -- The test controls the opened file descriptor to change its size on the first read.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { readContainedFile, replaceDirectory, safeWriteFileAtomic } from "./safeFileOps.ts";

vi.mock("node:fs/promises", { spy: true });

it("bounds each read to the opened size and rejects growth during the read", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-fd-"));
  try {
    const file = NodePath.join(root, "member");
    await NodeFSP.writeFile(file, "abc");
    const handle = await NodeFSP.open(file, "r");
    const open = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    const opened: NodeFSP.FileHandle[] = [];
    using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (target, ...args) => {
      const result =
        target === (await NodeFSP.realpath(file)) ? handle : await open.open(target, ...args);
      opened.push(result);
      return result;
    });
    const read = handle.read.bind(handle);
    const reads = vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      await NodeFSP.appendFile(file, "d");
      return read(...args);
    });
    await expect(readContainedFile(root, file, 3)).rejects.toThrow("changed while reading");
    expect(reads).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 3, 0);
    expect(opened.length).toBeGreaterThan(1);
    expect(opened.every((file) => file.fd === -1)).toBe(true);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects a changed parent identity, removes temporary files and restores a failed directory publication", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-publish-"));
  try {
    const target = NodePath.join(root, "package");
    await NodeFSP.mkdir(target);
    const file = NodePath.join(target, "keep");
    await NodeFSP.writeFile(file, "previous");
    const fail = async () => {
      throw new Error("precondition failed");
    };
    await expect(safeWriteFileAtomic(root, file, "new", undefined, fail)).rejects.toThrow(
      "precondition failed",
    );
    const original = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    const canonicalParent = await original.realpath(target);
    const otherDirectory = await original.lstat(root);
    let changed = false;
    using _stat = vi.spyOn(NodeFSP, "lstat").mockImplementation(async (...args) => {
      if (changed && args[0] === canonicalParent) {
        changed = false;
        return otherDirectory;
      }
      return original.lstat(...args);
    });
    await expect(
      safeWriteFileAtomic(root, file, "discard", undefined, async () => {
        changed = true;
      }),
    ).rejects.toThrow("Directory changed");
    await expect(replaceDirectory(root, target, false, async () => {}, fail)).rejects.toThrow(
      "precondition failed",
    );
    expect(await NodeFSP.readFile(file, "utf8")).toBe("previous");
    expect(await NodeFSP.readdir(root)).toEqual(["package"]);
    expect(await NodeFSP.readdir(target)).toEqual(["keep"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
