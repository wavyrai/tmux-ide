import type {
  DesktopMissionActivityEvent,
  DesktopMissionHistorySummary,
  DesktopMissionSummary,
  DesktopMissionWorkspaceResource,
} from "@tmux-ide/contracts";
import { For, Show, createMemo, createUniqueId } from "solid-js";

import { Button } from "../ui-system/index.ts";
import { DomIcon } from "./dom-icon.tsx";

export interface MissionActivitySurfaceProps {
  readonly mode: "missions" | "activity";
  readonly resource?: DesktopMissionWorkspaceResource;
  readonly selectedMissionId: string | null;
  readonly selectedActivityId: string | null;
  readonly onSelectMission: (missionId: string) => void;
  readonly onSelectActivity: (activityId: string) => void;
  readonly onOpenMissions: (missionId: string) => void;
  readonly onOpenActivity: (missionId: string) => void;
  readonly onOpenTerminals: () => void;
  readonly onRefresh?: () => void;
}

function timestamp(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)}Z`;
}

function duration(value: number | null): string {
  if (value === null) return "In progress";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(value / 1_000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function progress(mission: DesktopMissionSummary): number {
  return mission.progress.total === 0
    ? mission.status === "completed"
      ? 100
      : 0
    : Math.round((mission.progress.done / mission.progress.total) * 100);
}

function nextActionLabel(mission: DesktopMissionSummary): string {
  if (mission.status === "blocked") return "Review blocker trail";
  if (mission.status === "review") return "Review proof trail";
  if (mission.status === "completed" || mission.status === "failed") return "Inspect outcome";
  return "Follow activity";
}

function moveOptionFocus(event: KeyboardEvent): void {
  const list = event.currentTarget as HTMLElement;
  const options = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  if (options.length === 0) return;
  if (event.key === "Enter" || event.key === " ") {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && options.includes(active)) {
      event.preventDefault();
      active.click();
    }
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, current - 1)
          : Math.min(options.length - 1, current + 1);
  event.preventDefault();
  options[next]?.focus();
}

function MissionDetail(props: {
  mission: DesktopMissionSummary;
  history: DesktopMissionHistorySummary | undefined;
  headingId: string;
  onOpenActivity: (missionId: string) => void;
}) {
  const evidence = () => props.mission.proof;
  return (
    <article class="mission-journey__detail" aria-labelledby={props.headingId}>
      <header>
        <div>
          <span class="mission-journey__status" data-status={props.mission.status}>
            {props.mission.status}
          </span>
          <h3 id={props.headingId}>{props.mission.title}</h3>
        </div>
        <time dateTime={props.mission.updatedAt}>{timestamp(props.mission.updatedAt)}</time>
      </header>
      <p class="mission-journey__summary">{props.mission.summary}</p>
      <section class="mission-progress" aria-label={`${progress(props.mission)}% complete`}>
        <div>
          <span>Mission progress</span>
          <strong>{progress(props.mission)}%</strong>
        </div>
        <progress value={progress(props.mission)} max="100">
          {progress(props.mission)}%
        </progress>
        <small>
          {props.mission.progress.done} of {props.mission.progress.total} tasks closed
          <Show when={props.mission.blockedCount > 0}>
            {` · ${props.mission.blockedCount} blocked`}
          </Show>
        </small>
      </section>
      <div class="mission-proof-grid">
        <section data-tone={evidence().hasProof ? "verified" : "attention"}>
          <span>Proof</span>
          <strong>{evidence().hasProof ? `${evidence().proofCount} recorded` : "Missing"}</strong>
          <small>
            {evidence().tests.passed}/{evidence().tests.total} tests passing
          </small>
        </section>
        <section>
          <span>Change evidence</span>
          <strong>{evidence().filesChanged} files</strong>
          <small>
            +{evidence().insertions} −{evidence().deletions} · {evidence().commitCount} commits
          </small>
        </section>
        <section>
          <span>Latest attempt</span>
          <strong>{props.mission.latestAttempt?.status ?? "Not started"}</strong>
          <small>
            {props.mission.latestAttempt
              ? `${props.mission.latestAttempt.agent} · ${props.mission.latestAttempt.harness}`
              : "No implementer attempt recorded"}
          </small>
        </section>
      </div>
      <Show when={!evidence().hasProof && evidence().noProofReasons.length > 0}>
        <div class="mission-journey__proof-warning" role="note">
          <DomIcon id="activity" usage="action" />
          <span>{evidence().noProofReasons[0]}</span>
        </div>
      </Show>
      <Show when={props.history}>
        {(history) => (
          <section class="mission-journey__history" aria-label="Recorded mission outcome">
            <span>Recorded outcome</span>
            <strong>{history().outcome}</strong>
            <small>
              {history().attempts.total} attempts · {history().attempts.approved} approved ·{" "}
              {history().attempts.failed} failed
            </small>
            <Show when={history().lastEventLabel}>
              <small>{history().lastEventLabel}</small>
            </Show>
          </section>
        )}
      </Show>
      <footer>
        <span>
          Duration <strong>{duration(props.mission.durationMs)}</strong>
        </span>
        <Button
          size="small"
          variant="primary"
          onClick={() => props.onOpenActivity(props.mission.id)}
        >
          <DomIcon id="activity" usage="action" />
          {nextActionLabel(props.mission)}
        </Button>
      </footer>
    </article>
  );
}

function ActivityDetail(props: {
  event: DesktopMissionActivityEvent;
  mission: DesktopMissionSummary | undefined;
  headingId: string;
  onOpenMissions: (missionId: string) => void;
}) {
  return (
    <article class="mission-journey__detail activity-detail" aria-labelledby={props.headingId}>
      <header>
        <div>
          <span class="mission-journey__status" data-status="activity">
            {props.event.type}
          </span>
          <h3 id={props.headingId}>{props.event.label}</h3>
        </div>
        <time dateTime={props.event.timestamp}>{timestamp(props.event.timestamp)}</time>
      </header>
      <p class="mission-journey__summary">
        {props.event.reason ?? "This durable mission event did not include an additional reason."}
      </p>
      <dl class="activity-detail__facts">
        <div>
          <dt>Mission</dt>
          <dd>{props.mission?.title ?? props.event.missionId}</dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{props.event.actor.label}</dd>
        </div>
        <div>
          <dt>Sequence</dt>
          <dd>#{props.event.sequence}</dd>
        </div>
      </dl>
      <Show when={props.mission}>
        {(mission) => (
          <div class="activity-detail__proof">
            <span>Proof at current mission state</span>
            <strong>
              {mission().proof.hasProof
                ? `${mission().proof.proofCount} proof records · ${mission().proof.tests.passed}/${mission().proof.tests.total} tests`
                : "No proof recorded yet"}
            </strong>
          </div>
        )}
      </Show>
      <footer>
        <span>Durable event history</span>
        <Button
          size="small"
          variant="primary"
          onClick={() => props.onOpenMissions(props.event.missionId)}
        >
          <DomIcon id="missions" usage="action" />
          Inspect mission
        </Button>
      </footer>
    </article>
  );
}

export function MissionActivitySurface(props: MissionActivitySurfaceProps) {
  const instanceId = createUniqueId();
  const payload = createMemo(() => {
    const resource = props.resource;
    return resource?.status === "ready" || resource?.status === "empty" ? resource : null;
  });
  const selectedMission = createMemo(() => {
    const missions = payload()?.missions ?? [];
    return (
      missions.find((mission) => mission.id === props.selectedMissionId) ?? missions[0] ?? null
    );
  });
  const selectedActivity = createMemo(() => {
    const activity = payload()?.activity ?? [];
    return activity.find((event) => event.id === props.selectedActivityId) ?? activity[0] ?? null;
  });
  const selectedActivityMission = createMemo(() => {
    const event = selectedActivity();
    return event
      ? payload()?.missions.find((mission) => mission.id === event.missionId)
      : undefined;
  });
  const selectedMissionHistory = createMemo(() => {
    const mission = selectedMission();
    return mission
      ? payload()?.history.find((entry) => entry.mission.id === mission.id)
      : undefined;
  });

  return (
    <div
      class="mission-journey"
      data-mode={props.mode}
      data-state={props.resource?.status ?? "absent"}
    >
      <Show when={props.resource?.status === "degraded" || props.resource === undefined}>
        <section class="mission-journey__state" role="status">
          <span class="mission-journey__state-icon">
            <DomIcon id="refresh" usage="rail" />
          </span>
          <div>
            <small>Mission recovery</small>
            <h3>Mission history needs attention</h3>
            <p>
              {props.resource?.status === "degraded"
                ? props.resource.reason
                : "This daemon generation did not publish a desktop mission snapshot."}
            </p>
            <span>The terminal workspace remains available and no mission data is invented.</span>
          </div>
          <div class="mission-journey__state-actions">
            <Show when={props.onRefresh}>
              <Button size="small" variant="primary" onClick={() => props.onRefresh?.()}>
                Retry mission history
              </Button>
            </Show>
            <Button size="small" variant="secondary" onClick={props.onOpenTerminals}>
              Open terminals
            </Button>
          </div>
        </section>
      </Show>

      <Show when={props.resource?.status === "empty"}>
        <section class="mission-journey__state" data-empty="true">
          <span class="mission-journey__state-icon">
            <DomIcon id="missions" usage="rail" />
          </span>
          <div>
            <small>Mission control</small>
            <h3>No missions recorded yet</h3>
            <p>
              Start a mission from an agent terminal. Durable status and proof will appear here.
            </p>
            <span>No configuration file is required for this workspace.</span>
          </div>
          <Button size="small" variant="primary" onClick={props.onOpenTerminals}>
            Open terminals
          </Button>
        </section>
      </Show>

      <Show when={props.resource?.status === "ready"}>
        <div class="mission-journey__toolbar">
          <div>
            <strong>{props.mode === "missions" ? "Mission control" : "Mission activity"}</strong>
            <span>
              {payload()?.counts.missions} missions · {payload()?.counts.history} outcomes ·{" "}
              {payload()?.counts.activity} events
            </span>
          </div>
          <Show when={payload()?.truncated}>
            <span class="mission-journey__bounded">Showing latest bounded view</span>
          </Show>
          <Show when={props.onRefresh}>
            <Button size="small" variant="ghost" onClick={() => props.onRefresh?.()}>
              <DomIcon id="refresh" usage="action" />
              Refresh
            </Button>
          </Show>
        </div>

        <div class="mission-journey__workspace">
          <Show
            when={props.mode === "missions"}
            fallback={
              <div
                class="mission-journey__list activity-list"
                role="listbox"
                aria-label="Mission activity"
                onKeyDown={moveOptionFocus}
              >
                <For each={payload()?.activity}>
                  {(event) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedActivity()?.id === event.id}
                      tabIndex={selectedActivity()?.id === event.id ? 0 : -1}
                      onFocus={() => props.onSelectActivity(event.id)}
                      onClick={() => props.onSelectActivity(event.id)}
                    >
                      <i aria-hidden="true" />
                      <span>
                        <strong>{event.label}</strong>
                        <small>
                          {event.actor.label} · {timestamp(event.timestamp)}
                        </small>
                      </span>
                      <code>#{event.sequence}</code>
                    </button>
                  )}
                </For>
              </div>
            }
          >
            <div
              class="mission-journey__list"
              role="listbox"
              aria-label="Missions"
              onKeyDown={moveOptionFocus}
            >
              <For each={payload()?.missions}>
                {(mission) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedMission()?.id === mission.id}
                    tabIndex={selectedMission()?.id === mission.id ? 0 : -1}
                    onFocus={() => props.onSelectMission(mission.id)}
                    onClick={() => props.onSelectMission(mission.id)}
                  >
                    <span class="mission-journey__status-dot" data-status={mission.status} />
                    <span>
                      <strong>{mission.title}</strong>
                      <small>
                        {mission.status} · {progress(mission)}% · {mission.proof.proofCount} proof
                      </small>
                    </span>
                    <time dateTime={mission.updatedAt}>{mission.updatedAt.slice(5, 10)}</time>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={props.mode === "missions" ? selectedMission() : selectedActivity()}>
            {props.mode === "missions" ? (
              <MissionDetail
                mission={selectedMission()!}
                history={selectedMissionHistory()}
                headingId={`${instanceId}-mission-detail`}
                onOpenActivity={props.onOpenActivity}
              />
            ) : (
              <ActivityDetail
                event={selectedActivity()!}
                mission={selectedActivityMission()}
                headingId={`${instanceId}-activity-detail`}
                onOpenMissions={props.onOpenMissions}
              />
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
