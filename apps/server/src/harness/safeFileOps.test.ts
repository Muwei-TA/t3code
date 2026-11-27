// @effect-diagnostics nodeBuiltinImport:off -- The test controls the opened file descriptor to change its size on the first read.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { readContainedFile } from "./safeFileOps.ts";

vi.mock("node:fs/promises", { spy: true });

it("bounds each read to the opened size and rejects growth during the read", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-fd-"));
  try {
    const file = NodePath.join(root, "member");
    await NodeFSP.writeFile(file, "abc");
    const handle = await NodeFSP.open(file, "r");
    vi.mocked(NodeFSP.open).mockResolvedValueOnce(handle);
    const read = handle.read.bind(handle);
    const reads = vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      await NodeFSP.appendFile(file, "d");
      return read(...args);
    });
    await expect(readContainedFile(root, file, 3)).rejects.toThrow("changed while reading");
    expect(reads).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 3, 0);
    expect(handle.fd).toBe(-1);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
