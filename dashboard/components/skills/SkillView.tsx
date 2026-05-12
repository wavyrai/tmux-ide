"use client";

import { useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { fetchSkill, injectIntoProject, type SkillData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { useToasts } from "@/lib/useToasts";
import {
  EmptyState,
  Panel,
  PanelBody,
  SkeletonText,
  StatusPill,
  SurfaceCard,
} from "@/components/ui";

interface SkillViewProps {
  sessionName: string;
  skillName: string;
}

export function SkillView({ sessionName, skillName }: SkillViewProps) {
  const fetcher = useCallback(() => fetchSkill(sessionName, skillName), [sessionName, skillName]);
  const { data: skill, loading } = usePolling<SkillData | null>(fetcher, 10_000);
  const { push } = useToasts();

  const sendToAgent = useCallback(async () => {
    if (!skill) return;
    const ok = await injectIntoProject(sessionName, `Load skill: ${skill.name}\n\n${skill.body}`, {
      sendEnter: true,
    });
    push({
      kind: ok ? "success" : "error",
      title: ok ? "Sent skill to agent" : "Failed to send skill",
      body: skill.name,
      scope: { project: sessionName },
    });
  }, [push, sessionName, skill]);

  if (!skill && loading) {
    return (
      <Panel>
        <PanelBody className="space-y-5 p-4">
          <SurfaceCard>
            <SkeletonText lines={4} />
          </SurfaceCard>
          <SurfaceCard>
            <SkeletonText lines={8} />
          </SurfaceCard>
        </PanelBody>
      </Panel>
    );
  }

  if (!skill) {
    return (
      <Panel>
        <PanelBody className="space-y-5 p-4">
          <EmptyState
            title="Skill not found"
            body={`Looking for ${skillName} in ${sessionName}.`}
          />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelBody className="space-y-5 p-4">
        <SurfaceCard testId="skill-header">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[18px] tracking-[-0.01em] text-[var(--fg)]">
                  {skill.name}
                </h1>
                {skill.role && <StatusPill variant="info" label={skill.role} dot={false} />}
              </div>
              {skill.description && (
                <p className="mt-1 text-[12px] text-[var(--fg-secondary)]">{skill.description}</p>
              )}
              {skill.specialties && skill.specialties.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {skill.specialties.map((spec) => (
                    <span
                      key={spec}
                      className="rounded-md border border-[var(--border-weak)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)]"
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
        </SurfaceCard>

        <SurfaceCard testId="skill-body" className="plan-content chat-markdown">
          <ReactMarkdown>{skill.body || "_(empty skill)_"}</ReactMarkdown>
        </SurfaceCard>
      </PanelBody>
    </Panel>
  );
}
