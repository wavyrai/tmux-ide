import { Match, Switch, createResource, type JSX } from "solid-js";

let mermaidInitialized = false;
let diagramSequence = 0;

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  const chunkSize = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

async function renderMermaid(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: {
        background: "#111116",
        primaryColor: "#27243a",
        primaryTextColor: "#f4f2ff",
        primaryBorderColor: "#9f7aff",
        secondaryColor: "#202b3d",
        tertiaryColor: "#162d2b",
        lineColor: "#a8a4b8",
        fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      },
    });
    mermaidInitialized = true;
  }
  const id = `tmux-ide-mermaid-${++diagramSequence}`;
  const { svg } = await mermaid.render(id, source);
  return svgDataUrl(svg);
}

export function MermaidBlock(props: { readonly source: string }): JSX.Element {
  const [diagram] = createResource(() => props.source, renderMermaid);
  return (
    <Switch>
      <Match when={diagram.error}>
        <div class="widget-mermaid widget-mermaid--error" role="status">
          <strong>Mermaid could not render this diagram.</strong>
          <pre class="widget-markdown__code">
            <code>{props.source}</code>
          </pre>
        </div>
      </Match>
      <Match when={diagram()} keyed>
        {(source) => (
          <figure class="widget-mermaid">
            <img src={source} alt="Diagram rendered from a Mermaid code block" />
          </figure>
        )}
      </Match>
      <Match when={true}>
        <p class="widget-surface__loading" role="status">
          Rendering diagram…
        </p>
      </Match>
    </Switch>
  );
}
