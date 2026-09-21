import { createElement, useMemo, type ReactNode } from "react";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../../../../desktop-renderer/src/terminal/widgets/markdown";

function Inline({ nodes }: { nodes: readonly MarkdownInline[] }): ReactNode {
  return nodes.map((node, key) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return <code key={key}>{node.text}</code>;
      case "break":
        return <br key={key} />;
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer">
            <Inline nodes={node.content} />
          </a>
        );
      case "strong":
        return (
          <strong key={key}>
            <Inline nodes={node.content} />
          </strong>
        );
      case "emphasis":
        return (
          <em key={key}>
            <Inline nodes={node.content} />
          </em>
        );
      case "strike":
        return (
          <del key={key}>
            <Inline nodes={node.content} />
          </del>
        );
    }
  });
}
function Blocks({ blocks }: { blocks: readonly MarkdownBlock[] }): ReactNode {
  return blocks.map((block, key) => {
    switch (block.kind) {
      case "heading":
        return createElement(`h${block.level}`, { key }, <Inline nodes={block.content} />);
      case "paragraph":
        return (
          <p key={key}>
            <Inline nodes={block.content} />
          </p>
        );
      case "code":
        return (
          <pre key={key}>
            <code>{block.text}</code>
          </pre>
        );
      case "rule":
        return <hr key={key} />;
      case "quote":
        return (
          <blockquote key={key}>
            <Blocks blocks={block.blocks} />
          </blockquote>
        );
      case "list": {
        const items = block.items.map((item, i) => (
          <li key={i}>
            {item.checked !== null && (
              <input type="checkbox" checked={item.checked} disabled aria-label="Task completed" />
            )}
            <Blocks blocks={item.blocks} />
          </li>
        ));
        return block.ordered ? (
          <ol key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={key} className="widget-table-scroll">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, i) => (
                    <th key={i}>
                      <Inline nodes={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>
                        <Inline nodes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}
export function MarkdownDocument({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div data-slot="markdown-document" className="markdown-body">
      <Blocks blocks={blocks} />
    </div>
  );
}
