import {
  MissionBoardViewSchemaZ,
  MissionDetailViewSchemaZ,
  MissionHistorySummarySchemaZ,
  MissionProjectStateSchemaZ,
  MissionTimelineEntrySchemaZ,
  type MissionActor,
  type MissionAttempt,
  type MissionAttemptId,
  type MissionBoardColumn,
  type MissionBoardView,
  type MissionCardView,
  type MissionDetailView,
  type MissionEvent,
  type MissionHistoryEntry,
  type MissionHistorySummary,
  type MissionId,
  type MissionProgressSummary,
  type MissionProof,
  type MissionProofId,
  type MissionProofSummary,
  type MissionProjectState,
  type MissionSnapshot,
  type MissionStatus,
  type MissionTask,
  type MissionTaskId,
  type MissionTaskStatus,
  type MissionTimelineEntry,
  type TaskCardView,
} from "@tmux-ide/contracts";
import { IdeError } from "./errors.ts";
import { replayMissionEvents } from "./mission-repository.ts";

export type MissionProjectionErrorCode =
  | "MISSION_PROJECTION_INVALID"
  | "MISSION_NOT_FOUND"
  | "MISSION_HISTORY_MISMATCH";

export class MissionProjectionError extends IdeError {
  readonly projectionCode: MissionProjectionErrorCode;

  constructor(
    message: string,
    code: MissionProjectionErrorCode,
    { cause }: { cause?: Error } = {},
  ) {
    super(message, { code, cause });
    this.name = "MissionProjectionError";
    this.projectionCode = code;
  }
}

export interface MissionProjectionOptions {
  asOf?: string;
}

const BOARD_COLUMNS = ["planned", "running", "blocked", "review", "done"] as const;
const TERMINAL_MISSION_STATUSES = ["completed", "failed", "cancelled"] as const;
const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled"] as const;

export function projectMissionBoard(
  state: MissionProjectState,
  history: MissionHistoryEntry[],
  options: MissionProjectionOptions = {},
): MissionBoardView {
  const parsed = validateStateAndHistory(state, history);
  const asOf = parseAsOf(options.asOf);
  const columns = emptyColumns<MissionCardView>();
  for (const mission of sortedMissions(parsed)) {
    const card = missionCard(mission, asOf, history);
    columns[card.column].push(card);
  }
  for (const column of BOARD_COLUMNS) columns[column].sort(compareMissionCards);
  return parseBoard({ version: 1, columns, counts: countsFor(columns) });
}

export function projectMissionDetail(
  state: MissionProjectState,
  history: MissionHistoryEntry[],
  missionId: MissionId,
  options: MissionProjectionOptions = {},
): MissionDetailView {
  const parsed = validateStateAndHistory(state, history);
  const mission = parsed.missions[missionId];
  if (!mission) {
    throw new MissionProjectionError(`Mission "${missionId}" not found`, "MISSION_NOT_FOUND");
  }
  const asOf = parseAsOf(options.asOf);
  const columns = emptyColumns<TaskCardView>();
  for (const task of sortedTasks(mission)) {
    const card = taskCard(mission, task, asOf);
    columns[card.column].push(card);
  }
  for (const column of BOARD_COLUMNS) columns[column].sort(compareTaskCards);
  const timeline = projectMissionTimeline(parsed, history, missionId);
  const detail = {
    version: 1 as const,
    mission: missionCard(mission, asOf, history),
    taskBoard: { columns, counts: countsFor(columns) },
    attempts: sortedAttempts(mission).map((attempt) => attemptSummary(attempt, asOf)),
    proofSummary: proofSummary(mission.proofs, sortedProofIds(Object.keys(mission.proofs))),
    progress: taskProgress(sortedTasks(mission)),
    timeline,
  };
  return parseDetail(detail);
}

export function projectMissionHistory(
  state: MissionProjectState,
  history: MissionHistoryEntry[],
  options: MissionProjectionOptions = {},
): MissionHistorySummary[] {
  const parsed = validateStateAndHistory(state, history);
  const asOf = parseAsOf(options.asOf);
  return sortedMissions(parsed)
    .filter((mission) => isTerminalMission(mission.status))
    .map((mission) => {
      const timeline = projectMissionTimeline(parsed, history, mission.id);
      const lastEvent = lastMeaningfulTimelineEntry(timeline);
      const outcome = terminalMissionOutcome(mission);
      const summary = {
        version: 1 as const,
        mission: missionCard(mission, asOf, history),
        outcome,
        startedAt: mission.startedAt,
        finishedAt: mission.finishedAt!,
        durationMs: durationMs(mission.startedAt, mission.finishedAt, undefined),
        taskTotals: taskProgress(sortedTasks(mission)),
        attemptTotals: attemptTotals(sortedAttempts(mission)),
        proofSummary: proofSummary(mission.proofs, sortedProofIds(Object.keys(mission.proofs))),
        lastEvent,
      };
      return parseHistorySummary(summary);
    });
}

export function projectMissionTimeline(
  state: MissionProjectState,
  history: MissionHistoryEntry[],
  missionId: MissionId,
): MissionTimelineEntry[] {
  const parsed = validateStateAndHistory(state, history);
  if (!parsed.missions[missionId]) {
    throw new MissionProjectionError(`Mission "${missionId}" not found`, "MISSION_NOT_FOUND");
  }
  const entries = history
    .filter((entry) => entry.event.missionId === missionId)
    .sort((a, b) => a.sequence - b.sequence)
    .map((entry) => timelineEntry(parsed.missions[missionId]!, entry));
  return entries.map(parseTimelineEntry);
}

export function missionStatusToBoardColumn(status: MissionStatus): MissionBoardColumn {
  switch (status) {
    case "created":
    case "planned":
      return "planned";
    case "started":
      return "running";
    case "blocked":
      return "blocked";
    case "review":
      return "review";
    case "completed":
    case "failed":
    case "cancelled":
      return "done";
  }
}

export function taskStatusToBoardColumn(status: MissionTaskStatus): MissionBoardColumn {
  switch (status) {
    case "added":
    case "ready":
      return "planned";
    case "claimed":
    case "started":
      return "running";
    case "blocked":
      return "blocked";
    case "submitted":
      return "review";
    case "completed":
    case "failed":
    case "cancelled":
      return "done";
  }
}

function missionCard(
  mission: MissionSnapshot,
  asOf: string | undefined,
  history: MissionHistoryEntry[],
): MissionCardView {
  const taskIds = sortedTasks(mission).map((task) => task.id);
  const attemptIds = sortedAttempts(mission).map((attempt) => attempt.id);
  const proofIds = sortedProofIds(Object.keys(mission.proofs));
  const latest = latestMissionAttemptFromHistory(mission, history);
  return {
    version: 1,
    id: mission.id,
    title: mission.title,
    summary: mission.objective,
    status: mission.status,
    column: missionStatusToBoardColumn(mission.status),
    labels: [...mission.labels].sort(compareStrings),
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    ...(mission.startedAt === undefined ? {} : { startedAt: mission.startedAt }),
    ...(mission.finishedAt === undefined ? {} : { finishedAt: mission.finishedAt }),
    durationMs: durationMs(mission.startedAt, mission.finishedAt, asOf),
    progress: taskProgress(sortedTasks(mission)),
    blockedBy: missionBlockedBy(mission),
    latestAttempt: latest ? attemptSummary(latest, asOf) : null,
    proofSummary: proofSummary(mission.proofs, proofIds),
    refs: {
      missionId: mission.id,
      taskIds,
      attemptIds,
      proofIds,
    },
  };
}

function taskCard(
  mission: MissionSnapshot,
  task: MissionTask,
  asOf: string | undefined,
): TaskCardView {
  const latest = latestAttemptForTask(mission, task);
  return {
    version: 1,
    id: task.id,
    missionId: mission.id,
    title: task.title,
    summary: task.description ?? task.title,
    status: task.status,
    column: taskStatusToBoardColumn(task.status),
    priority: task.priority,
    ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
    dependencies: [...task.dependencies],
    blockedBy: taskBlockedBy(mission, task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    durationMs: durationMs(task.startedAt, task.finishedAt, asOf),
    latestAttempt: latest ? attemptSummary(latest, asOf) : null,
    proofSummary: proofSummary(mission.proofs, task.proofIds),
    refs: {
      missionId: mission.id,
      taskId: task.id,
      attemptIds: [...task.attemptIds],
      proofIds: [...task.proofIds],
      ...(latest?.terminal === undefined ? {} : { terminal: latest.terminal }),
      ...(latest?.session === undefined ? {} : { session: latest.session }),
      ...(latest?.worktree === undefined ? {} : { worktree: latest.worktree }),
    },
  };
}

function latestAttemptForTask(mission: MissionSnapshot, task: MissionTask): MissionAttempt | null {
  const latestId = task.attemptIds.at(-1);
  return latestId ? (mission.attempts[latestId] ?? null) : null;
}

function latestMissionAttemptFromHistory(
  mission: MissionSnapshot,
  history: MissionHistoryEntry[],
): MissionAttempt | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index]!.event;
    if (event.type !== "attempt.started" || event.missionId !== mission.id) continue;
    return mission.attempts[event.attemptId] ?? null;
  }
  return null;
}

function attemptSummary(attempt: MissionAttempt, asOf: string | undefined) {
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    status: attempt.status,
    ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
    agent: attempt.agent,
    harness: attempt.harness,
    ...(attempt.model === undefined ? {} : { model: attempt.model }),
    ...(attempt.terminal === undefined ? {} : { terminal: attempt.terminal }),
    ...(attempt.session === undefined ? {} : { session: attempt.session }),
    ...(attempt.worktree === undefined ? {} : { worktree: attempt.worktree }),
    startedAt: attempt.startedAt,
    updatedAt: attempt.updatedAt,
    ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
    durationMs: durationMs(attempt.startedAt, attempt.finishedAt, asOf),
    proofIds: [...attempt.proofIds],
  };
}

function proofSummary(
  proofs: Record<string, MissionProof>,
  proofIds: string[],
): MissionProofSummary {
  const ids = sortedProofIds(proofIds);
  const noProofReasons: string[] = [];
  const commits = new Set<string>();
  const diffSummaries = new Set<string>();
  const diffUrls = new Set<string>();
  const prs = new Map<
    string,
    { number?: number; url?: string; status?: "draft" | "open" | "merged" | "closed" }
  >();
  const artifacts = new Map<string, { name: string; uri: string; kind?: string }>();
  let notesCount = 0;
  let suites = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const id of ids) {
    const proof = proofs[id];
    if (!proof) continue;
    if (proof.noProofReason) noProofReasons.push(proof.noProofReason);
    if (proof.notes) notesCount += 1;
    for (const test of proof.tests ?? []) {
      suites += 1;
      if (test.status === "passed") passed += 1;
      if (test.status === "failed") failed += 1;
      if (test.status === "skipped") skipped += 1;
      total += test.total ?? 0;
    }
    for (const commit of proof.commits ?? []) commits.add(commit.sha);
    if (proof.diff?.summary) diffSummaries.add(proof.diff.summary);
    if (proof.diff?.url) diffUrls.add(proof.diff.url);
    filesChanged += proof.diff?.stats?.filesChanged ?? 0;
    insertions += proof.diff?.stats?.insertions ?? 0;
    deletions += proof.diff?.stats?.deletions ?? 0;
    if (proof.pr) {
      const key = proof.pr.url ?? String(proof.pr.number ?? proof.pr.status ?? "unknown");
      prs.set(key, proof.pr);
    }
    for (const artifact of proof.artifacts ?? []) {
      artifacts.set(`${artifact.name}\u0000${artifact.uri}\u0000${artifact.kind ?? ""}`, artifact);
    }
  }

  return {
    proofIds: ids,
    hasProof: ids.length > 0,
    noProofReasons,
    notesCount,
    tests: { suites, passed, failed, skipped, total },
    commits: [...commits].sort(compareStrings),
    diff: {
      summaries: [...diffSummaries].sort(compareStrings),
      urls: [...diffUrls].sort(compareStrings),
      filesChanged,
      insertions,
      deletions,
    },
    prs: [...prs.values()].sort(comparePrs),
    artifacts: [...artifacts.values()].sort(compareArtifacts),
  };
}

function taskProgress(tasks: MissionTask[]): MissionProgressSummary {
  const progress: MissionProgressSummary = {
    total: tasks.length,
    planned: 0,
    running: 0,
    blocked: 0,
    review: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    done: 0,
  };
  for (const task of tasks) {
    const column = taskStatusToBoardColumn(task.status);
    progress[column] += 1;
    if (task.status === "completed") progress.completed += 1;
    if (task.status === "failed") progress.failed += 1;
    if (task.status === "cancelled") progress.cancelled += 1;
  }
  return progress;
}

function attemptTotals(attempts: MissionAttempt[]) {
  const totals = {
    total: attempts.length,
    submitted: 0,
    approved: 0,
    rejected: 0,
    failed: 0,
    interrupted: 0,
    running: 0,
  };
  for (const attempt of attempts) {
    if (attempt.status === "started") totals.running += 1;
    else totals[attempt.status] += 1;
  }
  return totals;
}

function taskBlockedBy(mission: MissionSnapshot, task: MissionTask): MissionTaskId[] {
  return task.dependencies
    .filter((dependencyId) => mission.tasks[dependencyId]?.status !== "completed")
    .sort(compareStrings);
}

function missionBlockedBy(mission: MissionSnapshot): MissionTaskId[] {
  const blocked = new Set<MissionTaskId>();
  for (const task of Object.values(mission.tasks)) {
    for (const dependencyId of taskBlockedBy(mission, task)) blocked.add(dependencyId);
  }
  return [...blocked].sort(compareStrings);
}

function timelineEntry(mission: MissionSnapshot, entry: MissionHistoryEntry): MissionTimelineEntry {
  const event = entry.event;
  const taskId = "taskId" in event ? event.taskId : undefined;
  const attemptId = "attemptId" in event ? event.attemptId : undefined;
  const proofId = "proofId" in event ? event.proofId : undefined;
  const attempt = attemptId ? mission.attempts[attemptId] : null;
  return {
    version: 1,
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    missionId: event.missionId,
    ...(taskId === undefined ? {} : { taskId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(proofId === undefined ? {} : { proofId }),
    type: event.type,
    label: labelForEvent(event),
    actor: clone(event.actor) as MissionActor,
    ...("reason" in event && event.reason !== undefined ? { reason: event.reason } : {}),
    refs: {
      missionId: event.missionId,
      ...(taskId === undefined ? {} : { taskId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(proofId === undefined ? {} : { proofId }),
      ...(attempt?.terminal === undefined ? {} : { terminal: attempt.terminal }),
      ...(attempt?.session === undefined ? {} : { session: attempt.session }),
      ...(attempt?.worktree === undefined ? {} : { worktree: attempt.worktree }),
    },
  };
}

function labelForEvent(event: MissionEvent): string {
  switch (event.type) {
    case "mission.created":
      return "Mission created";
    case "mission.planned":
      return "Mission planned";
    case "mission.started":
      return "Mission started";
    case "mission.blocked":
      return "Mission blocked";
    case "mission.review":
      return "Mission moved to review";
    case "mission.completed":
      return "Mission completed";
    case "mission.failed":
      return "Mission failed";
    case "mission.cancelled":
      return "Mission cancelled";
    case "task.added":
      return "Task added";
    case "task.updated":
      return "Task updated";
    case "task.ready":
      return "Task ready";
    case "task.claimed":
      return "Task claimed";
    case "task.started":
      return "Task started";
    case "task.blocked":
      return "Task blocked";
    case "task.submitted":
      return "Task submitted";
    case "task.completed":
      return "Task completed";
    case "task.failed":
      return "Task failed";
    case "task.cancelled":
      return "Task cancelled";
    case "attempt.started":
      return "Attempt started";
    case "attempt.submitted":
      return "Attempt submitted";
    case "attempt.approved":
      return "Attempt approved";
    case "attempt.rejected":
      return "Attempt rejected";
    case "attempt.failed":
      return "Attempt failed";
    case "attempt.interrupted":
      return "Attempt interrupted";
    case "proof.recorded":
      return "Proof recorded";
  }
}

function validateStateAndHistory(
  state: MissionProjectState,
  history: MissionHistoryEntry[],
): MissionProjectState {
  const parsed = parseState(state);
  const replayed = replayHistory(history);
  if (stableJson(replayed) !== stableJson(parsed)) {
    throw new MissionProjectionError(
      "Mission projection state does not match mission history replay",
      "MISSION_HISTORY_MISMATCH",
    );
  }
  return parsed;
}

function replayHistory(history: MissionHistoryEntry[]): MissionProjectState {
  try {
    return replayMissionEvents(
      history.map((entry) => ({
        version: 1 as const,
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        payload: entry.event,
      })),
    );
  } catch (error) {
    throw new MissionProjectionError(
      `Invalid mission projection history: ${error instanceof Error ? error.message : String(error)}`,
      "MISSION_PROJECTION_INVALID",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function parseState(state: MissionProjectState): MissionProjectState {
  const parsed = MissionProjectStateSchemaZ.safeParse(clone(state));
  if (!parsed.success) {
    throw new MissionProjectionError(
      `Invalid mission projection state: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "MISSION_PROJECTION_INVALID",
    );
  }
  return parsed.data;
}

function parseAsOf(asOf: string | undefined): string | undefined {
  if (asOf === undefined) return undefined;
  if (!isCanonicalTimestamp(asOf)) {
    throw new MissionProjectionError(
      "Invalid projection asOf timestamp",
      "MISSION_PROJECTION_INVALID",
    );
  }
  return asOf;
}

function sortedMissions(state: MissionProjectState): MissionSnapshot[] {
  return Object.keys(state.missions)
    .sort(compareStrings)
    .map((id) => state.missions[id]!)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function sortedTasks(mission: MissionSnapshot): MissionTask[] {
  return Object.keys(mission.tasks)
    .sort(compareStrings)
    .map((id) => mission.tasks[id]!)
    .sort(compareTasks);
}

function sortedAttempts(mission: MissionSnapshot): MissionAttempt[] {
  const order = new Map<MissionAttemptId, number>();
  for (const task of sortedTasks(mission)) {
    task.attemptIds.forEach((attemptId, index) => {
      order.set(attemptId, order.size * 100000 + index);
    });
  }
  return Object.keys(mission.attempts)
    .sort(compareStrings)
    .map((id) => mission.attempts[id]!)
    .sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.startedAt.localeCompare(b.startedAt) ||
        a.id.localeCompare(b.id),
    );
}

function compareTasks(a: MissionTask, b: MissionTask): number {
  return (
    b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}

function compareMissionCards(a: MissionCardView, b: MissionCardView): number {
  return (
    Number(isTerminalMission(a.status)) - Number(isTerminalMission(b.status)) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function compareTaskCards(a: TaskCardView, b: TaskCardView): number {
  return (
    Number(isTerminalTask(a.status)) - Number(isTerminalTask(b.status)) ||
    b.priority - a.priority ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function comparePrs(
  a: { number?: number; url?: string; status?: string },
  b: { number?: number; url?: string; status?: string },
): number {
  return (
    (a.number ?? 0) - (b.number ?? 0) ||
    (a.url ?? "").localeCompare(b.url ?? "") ||
    (a.status ?? "").localeCompare(b.status ?? "")
  );
}

function compareArtifacts(
  a: { name: string; uri: string; kind?: string },
  b: { name: string; uri: string; kind?: string },
): number {
  return (
    a.name.localeCompare(b.name) ||
    a.uri.localeCompare(b.uri) ||
    (a.kind ?? "").localeCompare(b.kind ?? "")
  );
}

function sortedProofIds(ids: string[]): MissionProofId[] {
  return [...new Set(ids)].sort(compareStrings) as MissionProofId[];
}

function countsFor<T>(columns: Record<MissionBoardColumn, T[]>) {
  return {
    planned: columns.planned.length,
    running: columns.running.length,
    blocked: columns.blocked.length,
    review: columns.review.length,
    done: columns.done.length,
    total: BOARD_COLUMNS.reduce((sum, column) => sum + columns[column].length, 0),
  };
}

function emptyColumns<T>(): Record<MissionBoardColumn, T[]> {
  return { planned: [], running: [], blocked: [], review: [], done: [] };
}

function durationMs(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  asOf: string | undefined,
): number | null {
  if (!startedAt) return null;
  const end = finishedAt ?? asOf;
  if (!end) return null;
  return Date.parse(end) - Date.parse(startedAt);
}

function lastMeaningfulTimelineEntry(entries: MissionTimelineEntry[]): MissionTimelineEntry | null {
  return entries.at(-1) ?? null;
}

function isTerminalMission(
  status: MissionStatus,
): status is (typeof TERMINAL_MISSION_STATUSES)[number] {
  return TERMINAL_MISSION_STATUSES.includes(status as (typeof TERMINAL_MISSION_STATUSES)[number]);
}

function terminalMissionOutcome(
  mission: MissionSnapshot,
): (typeof TERMINAL_MISSION_STATUSES)[number] {
  if (isTerminalMission(mission.status)) return mission.status;
  throw new MissionProjectionError(
    `Mission "${mission.id}" is not terminal`,
    "MISSION_PROJECTION_INVALID",
  );
}

function isTerminalTask(
  status: MissionTaskStatus,
): status is (typeof TERMINAL_TASK_STATUSES)[number] {
  return TERMINAL_TASK_STATUSES.includes(status as (typeof TERMINAL_TASK_STATUSES)[number]);
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortObject(item)]),
    );
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseBoard(value: MissionBoardView): MissionBoardView {
  const parsed = MissionBoardViewSchemaZ.safeParse(clone(value));
  if (!parsed.success) throw projectionValidationError("board", parsed.error);
  return parsed.data;
}

function parseDetail(value: MissionDetailView): MissionDetailView {
  const parsed = MissionDetailViewSchemaZ.safeParse(clone(value));
  if (!parsed.success) throw projectionValidationError("detail", parsed.error);
  return parsed.data;
}

function parseHistorySummary(value: MissionHistorySummary): MissionHistorySummary {
  const parsed = MissionHistorySummarySchemaZ.safeParse(clone(value));
  if (!parsed.success) throw projectionValidationError("history summary", parsed.error);
  return parsed.data;
}

function parseTimelineEntry(value: MissionTimelineEntry): MissionTimelineEntry {
  const parsed = MissionTimelineEntrySchemaZ.safeParse(clone(value));
  if (!parsed.success) throw projectionValidationError("timeline entry", parsed.error);
  return parsed.data;
}

function projectionValidationError(label: string, cause: Error): MissionProjectionError {
  return new MissionProjectionError(
    `Invalid mission projection ${label}: ${cause.message}`,
    "MISSION_PROJECTION_INVALID",
    { cause },
  );
}
