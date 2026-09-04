import { createSignal } from "solid-js";

import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import {
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
  type ApplicationPaneRenameDraft,
} from "./application-pane-rename-input.ts";

export function createApplicationPaneRenameOwner(
  renamePane: ApplicationTerminalInteractionController["renamePane"],
  setNote: (note: string | null) => void,
) {
  const [draft, setDraft] = createSignal<ApplicationPaneRenameDraft | null>(null);
  const submit = (current: ApplicationPaneRenameDraft): void => {
    setDraft(null);
    void Promise.resolve()
      .then(() => renamePane(current.paneId, current.value))
      .then(setNote)
      .catch(() => setNote("Pane rename failed. Check the live pane and try again."));
  };
  return Object.freeze({
    draft,
    begin(paneId: string, currentName: string) {
      setDraft({ paneId, value: currentName });
    },
    cancel() {
      setDraft(null);
    },
    submit() {
      const current = draft();
      if (current?.value.trim()) submit(current);
    },
    handleKey(event: Parameters<typeof applicationPaneRenameKeyAction>[0]) {
      const current = draft();
      if (!current) return false;
      const action = applicationPaneRenameKeyAction(event, current.value);
      if (action.kind === "cancel") setDraft(null);
      else if (action.kind === "submit") submit(current);
      else if (action.kind === "update") setDraft({ ...current, value: action.value });
      return true;
    },
    handlePaste(bytes: Uint8Array) {
      const current = draft();
      if (!current) return false;
      setDraft({ ...current, value: applicationPaneRenamePaste(current.value, bytes) });
      return true;
    },
  });
}
