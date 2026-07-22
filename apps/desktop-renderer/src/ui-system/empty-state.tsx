import { Show, createUniqueId, type JSX } from "solid-js";

export interface EmptyStateProps {
  readonly title: JSX.Element;
  readonly description?: JSX.Element;
  readonly icon?: JSX.Element;
  readonly action?: JSX.Element;
  readonly size?: "compact" | "comfortable";
  readonly live?: "off" | "polite";
  readonly class?: string;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const titleId = `tmi-empty-title-${createUniqueId()}`;
  const descriptionId = `tmi-empty-description-${createUniqueId()}`;

  return (
    <section
      class={`tmi-empty-state${props.class ? ` ${props.class}` : ""}`}
      data-size={props.size ?? "comfortable"}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      aria-live={props.live === "polite" ? "polite" : undefined}
    >
      <Show when={props.icon}>
        <div class="tmi-empty-state__icon" aria-hidden="true">
          {props.icon}
        </div>
      </Show>
      <h2 id={titleId}>{props.title}</h2>
      <Show when={props.description}>
        <p id={descriptionId}>{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div class="tmi-empty-state__action">{props.action}</div>
      </Show>
    </section>
  );
}
