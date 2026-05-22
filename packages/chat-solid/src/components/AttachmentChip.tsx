import type { ComposerAttachment } from "../types";

export function AttachmentChip(props: { attachment: ComposerAttachment; onRemove(): void }) {
  const label = () =>
    props.attachment.kind === "terminal"
      ? `Terminal: ${props.attachment.paneTitle}`
      : props.attachment.label;
  const icon = () => (props.attachment.kind === "terminal" ? "▤" : "📄");

  return (
    <span class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-base text-fg-secondary">
      <span aria-hidden="true">{icon()}</span>
      <span class="truncate">{label()}</span>
      <button
        type="button"
        class="ml-0.5 cursor-pointer border-0 bg-transparent p-0 text-md leading-none text-dim hover:text-fg"
        aria-label={`Remove ${label()} attachment`}
        onClick={props.onRemove}
      >
        ×
      </button>
    </span>
  );
}
