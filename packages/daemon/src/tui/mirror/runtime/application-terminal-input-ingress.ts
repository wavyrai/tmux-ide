import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import {
  applicationGenerationNavigationKey,
  type createApplicationGenerationStarter,
} from "./application-generation-starter.ts";
import { createApplicationPendingTerminalInputOwner } from "./application-pending-terminal-input.ts";
import {
  sendApplicationTerminalKey,
  sendApplicationTerminalPaste,
} from "./application-terminal-paste.ts";
import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import {
  terminalInputForOpenTuiKey,
  terminalInputsForPaste,
  type OpenTuiKeyEvent,
} from "./terminal-input-adapter.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";

type GenerationStarter = ReturnType<typeof createApplicationGenerationStarter>;

/** Root-owned first-input gate for the exact session generation being opened. */
export function createApplicationTerminalInputIngress(
  interaction: ApplicationTerminalInteractionController,
  generation: () => OpenTuiGenerationHostSnapshot | null,
  sessionOwner: () => OpenTuiSessionOwner | null,
  focusedPane: () => string | null,
  setNote: (note: string | null) => void,
) {
  const pending = createApplicationPendingTerminalInputOwner();
  let ownsNote = false;
  const captureOrigin = (): boolean =>
    Boolean(currentTuiPerformanceEventSink()?.terminalInputOrigin);
  const flush = (): void => {
    const owner = sessionOwner();
    const result = pending.flush({
      sessionName: owner?.sessionName() ?? null,
      generationKey: applicationGenerationNavigationKey(owner?.snapshot() ?? null),
      focusedPane: focusedPane(),
    });
    if (result.status === "flushed" && ownsNote) {
      ownsNote = false;
      setNote(null);
    } else if (result.status === "superseded" && result.discarded > 0) {
      ownsNote = false;
      setNote("terminal changed · queued input was not sent");
    }
  };
  const noteQueued = (kind: "input" | "paste"): void => {
    ownsNote = true;
    setNote(`${pending.snapshot().sessionName} · terminal ${kind} queued`);
  };
  const noteAdmission = (
    status: "queued" | "overflow" | "unavailable",
    kind: "input" | "paste",
  ) => {
    if (status === "queued") noteQueued(kind);
    else if (status === "overflow")
      setNote("terminal input queue full · wait for the session to connect");
    else setNote(`terminal unavailable · ${kind} was not sent`);
  };

  return {
    wrapStarter(starter: GenerationStarter): GenerationStarter {
      return async (...args) => {
        const [sessionName] = args;
        const identity = pending.begin(sessionName);
        const result = await starter(...args);
        const settlement = pending.settle(identity, result);
        if (settlement.status === "unavailable" && settlement.discarded > 0) {
          ownsNote = false;
          setNote(`${sessionName} unavailable · queued input was not sent`);
        }
        flush();
        return result;
      };
    },
    adopt(): void {
      flush();
    },
    routeKey(event: OpenTuiKeyEvent): void {
      const active = generation();
      if (
        pending.snapshot().sessionName === null &&
        active?.status === "live" &&
        active.fastLane &&
        focusedPane()
      ) {
        sendApplicationTerminalKey(interaction, event, captureOrigin());
        return;
      }
      if (!terminalInputForOpenTuiKey(event)) return;
      const copy = { name: event.name, ctrl: event.ctrl, meta: event.meta, shift: event.shift };
      noteAdmission(
        pending.enqueue(
          () => sendApplicationTerminalKey(interaction, copy, captureOrigin()),
          Buffer.byteLength(event.name, "utf8"),
        ),
        "input",
      );
    },
    routePaste(bytes: Uint8Array): void {
      if (bytes.length === 0) return;
      const copy = Uint8Array.from(bytes);
      try {
        terminalInputsForPaste(Buffer.from(copy).toString("utf8"));
      } catch {
        setNote("terminal unavailable · paste was rejected");
        return;
      }
      const active = generation();
      if (
        pending.snapshot().sessionName === null &&
        active?.status === "live" &&
        active.fastLane &&
        focusedPane()
      ) {
        sendApplicationTerminalPaste(interaction, copy, captureOrigin());
        return;
      }
      noteAdmission(
        pending.enqueue(
          () => sendApplicationTerminalPaste(interaction, copy, captureOrigin()),
          copy.byteLength,
        ),
        "paste",
      );
    },
    dispose(): void {
      pending.dispose();
    },
  };
}
