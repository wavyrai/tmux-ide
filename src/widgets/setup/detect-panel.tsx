import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export interface DetectedStackInfo {
  packageManager: string | null;
  language: string | null;
  frameworks: string[];
  devCommand: string | null;
}

interface DetectPanelProps {
  detected: DetectedStackInfo;
  onContinue: () => void;
  theme: WidgetTheme;
}

export function DetectPanel(props: DetectPanelProps) {
  const theme = props.theme;

  useKeyboard((evt) => {
    if (evt.name === "return") {
      props.onContinue();
      evt.preventDefault();
    }
  });

  function field(label: string, value: string | null): string {
    return `${label}: ${value ?? "not detected"}`;
  }

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Project Detected
        </text>
      </box>

      {/* Detection results */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.fg)}>{field("Package Manager", props.detected.packageManager)}</text>
        <text fg={toRGBA(theme.fg)}>{field("Language", props.detected.language)}</text>
        <text fg={toRGBA(theme.fg)}>
          {field(
            "Frameworks",
            props.detected.frameworks.length > 0 ? props.detected.frameworks.join(", ") : null,
          )}
        </text>
        <text fg={toRGBA(theme.fg)}>{field("Dev Command", props.detected.devCommand)}</text>
      </box>

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Footer */}
      <box flexShrink={0} onMouseDown={() => props.onContinue()}>
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(40)}
          </text>
        </box>
        <text fg={toRGBA(theme.accent)}>Enter:continue</text>
      </box>
    </box>
  );
}
