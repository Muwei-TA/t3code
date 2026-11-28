import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { use, useState } from "react";
import { isElectron } from "../../env";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { LightningShell } from "../lightning/shell";
import { AdvancedSettings } from "../settings/AdvancedSettings";
import { HarnessLibraryPanels } from "../settings/HarnessLibraryTabs";
import { HarnessMemoryTab, HarnessSyncTab } from "../settings/HarnessMemoryAndSyncTabs";
import { HarnessHooksTab, HarnessPluginsTab } from "../settings/HarnessPluginsAndHooksTabs";
import { EnvironmentHarnessMcpSection } from "../settings/HarnessSettings";
import { SettingsPageContainer, SettingsSearchTarget } from "../settings/settingsLayout";
import { SettingsScopeProvider, useSettingsScope } from "../settings/SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HarnessAgentAction } from "./HarnessAgentAction";
import { harnessDomain, harnessDomains, type HarnessDomain } from "./harnessNavigation";

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

function HarnessContextMemory({
  environmentId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  workspaceRoot: string | undefined;
}) {
  const library = useAtomValue(
    harnessEnvironment.libraryQuery({
      environmentId,
      input: workspaceRoot ? { workspaceRoot } : {},
    }),
  );
  // The settings anchor is consumed on mount, after the panels above it have their final height.
  return library._tag === "Initial" ? null : <HarnessMemoryTab environmentId={environmentId} />;
}

function HarnessContent({ tab }: { tab: HarnessDomain | "sync" }) {
  const gt = useGT();
  const lightning = use(LightningShell) === "lightning";
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
  const action = (domain: HarnessDomain, label: string) => (
    <div>
      <HarnessAgentAction
        {...props}
        domain={domain}
        label={label}
        {...(domain === "skills" && !lightning
          ? { onInstalled: () => setRevision((value) => value + 1) }
          : {})}
      />
    </div>
  );
  const delivery =
    tab === "sync" ? null : <HarnessDelivery environmentId={environmentId} tab={tab} />;
  const hooks = <HarnessHooksTab environmentId={environmentId} />;
  const plugins = <HarnessPluginsTab environmentId={environmentId} />;
  return (
    <div
      key={JSON.stringify([environmentId, workspaceRoot, revision])}
      className="flex min-w-0 flex-col gap-5"
    >
      {lightning ? null : delivery}
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
      ) : tab === "tools" ? (
        <>
          <EnvironmentHarnessMcpSection environment={environment} workspaceRoot={workspaceRoot} />
          {lightning ? (
            <AdvancedSettings
              title={gt("Skills & Plugins")}
              targetIds={["harness-skills", "harness-plugins"]}
            >
              <div className="space-y-4 py-3">
                <SettingsSearchTarget id="harness-skills">
                  {action("skills", gt("Edit with Agent"))}
                </SettingsSearchTarget>
                {plugins}
              </div>
            </AdvancedSettings>
          ) : null}
        </>
      ) : tab === "skills" ? (
        <>
          {action("skills", gt("Add with Agent"))}
          {library("skills")}
          {plugins}
        </>
      ) : tab === "guardrails" ? (
        lightning ? (
          <>
            {library("approvals")}
            <AdvancedSettings title={gt("Hooks")} targetIds={["harness-hooks"]}>
              <div className="space-y-4 py-3">
                {action("guardrails", gt("Create Hook with Agent"))}
                {hooks}
              </div>
            </AdvancedSettings>
          </>
        ) : (
          <>
            {action("guardrails", gt("Create Hook with Agent"))}
            {hooks}
            {library("approvals")}
          </>
        )
      ) : (
        <>
          {library("rules")}
          {lightning ? (
            <div className="divide-y divide-border/60">
              <AdvancedSettings title={gt("Modes")} targetIds={["harness-modes"]}>
                {library("modes")}
              </AdvancedSettings>
              <AdvancedSettings title={gt("Commands")} targetIds={["harness-commands"]}>
                {library("commands")}
              </AdvancedSettings>
              <AdvancedSettings title={gt("Portable Memory")} targetIds={["harness-memory"]}>
                <HarnessContextMemory {...props} />
              </AdvancedSettings>
            </div>
          ) : (
            <>
              {library("modes")}
              {library("commands")}
              <HarnessContextMemory {...props} />
            </>
          )}
        </>
      )}
      {lightning && delivery ? (
        <AdvancedSettings title={gt("Provider delivery")}>{delivery}</AdvancedSettings>
      ) : null}
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
  const shell = use(LightningShell);
  const { tab: requestedTab, ...scope } = search;
  const tab = harnessDomain(requestedTab, shell);
  const domains =
    shell === "classic"
      ? harnessDomains
      : harnessDomains.filter((domain) => domain.tab !== "skills");
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
            {domains.map((domain) => (
              <Button
                key={domain.tab}
                size="sm"
                aria-current={domain.tab === tab ? "page" : undefined}
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
