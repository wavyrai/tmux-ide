"use client";

/**
 * React → Solid bridge for the SkillsView widget.
 *
 * Mirrors the tasks-view-bridge / kanban-board-bridge pattern:
 *   - Mount once on `useEffect([])`, never on prop change.
 *   - Fetch the full skill list (with bodies) from
 *     `/api/project/:name/skills` on mount + after a focus refresh.
 *     The session snapshot only exposes name + specialties — we need
 *     bodies for the detail panel, hence the separate fetch.
 *   - Push the fetched list through `handle.setOptions({ skills })`.
 *
 * ADR-0001 §1.4 Rule 4: this is the only `*Bridge.tsx` allowed to call
 * mount() for the SkillsView widget.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  fetchSkills,
  skillCreate,
  skillDelete,
  skillUpdate,
  type SkillData,
} from "@/lib/api";

interface SkillsViewBridgeProps {
  projectName: string;
  /** Optional deep-link: pre-select a skill by name on first mount. */
  initialSelected?: string | null;
}

interface SkillFormValues {
  name: string;
  role?: string;
  description?: string;
  specialties?: ReadonlyArray<string>;
  body?: string;
}

interface SkillsViewMountHandle {
  unmount(): void;
  setOptions(next: {
    skills?: ReadonlyArray<SkillData>;
    onSelect?: (skillName: string) => void;
    initialSelected?: string | null;
    onCreate?: (values: SkillFormValues) => void | Promise<void>;
    onUpdate?: (name: string, values: SkillFormValues) => void | Promise<void>;
    onDelete?: (name: string) => void | Promise<void>;
  }): void;
}

export function SkillsViewBridge({
  projectName,
  initialSelected,
}: SkillsViewBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SkillsViewMountHandle | null>(null);

  const handleSelect = useCallback((skillName: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("skill", skillName);
    window.history.replaceState(null, "", url.toString());
  }, []);

  const refresh = useCallback(async () => {
    const skills = await fetchSkills(projectName);
    handleRef.current?.setOptions({ skills });
  }, [projectName]);

  const handleCreate = useCallback(
    async (values: SkillFormValues) => {
      await skillCreate(projectName, {
        name: values.name,
        role: values.role,
        description: values.description,
        specialties: values.specialties ? [...values.specialties] : undefined,
        body: values.body,
      });
      await refresh();
    },
    [projectName, refresh],
  );

  const handleUpdate = useCallback(
    async (name: string, values: SkillFormValues) => {
      await skillUpdate(projectName, name, {
        role: values.role,
        description: values.description,
        specialties: values.specialties ? [...values.specialties] : undefined,
        body: values.body,
      });
      await refresh();
    },
    [projectName, refresh],
  );

  const handleDelete = useCallback(
    async (name: string) => {
      await skillDelete(projectName, name);
      await refresh();
    },
    [projectName, refresh],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountSkillsView(el, {
        skills: [],
        initialSelected: initialSelected ?? null,
        onSelect: handleSelect,
        onCreate: handleCreate,
        onUpdate: handleUpdate,
        onDelete: handleDelete,
      });
      // Initial load.
      void refresh();
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh when the project name changes (e.g. host switches projects without
  // remount) and on window focus so newly-edited skill files surface.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function onFocus() {
      void refresh();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return (
    <div
      ref={containerRef}
      data-testid="skills-view-bridge"
      data-project-name={projectName}
      style={{ display: "flex", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}
    />
  );
}
