interface ProgressBarProps {
  percent: number;
  className?: string;
}

export function ProgressBar({ percent, className = "" }: ProgressBarProps) {
  const color = percent === 100 ? "#7dd87d" : "#dcde8d";
  return (
    <div
      className={`h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden ${className}`}
    >
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </div>
  );
}
