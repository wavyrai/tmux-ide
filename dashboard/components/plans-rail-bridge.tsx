"use client";

/**
 * React → Solid bridge for the Plans rail.
 *
 * Dynamically imports @tmux-ide/v2-solid-widgets, mounts `mountPlansRail`
 * into a container div, and pushes prop updates (selectedFile +
 * callbacks) into the live Solid signal via the mount handle's
 * setOptions — no remount on prop changes.
 *
 * Pattern mirrors V2CostsIsland / V2ExplorerIsland: the React component
 * owns no rail state, just the container element + the handle ref. See
 * docs/adr/0001-rsc-shell-and-siloed-blocks.md §1.4 Rule 4 — this is the
 * one *Bridge file allowed to call mount() for the plans rail.
 */

import { useEffect, useRef } from "react";
import { resolveApiBase, resolveAuthToken } from "@/lib/appProtocol";

interface PlansRailBridgeProps {
  sessionName: string;
  selectedFile: string | null;
  onSelect: (filename: string) => void;
  onCreate: () => void;
}

type PlansRailMountHandle = {
  unmount(): void;
  setOptions(next: {
    sessionName?: string;
    apiBaseUrl?: string;
    bearerToken?: string | null;
    selectedFile?: string | null;
    onSelect?: (filename: string) => void;
    onCreate?: () => void;
  }): void;
};

export function PlansRailBridge({
  sessionName,
  selectedFile,
  onSelect,
  onCreate,
}: PlansRailBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PlansRailMountHandle | null>(null);
  // Stash the latest callbacks in refs so the mount effect can read them
  // through stable closures — the rail's onSelect/onCreate stay fresh
  // without re-mounting on every React render.
  const onSelectRef = useRef(onSelect);
  const onCreateRef = useRef(onCreate);
  onSelectRef.current = onSelect;
  onCreateRef.current = onCreate;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountPlansRail(el, {
        sessionName,
        apiBaseUrl: resolveApiBase(),
        bearerToken: resolveAuthToken(),
        selectedFile,
        onSelect: (filename: string) => onSelectRef.current(filename),
        onCreate: () => onCreateRef.current(),
      });
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // Mount once; option updates flow through setOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push session + selection updates into the live Solid signal.
  useEffect(() => {
    handleRef.current?.setOptions({
      sessionName,
      apiBaseUrl: resolveApiBase(),
      bearerToken: resolveAuthToken(),
      selectedFile,
    });
  }, [sessionName, selectedFile]);

  return (
    <div
      ref={containerRef}
      data-testid="plans-rail-bridge"
      data-session-name={sessionName}
      style={{ display: "flex", flex: "1 1 0%", minHeight: 0, width: "100%" }}
    />
  );
}
