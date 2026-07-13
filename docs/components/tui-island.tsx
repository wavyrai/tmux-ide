"use client";

import { useEffect, useRef } from "react";
import { TUI_DEMO_SRC } from "@/lib/tui-asset";

type SceneName = "fleet" | "cli" | "palette" | "diff" | "files";

declare global {
  interface Window {
    __tuiDemo?: (el: HTMLElement, scene?: SceneName) => () => void;
  }
}

/**
 * Mounts the Solid/OpenTUI island into a plain div. React never owns the
 * subtree and Solid never sees React — the only contract between them is this
 * element and the dispose function `mount` returns.
 */
export function TuiIsland({
  className,
  scene = "fleet",
}: {
  className?: string;
  scene?: SceneName;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dispose: (() => void) | undefined;

    const boot = () => {
      if (el.childElementCount === 0) dispose = window.__tuiDemo?.(el, scene);
    };

    if (window.__tuiDemo) {
      boot();
    } else {
      const script = document.createElement("script");
      script.src = TUI_DEMO_SRC;
      script.onload = boot;
      document.head.appendChild(script);
    }
    return () => dispose?.();
  }, [scene]);

  return <div ref={host} className={className} />;
}
