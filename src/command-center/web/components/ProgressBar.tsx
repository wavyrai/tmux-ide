import { JSX } from "solid-js";

interface ProgressBarProps {
  percent: number;
  class?: string;
}

export function ProgressBar(props: ProgressBarProps): JSX.Element {
  const fillColor = () => props.percent >= 100 ? "var(--success)" : "var(--accent)";

  return (
    <div style={{
      height: "4px",
      "border-radius": "2px",
      background: "var(--border)",
      overflow: "hidden",
    }}>
      <div
        style={{
          height: "100%",
          "border-radius": "2px",
          width: `${Math.min(100, Math.max(0, props.percent))}%`,
          background: fillColor(),
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}
