import { JSX } from "solid-js";

interface ProgressBarProps {
  percent: number;
  size?: "sm" | "md";
  class?: string;
}

export function ProgressBar(props: ProgressBarProps): JSX.Element {
  const height = () => (props.size === "sm" ? "h-1.5" : "h-2");

  return (
    <div class={`w-full bg-gray-800 rounded-full overflow-hidden ${height()} ${props.class ?? ""}`}>
      <div
        class="h-full rounded-full transition-all duration-500 ease-out"
        classList={{
          "bg-green-400": props.percent >= 100,
          "bg-blue-400": props.percent > 0 && props.percent < 100,
          "bg-gray-700": props.percent === 0,
        }}
        style={{ width: `${Math.min(100, Math.max(0, props.percent))}%` }}
      />
    </div>
  );
}
