interface ProgressBarProps {
  percent: number;
  width?: number;
}

export function ProgressBar({ percent, width = 10 }: ProgressBarProps) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent === 100 ? "var(--green)" : "var(--accent)";

  return (
    <span className="inline-flex items-center gap-1">
      <span>
        <span style={{ color }}>{"█".repeat(filled)}</span>
        <span className="text-[var(--dim)]">{"░".repeat(empty)}</span>
      </span>
      <span className="text-[var(--dim)] text-right" style={{ width: "3ch" }}>
        {percent}%
      </span>
    </span>
  );
}
