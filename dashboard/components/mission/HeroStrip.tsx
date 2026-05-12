"use client";

import { motion } from "motion/react";
import { ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button, StatusPill } from "@/components/ui";
import { formatRelative, isMissionStatus, missionVariant, readString } from "./utils";

interface HeroStripProps {
  title: string;
  description: string;
  status: string;
  branch: string | null;
  created?: string | null;
  updated?: string | null;
  onTitleSave?: (title: string) => Promise<void> | void;
  onEditDescription?: () => void;
}

export function HeroStrip({
  title,
  description,
  status,
  branch,
  created,
  updated,
  onTitleSave,
  onEditDescription,
}: HeroStripProps) {
  const safeStatus = isMissionStatus(status) ? status : "planning";
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraftTitle(title);
  }, [title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const showToggle = description.length > 240;
  const createdAt = readString({ value: created }, "value");
  const updatedAt = readString({ value: updated }, "value");

  async function commit() {
    const next = draftTitle.trim();
    setEditing(false);
    if (!next || next === title) {
      setDraftTitle(title);
      return;
    }
    if (onTitleSave) await onTitleSave(next);
  }

  return (
    <section
      data-testid="mission-hero"
      className="rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] p-5"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill variant={missionVariant(safeStatus)} label={safeStatus} />
        {branch && (
          <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-secondary)]">
            {branch}
          </span>
        )}
        <span className="text-[10px] text-[var(--dim)]">
          created {formatRelative(createdAt ?? created)}
        </span>
        <span className="text-[10px] text-[var(--dim)]">
          updated {formatRelative(updatedAt ?? updated)}
        </span>
      </div>

      {editing ? (
        <input
          ref={inputRef}
          data-testid="mission-title-input"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraftTitle(title);
            }
          }}
          className="-mx-1 w-full rounded-md border border-[var(--accent)] bg-[var(--bg)] px-2 py-1 text-[24px] font-semibold tracking-[-0.01em] text-[var(--fg)] outline-none focus-visible:focus-ring"
        />
      ) : (
        <button
          type="button"
          data-testid="mission-title"
          onClick={() => setEditing(true)}
          className="group/title flex w-full items-center gap-2 rounded-md text-left text-[24px] font-semibold tracking-[-0.01em] text-[var(--fg)] hover-only:hover:text-[var(--accent)]"
        >
          <span className="min-w-0 truncate">{title}</span>
          <Pencil
            aria-hidden="true"
            size={14}
            className="opacity-0 transition-opacity group-hover/title:opacity-100"
          />
        </button>
      )}

      {description && (
        <div className="mt-3">
          <motion.div
            data-testid="mission-description"
            initial={false}
            animate={{ height: expanded || !showToggle ? "auto" : 64 }}
            transition={{ type: "spring", stiffness: 600, damping: 49 }}
            className="overflow-hidden"
          >
            <div className="plan-content chat-markdown max-w-3xl text-[12px] leading-6 text-[var(--fg-secondary)]">
              <ReactMarkdown>{description}</ReactMarkdown>
            </div>
          </motion.div>
          <div className="mt-2 flex items-center gap-3">
            {showToggle && (
              <button
                type="button"
                data-testid="mission-description-toggle"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--accent)]"
              >
                {expanded ? (
                  <>
                    <ChevronUp aria-hidden="true" size={11} /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown aria-hidden="true" size={11} /> Show more
                  </>
                )}
              </button>
            )}
            {onEditDescription && (
              <Button
                variant="ghost"
                size="xs"
                onClick={onEditDescription}
                data-testid="mission-description-edit"
              >
                <Pencil aria-hidden="true" size={11} />
                Edit
              </Button>
            )}
          </div>
        </div>
      )}

      {!description && onEditDescription && (
        <div className="mt-3">
          <Button
            variant="outline"
            size="xs"
            onClick={onEditDescription}
            data-testid="mission-description-add"
          >
            <Pencil aria-hidden="true" size={11} />
            Add description
          </Button>
        </div>
      )}
    </section>
  );
}
