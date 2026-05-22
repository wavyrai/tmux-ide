import { Show, type Accessor } from "solid-js";
import type { ChatThreadUsageSummary } from "../types";

function formatTokenCount(value: number | undefined): string {
  const count = value ?? 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (count >= 1_000) return `${Math.round(count / 100) / 10}k`;
  return String(count);
}

function formatPercent(used: number, max: number): string {
  const percent = max > 0 ? Math.max(0, Math.min(100, (used / max) * 100)) : 0;
  return percent < 10 ? `${percent.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(percent)}%`;
}

function tooltip(usage: ChatThreadUsageSummary): string {
  return [
    `Input: ${usage.inputTokens.toLocaleString()} tokens`,
    `Output: ${usage.outputTokens.toLocaleString()} tokens`,
    `Cache read: ${(usage.cacheReadTokens ?? 0).toLocaleString()} tokens`,
    `Cache write: ${(usage.cacheWriteTokens ?? 0).toLocaleString()} tokens`,
    usage.contextWindowMaxTokens && usage.contextWindowUsedTokens !== undefined
      ? `Context: ${usage.contextWindowUsedTokens.toLocaleString()} / ${usage.contextWindowMaxTokens.toLocaleString()} tokens`
      : null,
    usage.totalCostUsd !== undefined ? `Cost: $${usage.totalCostUsd.toFixed(4)}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function ContextWindowMeter(props: { usage: Accessor<ChatThreadUsageSummary | null> }) {
  const hasWindow = () =>
    props.usage()?.contextWindowMaxTokens !== undefined &&
    props.usage()?.contextWindowUsedTokens !== undefined;
  const percent = () => {
    const usage = props.usage();
    if (!usage?.contextWindowMaxTokens || usage.contextWindowUsedTokens === undefined) return "0%";
    return formatPercent(usage.contextWindowUsedTokens, usage.contextWindowMaxTokens);
  };
  const progress = () => {
    const usage = props.usage();
    if (!usage?.contextWindowMaxTokens || usage.contextWindowUsedTokens === undefined) return 0;
    return Math.max(
      0,
      Math.min(100, (usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100),
    );
  };

  return (
    <Show when={props.usage()}>
      {(usage) => (
        <span
          class="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border-weak px-1.5 py-0.5 text-sm text-dim"
          title={tooltip(usage())}
          aria-label="Chat usage"
        >
          <Show
            when={hasWindow()}
            fallback={
              <span class="whitespace-nowrap">
                ↑{formatTokenCount(usage().inputTokens)} ↓{formatTokenCount(usage().outputTokens)}{" "}
                tokens
              </span>
            }
          >
            <span class="h-1.5 w-12 overflow-hidden rounded-full bg-border-weak">
              <span
                class="block h-full rounded-full bg-accent"
                style={{ width: `${progress()}%` }}
              />
            </span>
            <span class="whitespace-nowrap">{percent()}</span>
          </Show>
          <Show when={usage().totalCostUsd !== undefined}>
            <span class="whitespace-nowrap text-fg-secondary">
              ${usage().totalCostUsd?.toFixed(4)}
            </span>
          </Show>
        </span>
      )}
    </Show>
  );
}
