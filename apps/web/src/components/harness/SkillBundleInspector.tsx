import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type HarnessSkillEntry,
  type HarnessSkillFile,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { HarnessAgentAction } from "./HarnessAgentAction";

function FileTree({
  files,
  prefix,
  selected,
  onSelect,
}: {
  files: readonly HarnessSkillFile[];
  prefix: string;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const folders = new Map<string, HarnessSkillFile[]>();
  const leaves = [];
  for (const file of files) {
    const name = file.relativePath.slice(prefix.length);
    const slash = name.indexOf("/");
    if (slash < 0) leaves.push(file);
    else {
      const folder = name.slice(0, slash + 1);
      const children = folders.get(folder) ?? [];
      children.push(file);
      folders.set(folder, children);
    }
  }
  return (
    <ul className="space-y-1">
      {leaves.map((file) => (
        <li key={file.relativePath}>
          <button
            type="button"
            aria-current={file.relativePath === selected ? "true" : undefined}
            onClick={() => onSelect(file.relativePath)}
            className="break-all rounded px-2 py-1 text-start font-mono text-xs hover:bg-muted aria-current:bg-muted"
          >
            {file.relativePath.slice(prefix.length)}
            {file.executable ? " [+x]" : ""}
          </button>
        </li>
      ))}
      {Array.from(folders, ([name, children]) => (
        <li key={name}>
          <details open>
            <summary className="cursor-pointer font-mono text-xs">{name}</summary>
            <div className="ms-3 border-s ps-2">
              <FileTree
                files={children}
                prefix={prefix + name}
                selected={selected}
                onSelect={onSelect}
              />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function SkillBundleInspector({
  skill,
  environmentId,
  workspaceRoot,
}: {
  skill: HarnessSkillEntry;
  environmentId: EnvironmentId;
  workspaceRoot: string | undefined;
}) {
  const gt = useGT();
  const [path, setPath] = useState("SKILL.md");
  const files = skill.files?.some((file) => file.relativePath === "SKILL.md")
    ? skill.files
    : [
        {
          relativePath: "SKILL.md",
          executable: false,
          sizeBytes: skill.bytes,
          kind: "doc" as const,
        },
        ...(skill.files ?? []),
      ];
  const selected = files.find((file) => file.relativePath === path) ?? files[0]!;
  const canRead = useAtomValue(harnessEnvironment.readSkillFile.permissionAtom(environmentId));
  const preview = useEnvironmentQuery(
    canRead
      ? harnessEnvironment.skillFileQuery({
          environmentId,
          input: {
            id: skill.id,
            scope: skill.scope,
            ...(workspaceRoot ? { workspaceRoot } : {}),
            relativePath: selected.relativePath,
          },
        })
      : null,
  );
  return (
    <section aria-label={gt("Bundle inspector")} className="w-full space-y-3 border-t pt-3">
      <div className="flex flex-wrap gap-2">
        <HarnessAgentAction
          environmentId={environmentId}
          workspaceRoot={skill.scope === "project" ? workspaceRoot : undefined}
          domain="skills"
          label={gt("Ask Agent to Edit")}
          skillId={skill.id}
        />
        <Button size="sm" variant="outline" onClick={preview.refresh}>
          <T>Refresh preview</T>
        </Button>
      </div>
      {skill.companionTruncated ? (
        <p role="status" className="text-sm text-warning">
          <T>The server returned a partial file tree.</T>
        </p>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[minmax(10rem,1fr)_minmax(0,3fr)]">
        <FileTree files={files} prefix="" selected={selected.relativePath} onSelect={setPath} />
        <div className="min-w-0 space-y-2">
          <p className="break-all font-mono text-xs">{selected.relativePath}</p>
          {!canRead ? (
            <p>
              <T>File read access is required.</T>
            </p>
          ) : preview.error ? (
            <p role="alert">{preview.error}</p>
          ) : !preview.data ? (
            <p>
              <T>Loading file…</T>
            </p>
          ) : preview.data.binary ? (
            <p>
              {gt("Binary file · {type} · {bytes} bytes", {
                type:
                  selected.relativePath
                    .split("/")
                    .at(-1)
                    ?.match(/\.([^.]+)$/u)?.[1] ?? selected.kind,
                bytes: preview.data.sizeBytes,
              })}
            </p>
          ) : selected.relativePath.toLowerCase().endsWith(".md") ? (
            <ChatMarkdown
              text={preview.data.content ?? ""}
              cwd={undefined}
              environmentId={environmentId}
            />
          ) : (
            <pre className="max-h-96 overflow-auto p-2 text-xs">
              <code>{preview.data.content}</code>
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}
