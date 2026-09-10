/* @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { createApplicationMachineNavigation } from "./application-machine-navigation.ts";
import { ApplicationFleetSwitcher } from "./application-fleet-switcher.tsx";
import { ApplicationAddMachineDialog } from "./application-add-machine-dialog.tsx";
export function ApplicationMachineOverlays(props: {
  machines: ReturnType<typeof createApplicationMachineNavigation>;
  viewport: { width: number; height: number };
  theme: SemanticThemeSnapshot;
}) {
  return (
    <>
      <Show when={props.machines.switching()}>
        <ApplicationFleetSwitcher
          open={true}
          attentionOnly={props.machines.attentionOnly()}
          rows={props.machines.switcherRows()}
          onClose={props.machines.closeSwitcher}
          width={props.viewport.width}
          height={props.viewport.height}
          theme={props.theme}
        />
      </Show>
      <ApplicationAddMachineDialog
        open={props.machines.adding()}
        alias={props.machines.alias()}
        onAliasChange={props.machines.setAlias}
        onSubmit={props.machines.add}
        onCancel={props.machines.cancelAdd}
        error={props.machines.error()}
        width={props.viewport.width}
        height={props.viewport.height}
        theme={props.theme}
      />
    </>
  );
}
