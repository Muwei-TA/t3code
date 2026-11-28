import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEnvironment } from "../../state/environments";
import { EnvironmentHarnessMcpSection } from "../settings/HarnessSettings";
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

export default function HarnessMcpDialog({
  environmentId,
  projectId,
  workspaceRoot,
  onClosed,
  focusComposer,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  workspaceRoot: string | undefined;
  onClosed: () => void;
  focusComposer: () => void;
}) {
  const gt = useGT();
  const environment = useEnvironment(environmentId);
  return (
    <Dialog
      defaultOpen
      onOpenChangeComplete={(open) => {
        if (!open) onClosed();
      }}
    >
      <DialogPopup
        className="max-w-3xl"
        finalFocus={() => {
          focusComposer();
          return false;
        }}
      >
        <DialogTitle className="sr-only">{gt("Tools (MCP)")}</DialogTitle>
        <DialogPanel className="mt-3">
          {environment?.connection.phase === "connected" ? (
            <EnvironmentHarnessMcpSection
              environment={environment}
              projectId={projectId}
              onThreadOpened={onClosed}
              workspaceRoot={workspaceRoot}
            />
          ) : (
            <p>
              <T>
                Connect an environment to configure portable MCP servers and harness extensions.
              </T>
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
