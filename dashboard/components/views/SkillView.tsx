"use client";

import { useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { fetchSkill, injectIntoProject, type SkillData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { useToasts } from "@/lib/useToasts";

interface SkillViewProps {
  sessionName: string;
  skillName: string;
}

export function SkillView({ sessionName, skillName }: SkillViewProps) {
  const fetcher = useCallback(() => fetchSkill(sessionName, skillName), [sessionName, skillName]);
  const { data: skill } = usePolling<SkillData | null>(fetcher, 10_000);
  const { push } = useToasts();

  const sendToAgent = useCallback(async () => {
    if (!skill) return;
    const ok = await injectIntoProject(
      sessionName,
      `Load skill: ${skill.name}\n\n${skill.body}`,
      { sendEnter: true },
    );
    push({
      kind: ok ? "success" : "error",
      title: ok ? "Sent skill to agent" : "Failed to send skill",
      body: skill.name,
      scope: { project: sessionName },
    });
  }, [push, sessionName, skill]);

  if (!skill) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center bg-[var(--bg)] p-8 text-center text-[var(--dim)]">
        <div className="text-[13px]">Skill not found</div>
        <div className="mt-1 text-[11px]">
          Looking for <code className="rounded-sm bg-[var(--surface)] px-1">{skillName}</code> in{" "}
          <code className="rounded-sm bg-[var(--surface)] px-1">{sessionName}</code>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <div className="flex-1 space-y-4 overflow-auto p-4">
        {/* Header card */}
        <header
          data-testid="skill-header"
          className="rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[18px] tracking-[-0.01em] text-[var(--fg)]">
                  {skill.name}
                </h1>
                {skill.role && (
                  <span className="rounded-sm bg-[var(--surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] text-[var(--cyan)]">
                    {skill.role}
                  </span>
                )}
              </div>
              {skill.description && (
                <p className="mt-1 text-[12px] text-[var(--fg-secondary)]">{skill.description}</p>
              )}
              {skill.specialties && skill.specialties.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {skill.specialties.map((spec) => (
                    <span
                      key={spec}
                      className="rounded-sm border border-[var(--border-weak)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)]"
                    >
                      {spec}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void sendToAgent()}
              className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] text-[var(--fg)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
              data-testid="skill-send"
            >
              Send to agent
            </button>
          </div>
        </header>

        {/* Body markdown */}
        <section
          data-testid="skill-body"
          className="plan-content rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] p-4"
        >
          <ReactMarkdown>{skill.body || "_(empty skill)_"}</ReactMarkdown>
        </section>
      </div>
    </div>
  );
}
