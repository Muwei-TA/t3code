// @effect-diagnostics nodeBuiltinImport:off -- Uses node:fs/promises and node:path for deterministic portable markdown memory storage.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  HarnessError,
  type HarnessMemoryEntry,
  HarnessMemoryId,
  type HarnessMemoryRemoveInput,
  type HarnessMemorySnapshot,
  type HarnessMemoryUpsertInput,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";

import * as HarnessStore from "./HarnessStore.ts";

const decodeMemoryId = Schema.decodeUnknownOption(HarnessMemoryId);
const decodeIsoDateTime = Schema.decodeUnknownOption(IsoDateTime);

function splitFrontmatter(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  try {
    const parsed = YAML.parse(match[1] ?? "");
    const frontmatter =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: match[2] ?? "" };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

function serializeMemoryFile(input: {
  readonly id: HarnessMemoryId;
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly pinned: boolean;
  readonly updatedAt: IsoDateTime;
  readonly body: string;
}): string {
  const frontmatter = YAML.stringify({
    id: input.id,
    title: input.title,
    tags: [...input.tags],
    pinned: input.pinned,
    updatedAt: input.updatedAt,
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${input.body.trimEnd()}\n`;
}

export interface HarnessMemoryStoreShape {
  readonly getSnapshot: () => Effect.Effect<HarnessMemorySnapshot, HarnessError>;
  readonly upsertMemory: (
    input: HarnessMemoryUpsertInput,
  ) => Effect.Effect<HarnessMemorySnapshot, HarnessError>;
  readonly removeMemory: (
    input: HarnessMemoryRemoveInput,
  ) => Effect.Effect<HarnessMemorySnapshot, HarnessError>;
  readonly searchMemory: (input: {
    readonly query?: string | undefined;
    readonly tag?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<HarnessMemoryEntry>, HarnessError>;
  readonly readMemory: (
    id: string,
  ) => Effect.Effect<Option.Option<HarnessMemoryEntry>, HarnessError>;
}

export class HarnessMemoryStore extends Context.Service<
  HarnessMemoryStore,
  HarnessMemoryStoreShape
>()("t3/harness/HarnessMemoryStore") {}

export const layer = Layer.effect(
  HarnessMemoryStore,
  Effect.gen(function* () {
    const store = yield* HarnessStore.HarnessStore;
    const memoryDir = () => NodePath.join(store.harnessDir, "memory");

    const readPolicy = () =>
      store
        .resolveWorkspace()
        .pipe(Effect.map((workspace) => workspace.managedPolicyAllowsHarness));

    const loadAllEntries = Effect.fn("HarnessMemoryStore.loadAllEntries")(function* () {
      const dir = memoryDir();
      const nowIso = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
      return yield* Effect.tryPromise({
        try: async (): Promise<ReadonlyArray<HarnessMemoryEntry>> => {
          const entries: Array<HarnessMemoryEntry> = [];
          const dirents = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const dirent of dirents) {
            if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
            const stem = dirent.name.slice(0, -3).toLowerCase();
            const filePath = NodePath.join(dir, dirent.name);
            const raw = await NodeFSP.readFile(filePath, "utf8");
            const stat = await NodeFSP.stat(filePath);
            const { frontmatter, body } = splitFrontmatter(raw);
            const idOpt = decodeMemoryId(
              typeof frontmatter.id === "string" ? frontmatter.id : stem,
            );
            if (Option.isNone(idOpt)) continue;
            const titleRaw =
              typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0
                ? frontmatter.title.trim()
                : idOpt.value;
            const tags = Array.isArray(frontmatter.tags)
              ? frontmatter.tags
                  .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
                  .map((tag) => TrimmedNonEmptyString.make(tag.trim()))
              : [];
            const pinned = frontmatter.pinned === true;
            const updatedAtOpt = decodeIsoDateTime(frontmatter.updatedAt);
            const updatedAt = Option.isSome(updatedAtOpt)
              ? updatedAtOpt.value
              : IsoDateTime.make(stat.mtime.toISOString() || nowIso);
            entries.push({
              id: idOpt.value,
              title: TrimmedNonEmptyString.make(titleRaw),
              tags,
              pinned,
              body: body.trim(),
              bytes: NonNegativeInt.make(Buffer.byteLength(raw, "utf8")),
              sourcePath: filePath,
              updatedAt,
            });
          }
          entries.sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return b.updatedAt.localeCompare(a.updatedAt);
          });
          return entries;
        },
        catch: (error) =>
          new HarnessError({
            code: "io_error",
            detail: `Failed to read portable memory directory: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
    });

    const getSnapshot = Effect.fn("HarnessMemoryStore.getSnapshot")(function* () {
      const managedPolicyAllowsHarness = yield* readPolicy();
      const entries = managedPolicyAllowsHarness ? yield* loadAllEntries() : [];
      return {
        memoryDir: memoryDir(),
        entries,
        managedPolicyAllowsHarness,
      } satisfies HarnessMemorySnapshot;
    });

    return HarnessMemoryStore.of({
      getSnapshot,
      upsertMemory: Effect.fn("HarnessMemoryStore.upsertMemory")(function* (input) {
        const allowed = yield* readPolicy();
        if (!allowed) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness memory is disabled by managed policy.",
          });
        }
        const dir = memoryDir();
        const filePath = NodePath.join(dir, `${input.id}.md`);
        const updatedAt = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
        const normalizedTags = Array.from(
          new Set((input.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0)),
        );
        const content = serializeMemoryFile({
          id: input.id,
          title: input.title,
          tags: normalizedTags,
          pinned: input.pinned === true,
          updatedAt,
          body: input.body,
        });
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(dir, { recursive: true });
            await NodeFSP.writeFile(filePath, content, "utf8");
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to write memory "${input.id}": ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        return yield* getSnapshot();
      }),
      removeMemory: Effect.fn("HarnessMemoryStore.removeMemory")(function* (input) {
        const allowed = yield* readPolicy();
        if (!allowed) {
          return yield* new HarnessError({
            code: "policy_denied",
            detail: "Portable harness memory is disabled by managed policy.",
          });
        }
        const filePath = NodePath.join(memoryDir(), `${input.id}.md`);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.rm(filePath, { force: true });
          },
          catch: (error) =>
            new HarnessError({
              code: "io_error",
              detail: `Failed to remove memory "${input.id}": ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        return yield* getSnapshot();
      }),
      searchMemory: Effect.fn("HarnessMemoryStore.searchMemory")(function* (input) {
        const allowed = yield* readPolicy();
        if (!allowed) return [];
        const entries = yield* loadAllEntries();
        const query = (input.query ?? "").trim().toLowerCase();
        const tagFilter = (input.tag ?? "").trim().toLowerCase();
        const limit = Math.max(1, Math.min(50, input.limit ?? 15));
        const terms = query.split(/[^a-z0-9_-]+/u).filter(Boolean);

        const filtered = entries.filter((entry) =>
          tagFilter.length === 0 ? true : entry.tags.some((t) => t.toLowerCase() === tagFilter),
        );
        if (terms.length === 0) {
          return filtered.slice(0, limit);
        }
        return filtered
          .map((entry) => {
            const haystack =
              `${entry.id} ${entry.title} ${entry.tags.join(" ")} ${entry.body}`.toLowerCase();
            let score = entry.pinned ? 5 : 0;
            for (const term of terms) {
              if (entry.id.toLowerCase() === term) score += 100;
              else if (entry.title.toLowerCase().includes(term)) score += 20;
              else if (entry.tags.some((t) => t.toLowerCase().includes(term))) score += 15;
              else if (haystack.includes(term)) score += 3;
            }
            return { entry, score };
          })
          .filter((item) => item.score > (item.entry.pinned ? 5 : 0))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((item) => item.entry);
      }),
      readMemory: Effect.fn("HarnessMemoryStore.readMemory")(function* (id) {
        const allowed = yield* readPolicy();
        if (!allowed) return Option.none();
        const entries = yield* loadAllEntries();
        const needle = id.trim().toLowerCase();
        const match = entries.find(
          (entry) => entry.id.toLowerCase() === needle || entry.title.toLowerCase() === needle,
        );
        return match ? Option.some(match) : Option.none();
      }),
    });
  }),
);
