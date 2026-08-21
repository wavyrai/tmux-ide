import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import { terminalInputsForPaste } from "./terminal-input-adapter.ts";
import { terminalInputForOpenTuiKey } from "./terminal-input-adapter.ts";

export function sendApplicationTerminalKey(
  interaction: ApplicationTerminalInteractionController,
  event: Parameters<typeof terminalInputForOpenTuiKey>[0],
  captureOrigin: boolean,
): boolean {
  const input = terminalInputForOpenTuiKey(event);
  if (!input) return false;
  const parserOrigin = captureOrigin
    ? { origin: "keyboard" as const, payload: Buffer.from(input.data, "utf8") }
    : undefined;
  void interaction.sendInput(input, parserOrigin);
  return true;
}

export function sendApplicationTerminalPaste(
  interaction: ApplicationTerminalInteractionController,
  bytes: Uint8Array,
  captureOrigin: boolean,
): void {
  const text = Buffer.from(bytes).toString("utf8");
  const inputs = terminalInputsForPaste(text);
  for (let index = 0; index < inputs.length; index += 1) {
    const parserOrigin =
      index === 0 && captureOrigin
        ? { origin: "bracketed-paste" as const, payload: Buffer.from(bytes) }
        : undefined;
    void interaction.sendInput(inputs[index]!, parserOrigin);
  }
}
