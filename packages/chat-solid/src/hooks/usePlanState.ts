import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { PlanEntry } from "../types";

export interface PlanEntryView extends PlanEntry {
  origin: "agent" | "user";
  localStatus?: PlanEntry["status"];
}

export interface UsePlanStateResult {
  entries: Accessor<PlanEntryView[]>;
  toggleEntry(index: number): void;
  addUserEntry(content: string): void;
  removeUserEntry(index: number): void;
  exportMarkdown(): string;
}

type PlanStatus = NonNullable<PlanEntry["status"]>;

const STATUS_ORDER: PlanStatus[] = ["pending", "in_progress", "completed"];

export function usePlanState(agentEntries: Accessor<PlanEntry[]>): UsePlanStateResult {
  const [agentViews, setAgentViews] = createSignal<PlanEntryView[]>([]);
  const [userViews, setUserViews] = createSignal<PlanEntryView[]>([]);
  let agentSignature = "";

  createEffect(() => {
    const entries = agentEntries();
    const nextSignature = signatureFor(entries);
    if (nextSignature === agentSignature) return;
    agentSignature = nextSignature;
    setAgentViews(
      entries.map((entry) => ({
        ...entry,
        origin: "agent",
      })),
    );
  });

  const entries = createMemo(() => [...agentViews(), ...userViews()]);

  function toggleEntry(index: number): void {
    const agentCount = agentViews().length;
    if (index < agentCount) {
      setAgentViews((current) =>
        current.map((entry, candidate) =>
          candidate === index ? { ...entry, localStatus: nextStatus(statusFor(entry)) } : entry,
        ),
      );
      return;
    }

    const userIndex = index - agentCount;
    setUserViews((current) =>
      current.map((entry, candidate) =>
        candidate === userIndex ? { ...entry, status: nextStatus(statusFor(entry)) } : entry,
      ),
    );
  }

  function addUserEntry(content: string): void {
    const trimmed = content.trim();
    if (!trimmed) return;
    setUserViews((current) => [
      ...current,
      { content: trimmed, status: "pending", origin: "user" },
    ]);
  }

  function removeUserEntry(index: number): void {
    const agentCount = agentViews().length;
    if (index < agentCount) return;
    const userIndex = index - agentCount;
    setUserViews((current) => current.filter((_, candidate) => candidate !== userIndex));
  }

  function exportMarkdown(): string {
    const lines = entries().map((entry) => {
      const status = statusFor(entry);
      const marker = status === "completed" ? "x" : status === "in_progress" ? "-" : " ";
      const origin = entry.origin === "user" ? " _(yours)_" : "";
      return `- [${marker}] ${entry.content}${origin}`;
    });
    return ["Updated plan:", "", ...lines].join("\n");
  }

  return { entries, toggleEntry, addUserEntry, removeUserEntry, exportMarkdown };
}

export function statusFor(entry: PlanEntryView): PlanStatus {
  return entry.localStatus ?? entry.status ?? "pending";
}

function nextStatus(status: PlanStatus): PlanStatus {
  const index = STATUS_ORDER.indexOf(status);
  return STATUS_ORDER[(index + 1) % STATUS_ORDER.length] ?? "pending";
}

function signatureFor(entries: PlanEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      content: entry.content,
      status: entry.status ?? null,
      priority: entry.priority ?? null,
    })),
  );
}
