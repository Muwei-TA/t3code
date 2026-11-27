import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { isElectron } from "../../env";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { HarnessLibraryPanels } from "../settings/HarnessLibraryTabs";
import { HarnessMemoryTab, HarnessSyncTab } from "../settings/HarnessMemoryAndSyncTabs";
import { HarnessHooksTab, HarnessPluginsTab } from "../settings/HarnessPluginsAndHooksTabs";
import { EnvironmentHarnessMcpSection } from "../settings/HarnessSettings";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { SettingsScopeProvider, useSettingsScope } from "../settings/SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HarnessAgentAction } from "./HarnessAgentAction";
import { harnessDomains, type HarnessDomain } from "./harnessNavigation";

function HarnessDelivery({
  environmentId,
  tab,
}: {
  environmentId: EnvironmentId;
  tab: HarnessDomain;
}) {
  const gt = useGT();
  const canRead = useAtomValue(harnessEnvironment.getDeliveryMatrix.permissionAtom(environmentId));
  const matrix = useEnvironmentQuery(
    canRead ? harnessEnvironment.deliveryMatrixQuery({ environmentId, input: {} }) : null,
  );
  const labels = {
    native: gt("Native"),
    "conditional-native": gt("Conditional native"),
    gateway: gt("Gateway"),
    hybrid: gt("Hybrid"),
  };
  return (
    <section aria-label={gt("Provider delivery")} className="flex flex-wrap gap-2">
      {matrix.error ? <p role="alert">{matrix.error}</p> : null}
      {matrix.data?.map((row) => {
        const label = (
          <>
            {row.displayName} ·{" "}
            {tab === "context"
              ? row.readsProjectAgentsMd
                ? gt("Reads project AGENTS.md")
                : gt("No native AGENTS.md")
              : tab === "guardrails"
                ? row.toolHooksDelivery === "native"
                  ? gt("Native tool hooks")
                  : gt("Gateway & lifecycle")
                : labels[tab === "skills" ? row.skillDelivery : row.mcpDelivery]}
          </>
        );
        return row.notes ? (
          <Tooltip key={row.providerInstanceId}>
            <TooltipTrigger render={<Badge variant="outline" />} tabIndex={0}>
              {label}
            </TooltipTrigger>
            <TooltipPopup>{row.notes}</TooltipPopup>
          </Tooltip>
        ) : (
          <Badge key={row.providerInstanceId} variant="outline">
            {label}
          </Badge>
        );
      })}
    </section>
  );
}

function HarnessContent({ tab }: { tab: HarnessDomain | "sync" }) {
  const gt = useGT();
  const { scope, environment } = useSettingsScope();
  const [revision, setRevision] = useState(0);
  if (
    !environment ||
    environment.connection.phase !== "connected" ||
    scope.kind === "unavailable"
  ) {
    return (
      <p>
        <T>Connect an environment to configure portable MCP servers and harness extensions.</T>
      </p>
    );
  }
  const workspaceRoot =
    scope.kind === "checkout"
      ? scope.checkout.workspaceRoot
      : scope.kind === "project"
        ? scope.members.find((member) => member.environmentId === environment.environmentId)
            ?.workspaceRoot
        : undefined;
  const environmentId = environment.environmentId;
  const props = { environmentId, workspaceRoot };
  const library = (panel: "skills" | "approvals" | "rules" | "modes" | "commands" | "transfer") => (
    <HarnessLibraryPanels {...props} activeTab={panel} />
  );
  return (
    <div
      key={JSON.stringify([environmentId, workspaceRoot, revision])}
      className="flex min-w-0 flex-col gap-5"
    >
      {tab === "sync" ? (
        <>
          <p className="text-sm text-muted-foreground">
            <T>
              CLI migration preserves skill files and executable permissions. Sync flags binary
              files as unscannable-binary when it cannot check them for secrets.
            </T>
          </p>
          <HarnessSyncTab environmentId={environmentId} />
          {library("transfer")}
        </>
      ) : (
        <>
          <div>
            <HarnessAgentAction
              {...props}
              domain={tab}
              label={
                tab === "guardrails"
                  ? gt("Create Hook with Agent")
                  : tab === "context"
                    ? gt("Edit with Agent")
                    : gt("Add with Agent")
              }
              {...(tab === "skills"
                ? { onInstalled: () => setRevision((value) => value + 1) }
                : {})}
            />
          </div>
          <HarnessDelivery environmentId={environmentId} tab={tab} />
          {tab === "skills" ? (
            <>
              {library("skills")}
              <HarnessPluginsTab environmentId={environmentId} />
            </>
          ) : tab === "tools" ? (
            <EnvironmentHarnessMcpSection environment={environment} workspaceRoot={workspaceRoot} />
          ) : tab === "guardrails" ? (
            <>
              <HarnessHooksTab environmentId={environmentId} />
              {library("approvals")}
            </>
          ) : (
            <>
              {library("rules")}
              {library("modes")}
              {library("commands")}
              <HarnessMemoryTab environmentId={environmentId} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function HarnessMigration() {
  return (
    <SettingsPageContainer>
      <HarnessContent tab="sync" />
    </SettingsPageContainer>
  );
}

export function HarnessWorkbench() {
  const search = useSearch({ from: "/_chat/harness" });
  const navigate = useNavigate();
  const m = useMessages();
  const { tab = "skills", ...scope } = search;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="justify-between border-b">
        <h1 className="text-base font-semibold">
          <T>Harness</T>
        </h1>
        <Button size="sm" variant="outline" render={<Link to="/settings/sync" search={scope} />}>
          <T>Sync & Migration</T>
        </Button>
      </WorkspacePageHeader>
      <SettingsScopeProvider
        singleEnvironment
        search={scope}
        onChange={(next) => void navigate({ to: "/harness", search: { ...next, tab } })}
      >
        <SettingsPageContainer width="wide">
          <nav className="flex flex-wrap gap-2">
            {harnessDomains.map((domain) => (
              <Button
                key={domain.tab}
                size="sm"
                variant={domain.tab === tab ? "default" : "outline"}
                render={<Link to="/harness" search={{ ...scope, tab: domain.tab }} />}
              >
                {m(domain.title)}
              </Button>
            ))}
          </nav>
          <HarnessContent key={tab} tab={tab} />
        </SettingsPageContainer>
      </SettingsScopeProvider>
    </SidebarInset>
  );
}
