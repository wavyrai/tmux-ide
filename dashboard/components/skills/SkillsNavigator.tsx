"use client";

import { Send, Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fetchSkills, injectIntoProject, type SkillData } from "@/lib/api";
import { useLayoutState } from "@/lib/useLayoutState";
import { useSidebar } from "@/components/ui/sidebar";
import { useToasts } from "@/lib/useToasts";
import { NavigatorShell } from "@/components/navigators/NavigatorShell";

/**
 * Lists skills from the active project's `.tmux-ide/skills/` directory.
 * Renders an empty state when no project is open and an error/loading
 * state while polling. Each row supports a "send to active agent" action.
 */
export function SkillsNavigator() {
  const pathname = usePathname();
  const { openWorkspaceTab } = useLayoutState();
  const { setOpenMobile, isMobile } = useSidebar();
  const { push } = useToasts();
  const [skills, setSkills] = useState<SkillData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const activeProject = pathname.startsWith("/project/")
    ? decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""))
    : null;

  useEffect(() => {
    if (!activeProject) {
      setSkills([]);
      setLoading(false);
      setError(false);
      return;
    }
    let active = true;
    setLoading(true);
    async function load() {
      try {
        const data = await fetchSkills(activeProject!);
        if (!active) return;
        setSkills(data);
        setError(false);
        setLoading(false);
      } catch {
        if (!active) return;
        setError(true);
        setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [activeProject]);

  const inject = useCallback(
    async (skill: SkillData) => {
      if (!activeProject) return;
      const ok = await injectIntoProject(activeProject, `<load skill: ${skill.name}>`, {
        sendEnter: false,
      });
      push({
        kind: ok ? "success" : "error",
        title: ok ? "Sent to agent" : "Failed to inject",
        body: skill.name,
      });
    },
    [activeProject, push],
  );

  function closeMobile() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <NavigatorShell title="Skills" testId="skills-navigator">
      {!activeProject ? (
        <div className="px-3 py-3 text-[11px] text-[var(--dim)]">
          open a project to load skills
        </div>
      ) : error ? (
        <div className="px-3 py-3 text-[11px] text-[var(--red)]">skills unavailable</div>
      ) : loading ? (
        <div className="space-y-1 p-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-9 animate-pulse rounded-md bg-[var(--surface)]"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : skills.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-[var(--dim)]">no skills</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {skills.map((skill) => (
            <li key={skill.name} className="group/skill relative">
              <button
                type="button"
                data-testid={`navigator-skill-${skill.name}`}
                onClick={() => {
                  openWorkspaceTab(
                    "skill",
                    activeProject,
                    `Skill · ${skill.name}`,
                    skill.name,
                  );
                  closeMobile();
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
              >
                <Sparkles
                  aria-hidden="true"
                  size={13}
                  strokeWidth={1.6}
                  className="mt-0.5 shrink-0 text-[var(--accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-[var(--fg)]">{skill.name}</div>
                  {skill.specialties[0] && (
                    <div className="mt-0.5 truncate text-[10px] text-[var(--cyan)]">
                      {skill.specialties[0]}
                    </div>
                  )}
                </div>
              </button>
              <button
                type="button"
                data-testid={`navigator-skill-inject-${skill.name}`}
                onClick={() => void inject(skill)}
                className="absolute right-2 top-2 rounded-md p-1 opacity-0 transition-opacity hover:bg-[var(--surface-active)] hover:text-[var(--accent)] group-hover/skill:opacity-100"
                aria-label={`Send ${skill.name} to active agent`}
                title={`Send ${skill.name} to active agent`}
              >
                <Send aria-hidden="true" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </NavigatorShell>
  );
}
