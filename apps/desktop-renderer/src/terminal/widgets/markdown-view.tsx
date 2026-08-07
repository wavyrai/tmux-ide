import { For, Match, Show, Switch, type JSX } from "solid-js";

import {
  markdownInlineText,
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownListItem,
} from "./markdown.ts";
import { MermaidBlock } from "./mermaid-block.tsx";

/**
 * Renders a markdown tree as real elements.
 *
 * There is no `innerHTML` anywhere in this file, and that is the point: document
 * text becomes text nodes and never becomes markup, so no sanitiser sits between
 * the parser and the screen and none is needed. Every visual decision comes from
 * the app's design tokens through `markdown-widget.css`.
 */

export interface MarkdownViewProps {
  readonly text: string;
}

export function MarkdownView(props: MarkdownViewProps): JSX.Element {
  const blocks = (): MarkdownBlock[] => parseMarkdown(props.text);
  return (
    <div class="widget-markdown">
      <BlockList blocks={blocks()} />
    </div>
  );
}

function BlockList(props: { readonly blocks: readonly MarkdownBlock[] }): JSX.Element {
  return <For each={props.blocks}>{(block) => <Block block={block} />}</For>;
}

function Block(props: { readonly block: MarkdownBlock }): JSX.Element {
  return (
    <Switch>
      <Match when={props.block.kind === "heading" ? props.block : null} keyed>
        {(block) => <Heading level={block.level} content={block.content} />}
      </Match>
      <Match when={props.block.kind === "paragraph" ? props.block : null} keyed>
        {(block) => (
          <p>
            <Inlines content={block.content} />
          </p>
        )}
      </Match>
      <Match when={props.block.kind === "code" ? props.block : null} keyed>
        {(block) => (
          <Show
            when={block.language?.toLowerCase() === "mermaid"}
            fallback={
              <pre class="widget-markdown__code" data-language={block.language ?? undefined}>
                <code>{block.text}</code>
              </pre>
            }
          >
            <MermaidBlock source={block.text} />
          </Show>
        )}
      </Match>
      <Match when={props.block.kind === "quote" ? props.block : null} keyed>
        {(block) => (
          <blockquote>
            <BlockList blocks={block.blocks} />
          </blockquote>
        )}
      </Match>
      <Match when={props.block.kind === "rule"}>
        <hr />
      </Match>
      <Match when={props.block.kind === "list" ? props.block : null} keyed>
        {(block) => (
          <Show
            when={block.ordered}
            fallback={
              <ul>
                <ListItems items={block.items} />
              </ul>
            }
          >
            {/* `start` is an ordinary attribute, not a style: a list that begins
                at 4 must renumber, not merely look renumbered. */}
            <ol start={block.start}>
              <ListItems items={block.items} />
            </ol>
          </Show>
        )}
      </Match>
      <Match when={props.block.kind === "table" ? props.block : null} keyed>
        {(block) => (
          // Wide tables scroll inside their own box; the pane never scrolls
          // sideways because a document happened to have eight columns.
          <div class="widget-markdown__table-scroll">
            <table>
              <thead>
                <tr>
                  <For each={block.head}>
                    {(cell, index) => (
                      <th data-align={block.alignments[index()] ?? undefined} scope="col">
                        <Inlines content={cell} />
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={block.rows}>
                  {(row) => (
                    <tr>
                      <For each={row}>
                        {(cell, index) => (
                          <td data-align={block.alignments[index()] ?? undefined}>
                            <Inlines content={cell} />
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function ListItems(props: { readonly items: readonly MarkdownListItem[] }) {
  return (
    <For each={props.items}>
      {(item) => (
        <li data-task={item.checked === null ? undefined : String(item.checked)}>
          <Show when={item.checked !== null}>
            <input
              type="checkbox"
              checked={item.checked === true}
              disabled
              aria-label={item.checked === true ? "Done" : "Not done"}
            />
          </Show>
          <BlockList blocks={item.blocks} />
        </li>
      )}
    </For>
  );
}

function Heading(props: {
  readonly level: number;
  readonly content: readonly MarkdownInline[];
}): JSX.Element {
  const text = (): string => markdownInlineText(props.content);
  return (
    <Switch fallback={<h6 aria-label={text()}>{<Inlines content={props.content} />}</h6>}>
      <Match when={props.level === 1}>
        <h1>
          <Inlines content={props.content} />
        </h1>
      </Match>
      <Match when={props.level === 2}>
        <h2>
          <Inlines content={props.content} />
        </h2>
      </Match>
      <Match when={props.level === 3}>
        <h3>
          <Inlines content={props.content} />
        </h3>
      </Match>
      <Match when={props.level === 4}>
        <h4>
          <Inlines content={props.content} />
        </h4>
      </Match>
      <Match when={props.level === 5}>
        <h5>
          <Inlines content={props.content} />
        </h5>
      </Match>
    </Switch>
  );
}

function Inlines(props: { readonly content: readonly MarkdownInline[] }): JSX.Element {
  return <For each={props.content}>{(node) => <InlineNode node={node} />}</For>;
}

function InlineNode(props: { readonly node: MarkdownInline }): JSX.Element {
  return (
    <Switch>
      <Match when={props.node.kind === "text" ? props.node : null} keyed>
        {(node) => <>{node.text}</>}
      </Match>
      <Match when={props.node.kind === "code" ? props.node : null} keyed>
        {(node) => <code>{node.text}</code>}
      </Match>
      <Match when={props.node.kind === "break"}>
        <br />
      </Match>
      <Match when={props.node.kind === "strong" ? props.node : null} keyed>
        {(node) => (
          <strong>
            <Inlines content={node.content} />
          </strong>
        )}
      </Match>
      <Match when={props.node.kind === "emphasis" ? props.node : null} keyed>
        {(node) => (
          <em>
            <Inlines content={node.content} />
          </em>
        )}
      </Match>
      <Match when={props.node.kind === "strike" ? props.node : null} keyed>
        {(node) => (
          <s>
            <Inlines content={node.content} />
          </s>
        )}
      </Match>
      <Match when={props.node.kind === "link" ? props.node : null} keyed>
        {(node) => (
          // A document rendered inside a pane must never navigate the app away
          // from itself, so every link opens outside it and carries no opener.
          <a href={node.href} target="_blank" rel="noreferrer noopener">
            <Inlines content={node.content} />
          </a>
        )}
      </Match>
    </Switch>
  );
}
