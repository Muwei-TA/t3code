import { useGT } from "gt-react";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function WorkflowsSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflows")}
      settingKeys={["workflowsEnabled"]}
      description={gt(
        "Run multi-step workflows from files in the workflows folder of this server's T3 home. Open them from the command palette. While off, nothing in that folder runs; runs wait until it is on again.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["workflowsEnabled"]}
          checked={settings.workflowsEnabled}
          onCheckedChange={(checked) => updateSettings({ workflowsEnabled: Boolean(checked) })}
          aria-label={gt("Workflows")}
        />
      }
    />
  );
}
