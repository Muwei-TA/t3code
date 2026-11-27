import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { APP_BASE_NAME } from "../../branding";
import { useAtomValue } from "@effect/atom-react";
import { clientHostEnvironmentAtom } from "../../state/clientHostEnvironment";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";

export function WorkspaceStatus({
  hero = false,
  environmentId,
}: {
  hero?: boolean;
  environmentId?: EnvironmentId | null;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId ?? primaryId);
  const gt = useGT();
  const m = useMessages();
  const local = useAtomValue(clientHostEnvironmentAtom(environmentId ?? primaryId));
  const status = environment
    ? connectionStatusTitle(environment.connection, m)
    : gt("Disconnected");
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-3xs leading-4 tracking-widest text-muted-foreground uppercase">
      <span
        aria-hidden
        className={
          environment?.connection.phase === "connected"
            ? "size-1.5 shrink-0 rounded-full bg-foreground/80"
            : "size-1.5 shrink-0 rounded-full border border-current"
        }
      />
      <span className="truncate">
        {hero ? (
          <>
            {APP_BASE_NAME} · {local ? gt("Local workspace") : gt("Workspace")}
          </>
        ) : (
          (environment?.label ?? gt("Workspace"))
        )}
      </span>
      {hero ? (
        <span className="sr-only">{status}</span>
      ) : (
        <span className="ml-auto shrink-0">{status}</span>
      )}
    </div>
  );
}
