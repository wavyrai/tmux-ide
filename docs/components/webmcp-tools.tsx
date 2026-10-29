"use client";

import { useEffect } from "react";

declare global {
  interface Document {
    readonly modelContext?: unknown;
  }
  interface Navigator {
    readonly modelContext?: unknown;
  }
}

interface ModelContextLike {
  registerTool(tool: object, options: { signal: AbortSignal }): unknown;
  unregisterTool?: (name: string) => unknown;
}

function isModelContext(value: unknown): value is ModelContextLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "registerTool") === "function"
  );
}

function ignoreRejection(result: unknown): void {
  if (result instanceof Promise) result.catch(() => undefined);
}

/**
 * Registers the site's read-only WebMCP tools after hydration, on
 * document.modelContext with navigator.modelContext as the older fallback.
 * Without either it does nothing. The tool code loads in its own chunk, so
 * browsers without WebMCP never download it.
 */
export function WebMcpTools() {
  useEffect(() => {
    const context = document.modelContext ?? navigator.modelContext;
    if (!isModelContext(context)) return;
    const controller = new AbortController();
    const { signal } = controller;
    import("@/lib/webmcp-tools")
      .then(({ createDocsTools }) => {
        for (const tool of createDocsTools(window.location.origin)) {
          if (signal.aborted) return;
          try {
            ignoreRejection(context.registerTool(tool, { signal }));
          } catch {
            continue;
          }
          signal.addEventListener("abort", () => {
            try {
              ignoreRejection(context.unregisterTool?.(tool.name));
            } catch {}
          });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return null;
}
