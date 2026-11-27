import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { type EnvironmentId, HarnessSkillId, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { harnessEnvironment } from "../../state/harness";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const decodeSkillId = Schema.decodeUnknownOption(HarnessSkillId);

const instructions = {
  skills:
    "Install or create the requested package using harness_install_skill or harness_install_plugin. Preserve companion files and executable permissions. Leave plugins awaiting owner trust.",
  tools: "Use harness_propose_mcp to submit the requested server for owner approval.",
  context:
    "Inspect the relevant context and use harness_manage_rule, harness_manage_mode, harness_manage_command or harness_memory_write for the requested change.",
  guardrails: "Use harness_propose_hook to submit a disabled hook for owner review.",
  workflows:
    "Generate and validate the workflow YAML with harness_manage_workflow, then save the valid definition.",
};

export function HarnessAgentAction({
  environmentId,
  workspaceRoot,
  domain,
  label,
  skillId,
  onInstalled,
}: {
  environmentId: EnvironmentId;
  workspaceRoot?: string | undefined;
  domain: keyof typeof instructions;
  label: string;
  skillId?: string;
  onInstalled?: () => void;
}) {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  const projects = useProjects().filter(
    (project) => project.archivedAt == null && project.environmentId === environmentId,
  );
  const project = workspaceRoot
    ? projects.find((item) => item.workspaceRoot === workspaceRoot)
    : projects[0];
  const newThread = useNewThreadHandler();
  const installSkill = useAtomCommand(harnessEnvironment.installSkillPackage);
  const installPlugin = useAtomCommand(harnessEnvironment.installPlugin);
  const allowSkillInstall = useAtomValue(
    harnessEnvironment.installSkillPackage.permissionAtom(environmentId),
  );
  const allowPluginInstall = useAtomValue(
    harnessEnvironment.installPlugin.permissionAtom(environmentId),
  );
  const refreshLibrary = useAtomRefresh(
    harnessEnvironment.libraryQuery({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    }),
  );
  const refreshPlugins = useAtomRefresh(
    harnessEnvironment.pluginsQuery({ environmentId, input: {} }),
  );
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(false);
  const [plugin, setPlugin] = useState(false);
  const [request, setRequest] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const id = decodeSkillId(path.trim().split(/[\\/]/u).filter(Boolean).at(-1));
  const start = async () => {
    if (!project || !request.trim()) return;
    const prompt = [
      "Use harness_inspect to inspect this environment's T3 Harness first.",
      instructions[domain],
      workspaceRoot
        ? "Project scope: " + workspaceRoot
        : "Target the user (global) Harness library.",
      ...(skillId ? ["Edit the existing skill: " + skillId] : []),
      "User request:",
      request.trim(),
    ].join("\n");
    setBusy(true);
    await newThread({ environmentId, projectId: project.id }, { prompt }).finally(() =>
      setBusy(false),
    );
  };
  const install = async () => {
    if (!path.trim() || (!plugin && id._tag === "None")) return;
    setError(null);
    const sourceDir = TrimmedNonEmptyString.make(path.trim());
    setBusy(true);
    const result = plugin
      ? await installPlugin({ environmentId, input: { sourcePath: sourceDir } })
      : id._tag === "Some"
        ? await installSkill({
            environmentId,
            input: {
              id: id.value,
              sourceDir,
              scope: workspaceRoot ? "project" : "user",
              ...(workspaceRoot ? { workspaceRoot } : {}),
            },
          })
        : null;
    setBusy(false);
    if (result?._tag === "Success") {
      setOpen(false);
      setPath("");
      if (plugin) refreshPlugins();
      else refreshLibrary();
      onInstalled?.();
    } else if (result && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Import failed"));
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant={skillId ? "outline" : "default"}
        onClick={() => {
          setLocal(false);
          setError(null);
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex min-w-0 flex-col gap-4">
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {onInstalled ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={local ? "outline" : "default"}
                    onClick={() => setLocal(false)}
                  >
                    <T>Create with Agent</T>
                  </Button>
                  <Button
                    size="sm"
                    variant={local ? "default" : "outline"}
                    onClick={() => setLocal(true)}
                  >
                    <T>Import local directory</T>
                  </Button>
                </div>
              ) : null}
              {local ? (
                <>
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      variant={plugin ? "outline" : "default"}
                      onClick={() => setPlugin(false)}
                    >
                      <T>Skill</T>
                    </Button>
                    <Button
                      size="xs"
                      variant={plugin ? "default" : "outline"}
                      onClick={() => setPlugin(true)}
                    >
                      <T>Plugin</T>
                    </Button>
                  </div>
                  <label className="flex min-w-0 flex-col gap-2">
                    <T>Directory on the selected server</T>
                    <Input value={path} onChange={(e) => setPath(e.target.value)} />
                  </label>
                  {!plugin && path.trim() && id._tag === "None" ? (
                    <p role="alert">
                      <T>The directory name must be a valid skill ID.</T>
                    </p>
                  ) : null}
                  <Button
                    disabled={
                      busy ||
                      (plugin ? !allowPluginInstall : !allowSkillInstall) ||
                      !path.trim() ||
                      (!plugin && id._tag === "None")
                    }
                    onClick={() => void install()}
                  >
                    <T>Import</T>
                  </Button>
                </>
              ) : (
                <>
                  <label className="flex min-w-0 flex-col gap-2">
                    <T>Paste a link or describe the change</T>
                    <Textarea
                      value={request}
                      onChange={(e) => setRequest(e.target.value)}
                      rows={3}
                    />
                  </label>
                  {project ? (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {project.workspaceRoot}
                    </p>
                  ) : (
                    <p>
                      <T>Add a project on this server to open an agent thread.</T>
                    </p>
                  )}
                  <Button
                    disabled={busy || !project || !request.trim()}
                    onClick={() => void start()}
                  >
                    <T>Open thread with instructions</T>
                  </Button>
                </>
              )}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
