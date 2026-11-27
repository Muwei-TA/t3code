import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import {
  CheckIcon,
  CircleAlertIcon,
  CompassIcon,
  MapIcon,
  Settings2Icon,
  WorkflowIcon,
} from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type HarnessModeId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadContextInspectorButton } from "./ThreadContextInspectorButton";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { resolveComposerTraitsInput } from "./composerProviderState";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

/**
 * The composer footer controls: the model picker (which also holds effort, speed and
 * permissions), mode controls and the overflow menu for blocks that do not fit. Rendered in the
 * expanded footer or the resting controls host.
 */
// Model and effort share one trigger; it stays filled while its popup is open.
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";

export interface ComposerPortableModeOption {
  readonly id: HarnessModeId;
  readonly name: string;
  readonly description?: string | undefined;
  readonly baseInteractionMode: ProviderInteractionMode;
  readonly readonly: boolean;
}

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  workspaceCwd: string | null;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  effortDisplay: EffortDisplay;
  /** The strip under a new thread names the permissions, so the row does not repeat them. */
  permissionsShownInStrip: boolean;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  interactionMode: ProviderInteractionMode;
  modeId: HarnessModeId;
  workflowModes: ChatComposerProps["workflowModes"];
  selectedWorkflow: ChatComposerProps["selectedWorkflow"];
  onSelectWorkflow: ChatComposerProps["onSelectWorkflow"];
  availableModes: ReadonlyArray<ComposerPortableModeOption>;
  showPlanModeToggle: boolean;
  planReadOnlyEnforcement: "native" | "advisory" | "none";
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  handleModeChange: (modeId: HarnessModeId, baseInteractionMode: ProviderInteractionMode) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    activeThreadId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    handleRuntimeModeChange,
    interactionMode,
    modeId,
    availableModes,
    showPlanModeToggle,
    planReadOnlyEnforcement,
    handleModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount: measuredHiddenBlockCount,
    iconOnlyBlockCount,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    overflowShowsPermissions,
    pickerOwnsModeShortcut,
  } = resolveComposerControlsOwnership({
    matchesDefault: accessMatchesDefault || props.permissionsShownInStrip,
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount,
  });
  const controlSize = composerControlsCollapsed ? "xs" : "sm";
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const applyThreadModelPick = useApplyThreadModelPick();
  const applyRouteThreadModelPick = useStableCallback(() => applyThreadModelPick(routeThreadRef));
  const traitsInput = resolveComposerTraitsInput({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server"
      ? { threadRef: routeThreadRef, onDraftModelOptionsChange: applyRouteThreadModelPick }
      : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
  });
  const effort = describeComposerEffort(traitsInput, props.effortDisplay, controlSize, m);
  const restingBlockDefs = showModeBlock
    ? [
        {
          id: "mode",
          content: (
            <ComposerFooterModeControls
              runtimeMode={compatibleRuntimeMode}
              runtimeModeOptions={compatibleRuntimeModeOptions}
              size={controlSize}
              hidden={composerControlsHidden || restingHiddenBlockCount > 0}
              accessDisplay={accessDisplay}
              emphasized={!accessMatchesDefault}
              onRuntimeModeChange={handleRuntimeModeChange}
            />
          ),
        },
      ]
    : [];
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      workspaceCwd={props.workspaceCwd}
      compact={false}
      isComposerOwned
      // The trigger grows away from this edge when its model or effort label changes.
      popupAlign={composerControlsCollapsed ? "start" : "end"}
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={controlSize}
      triggerClassName={cn(
        "group/model-trigger",
        MODEL_TRIGGER_STATES,
        composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
      )}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      triggerShortcuts={
        pickerOwnsModeShortcut ? "composer.effort composer.mode" : "composer.effort"
      }
      effortColumn={<ComposerEffortColumn traits={traitsInput} />}
      footer={
        <ComposerPickerFooter
          traits={traitsInput}
          runtimeMode={compatibleRuntimeMode}
          runtimeModeOptions={compatibleRuntimeModeOptions}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      }
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName
        ? { activeProviderIconClassName: modelPickerIconClassName }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
    />
  );
  const isPlanMode = interactionMode === "plan";
  const activeModeOption =
    availableModes.find((mode) => mode.id === modeId) ??
    availableModes.find((mode) => mode.id === (isPlanMode ? "plan" : "build")) ??
    null;
  const activeModeLabel =
    props.selectedWorkflow?.name ??
    (isPlanMode && planReadOnlyEnforcement === "advisory"
      ? `${activeModeOption?.name ?? gt("Plan", { $context: "composer mode toggle" })} (${gt("advisory")})`
      : (activeModeOption?.name ??
        (isPlanMode
          ? gt("Plan", { $context: "composer mode toggle" })
          : gt("Build", { $context: "composer mode toggle" }))));
  const isNonDefaultMode = props.selectedWorkflow != null || modeId !== "build" || isPlanMode;
  const modeTooltip = isPlanMode
    ? planReadOnlyEnforcement === "advisory"
      ? gt(
          "Plan mode active (advisory read-only): T3 harness MCP write tools are blocked; native provider tools follow provider instructions. Press Shift+Tab to cycle modes.",
        )
      : gt(
          "Plan mode active: read-only planning before implementation. Press Shift+Tab to cycle modes.",
        )
    : activeModeOption?.description
      ? `${activeModeOption.name}: ${activeModeOption.description} (${gt("Shift+Tab to cycle")})`
      : gt("Switch portable mode (Shift+Tab to cycle)");

  return showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? gt("Open provider settings") : gt("No provider available")}
    </ComposerControl>
  ) : (
    <>
      {composerModelPicker}

      {!composerControlsHidden &&
      (showPlanModeToggle ||
        availableModes.length > 1 ||
        props.workflowModes != null ||
        props.selectedWorkflow != null) ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <ComposerControl
                      type="button"
                      size={controlSize}
                      aria-label={gt("Switch portable mode ({mode})", { mode: activeModeLabel })}
                      data-composer-plan-mode={isPlanMode ? "plan" : "default"}
                      data-composer-mode-id={props.selectedWorkflow == null ? modeId : "workflow"}
                      data-composer-shortcut="workflow"
                      className={cn("shrink-0", isNonDefaultMode && "bg-accent text-foreground")}
                    />
                  }
                />
              }
            >
              <ComposerControlIcon
                icon={
                  props.selectedWorkflow != null ? WorkflowIcon : isPlanMode ? MapIcon : CompassIcon
                }
                size={controlSize}
                {...(isNonDefaultMode ? { className: "text-current" } : {})}
              />
              <span data-composer-control-label>{activeModeLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{modeTooltip}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="start" side="top" className="min-w-60">
            <div className="flex items-center justify-between px-2 py-1 text-2xs text-muted-foreground">
              <span>{gt("Portable Mode")}</span>
              <span className="font-mono">{gt("Shift+Tab")}</span>
            </div>
            <MenuSeparator />
            {availableModes.map((mode) => {
              const selected = props.selectedWorkflow == null && mode.id === modeId;
              return (
                <MenuItem
                  key={mode.id}
                  onClick={() => handleModeChange(mode.id, mode.baseInteractionMode)}
                >
                  <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 font-medium">
                        <span className="truncate">{mode.name}</span>
                        {mode.readonly ? (
                          <span className="rounded bg-muted px-1 py-0.5 text-2xs font-normal text-muted-foreground">
                            {gt("read-only")}
                          </span>
                        ) : null}
                      </div>
                      {mode.description ? (
                        <p className="mt-0.5 line-clamp-2 text-2xs text-muted-foreground">
                          {mode.description}
                        </p>
                      ) : null}
                    </div>
                    {selected ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
                  </div>
                </MenuItem>
              );
            })}
            {props.workflowModes === null || props.workflowModes === undefined ? null : (
              <>
                <MenuSeparator />
                <div className="px-2 py-1 text-2xs text-muted-foreground">
                  {gt("Workflow Modes")}
                </div>
                {props.workflowModes.map((workflow) => (
                  <MenuItem key={workflow.name} onClick={() => props.onSelectWorkflow?.(workflow)}>
                    <WorkflowIcon className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{workflow.name}</span>
                      {workflow.description ? (
                        <span className="block truncate text-2xs text-muted-foreground">
                          {workflow.description}
                        </span>
                      ) : null}
                    </span>
                    {props.selectedWorkflow?.name === workflow.name ? (
                      <CheckIcon className="size-3.5" />
                    ) : null}
                  </MenuItem>
                ))}
                {props.workflowModes.length === 0 ? (
                  <MenuItem
                    onClick={() =>
                      void navigate({ to: "/automations", search: { tab: "workflows" } })
                    }
                  >
                    <WorkflowIcon className="size-3.5 text-muted-foreground" />
                    <span>{gt("Set up a workflow")}</span>
                  </MenuItem>
                ) : null}
              </>
            )}
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                void navigate({
                  to: "/harness",
                  search: { tab: "context", ...(environmentId ? { machine: environmentId } : {}) },
                });
              }}
            >
              <Settings2Icon className="size-3.5 text-muted-foreground" />
              <span>{gt("Manage modes in Harness")}</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}

      {!composerControlsHidden && routeKind === "server" && activeThreadId !== null ? (
        <ThreadContextInspectorButton
          environmentId={environmentId}
          threadId={activeThreadId}
          size={controlSize}
        />
      ) : null}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={controlSize}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            // Permissions join the overflow only when their normal home is in it.
            showPermissions={overflowShowsPermissions}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}
