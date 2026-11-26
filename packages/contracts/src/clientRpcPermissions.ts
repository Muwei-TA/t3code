import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import { HarnessHookUpsertInput, HarnessMcpUpsertInput } from "./harness.ts";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  // An MCP sign-in stores a credential for the agent, as an account sign-in does.
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  // A tracker credential and a project's binding are settings, saved under the same grant.
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.workspaceAddTaskFolderRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // An answer, a resume and a cancel each decide what a run's agents do next.
  [WS_METHODS.workflowsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCancel]: AuthOrchestrationOperateScope,
  // The server runs this file: saving it is running code there, as a terminal does.
  [WS_METHODS.workflowsSaveDefinition]: AuthTerminalOperateScope,
  [WS_METHODS.workflowsDeleteDefinition]: AuthTerminalOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairClient]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairLink]: AuthAccessWriteScope,
  // Send stores and sends a report from a thread's turn: the bar of running that thread.
  [WS_METHODS.agentFeedbackAnswerRequest]: AuthOrchestrationOperateScope,
  // Portable harness MCP, library & export mutations: stdio/secret/export actions also enforce scopes server-side.
  [WS_METHODS.harnessMcpLogs]: AuthDiagnosticsReadScope,
  [WS_METHODS.harnessMcpScanImports]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMcpUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMcpRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMcpSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMcpTrustProjectServer]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMcpRevokeProjectTrust]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMcpRestart]: AuthOrchestrationOperateScope,
  [WS_METHODS.harnessMcpOAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.harnessMcpOAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.harnessMcpOAuthDisconnect]: AuthProvidersManageScope,
  [WS_METHODS.harnessMcpApplyImports]: AuthSettingsWriteScope,
  [WS_METHODS.harnessAgentsMdSave]: AuthSettingsWriteScope,
  [WS_METHODS.harnessSkillUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessSkillRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessSkillSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessRuleUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessRuleRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessRuleSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessCommandUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessCommandRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessCommandSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessSettingsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.harnessLibraryScanImports]: AuthSettingsWriteScope,
  [WS_METHODS.harnessLibraryApplyImports]: AuthSettingsWriteScope,
  [WS_METHODS.harnessExportPreview]: AuthSettingsWriteScope,
  [WS_METHODS.harnessExportApply]: AuthProvidersManageScope,
  [WS_METHODS.harnessModeUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessModeRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessModeSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessApprovalRuleRevoke]: AuthOrchestrationOperateScope,
  [WS_METHODS.harnessPluginInstall]: AuthSettingsWriteScope,
  [WS_METHODS.harnessPluginTrust]: AuthSettingsWriteScope,
  [WS_METHODS.harnessPluginSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessPluginRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessPluginReload]: AuthSettingsWriteScope,
  [WS_METHODS.harnessHookUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessHookRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessHookSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.harnessHookTest]: AuthSettingsWriteScope,
  [WS_METHODS.harnessWorkflowValidate]: AuthOrchestrationReadScope,
  [WS_METHODS.harnessMemoryUpsert]: AuthSettingsWriteScope,
  [WS_METHODS.harnessMemoryRemove]: AuthSettingsWriteScope,
  [WS_METHODS.harnessSyncConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.harnessSyncPreviewPush]: AuthOrchestrationReadScope,
  [WS_METHODS.harnessSyncPush]: AuthSourceControlWriteScope,
  [WS_METHODS.harnessSyncPull]: AuthSourceControlWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeHarnessUpsert = Schema.decodeUnknownOption(HarnessMcpUpsertInput);
const decodeHookUpsert = Schema.decodeUnknownOption(HarnessHookUpsertInput);

const HARNESS_SECRET_PLACEHOLDER = /\$\{secret:/;

function harnessTransportHasSecretPlaceholder(
  transport: HarnessMcpUpsertInput["config"]["transport"],
): boolean {
  const record = transport.type === "stdio" ? transport.env : transport.headers;
  return (
    record !== undefined && Object.values(record).some((v) => HARNESS_SECRET_PLACEHOLDER.test(v))
  );
}

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  if (method === WS_METHODS.harnessMcpUpsert && input !== undefined) {
    const parsed = decodeHarnessUpsert(input);
    if (parsed._tag === "Some") {
      const scopes: Array<AuthEnvironmentScope> = [AuthSettingsWriteScope];
      if (parsed.value.config.transport.type === "stdio") {
        scopes.push(AuthTerminalOperateScope);
      }
      if (harnessTransportHasSecretPlaceholder(parsed.value.config.transport)) {
        scopes.push(AuthProvidersManageScope);
      }
      return scopes;
    }
  }
  if (method === WS_METHODS.harnessExportApply) {
    return [AuthSettingsWriteScope, AuthProvidersManageScope];
  }
  if (method === WS_METHODS.harnessHookUpsert) {
    const parsed = decodeHookUpsert(input);
    if (parsed._tag === "Some" && parsed.value.target.type === "command") {
      return [AuthSettingsWriteScope, AuthTerminalOperateScope];
    }
  }
  if (method === WS_METHODS.harnessHookTest) {
    return [AuthSettingsWriteScope, AuthTerminalOperateScope];
  }
  if (method === WS_METHODS.harnessSyncPush || method === WS_METHODS.harnessSyncPull) {
    return [AuthSettingsWriteScope, AuthSourceControlWriteScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
