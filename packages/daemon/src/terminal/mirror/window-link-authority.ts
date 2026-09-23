import { randomUUID } from "node:crypto";
import {
  WINDOW_LINK_MAX_LINKS,
  WindowLinkTargetSchemaZ,
  WindowLinkTopologySchemaZ,
  WorkspaceCatalogLiveSessionIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
  type WindowLinkTarget,
  type WindowLinkTopology,
} from "@tmux-ide/contracts";

/** Trusted native observation. Native addresses never become public link handles. */
export interface NativeWindowLinkObservation {
  readonly index: number;
  readonly runtimeWindowId: string;
  readonly semanticWindowId: string;
  readonly active: boolean;
}

export interface ResolvedWindowLink {
  readonly runtimeSessionId: string;
  readonly runtimeWindowId: string;
  readonly index: number;
}

export type WindowLinkRefusal =
  | "window_link_stale"
  | "window_link_session_mismatch"
  | "window_link_backing_mismatch"
  | "window_link_ambiguous";

export class WindowLinkResolutionError extends Error {
  constructor(readonly reason: WindowLinkRefusal) {
    super(reason);
    this.name = "WindowLinkResolutionError";
  }
}

interface LinkRecord extends NativeWindowLinkObservation {
  readonly linkId: string;
}

/**
 * One authority per daemon/server/session incarnation. This is an observation
 * model, not an immutable native winlink identity: unobserved unlink/relink ABA
 * is unknowable. Resolved targets still require an execution-time native guard.
 * Not installed into the v1 stream; C2 activates it with the complete link-aware
 * producer/consumer boundary.
 */
export class WindowLinkAuthority {
  private records = new Map<number, LinkRecord>();
  private revision = 0;
  private topology: WindowLinkTopology | null = null;
  private disposed = false;

  constructor(
    readonly liveSessionId: string,
    private readonly runtimeSessionId: string,
  ) {
    WorkspaceCatalogLiveSessionIdSchemaZ.parse(liveSessionId);
    if (
      !/^\$(?:0|[1-9]\d{0,15})$/u.test(runtimeSessionId) ||
      !Number.isSafeInteger(Number(runtimeSessionId.slice(1)))
    )
      throw new TypeError("Invalid native session id");
  }

  /** A malformed fresh observation revokes old actions; no partial topology is published. */
  reconcile(observations: readonly NativeWindowLinkObservation[]): WindowLinkTopology {
    try {
      return this.stageAndPublish(observations);
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  private stageAndPublish(
    observations: readonly NativeWindowLinkObservation[],
  ): WindowLinkTopology {
    if (this.disposed) throw new WindowLinkResolutionError("window_link_stale");
    if (observations.length === 0 || observations.length > WINDOW_LINK_MAX_LINKS)
      throw new TypeError("Invalid window link count");
    const indexes = new Set<number>();
    const semanticByRuntime = new Map<string, string>();
    const runtimeBySemantic = new Map<string, string>();
    let activeCount = 0;
    for (const row of observations) {
      if (
        !Number.isSafeInteger(row.index) ||
        row.index < 0 ||
        indexes.has(row.index) ||
        !/^@(?:0|[1-9]\d{0,15})$/u.test(row.runtimeWindowId) ||
        !Number.isSafeInteger(Number(row.runtimeWindowId.slice(1))) ||
        typeof row.active !== "boolean"
      )
        throw new TypeError("Malformed native window link observation");
      TerminalAttachmentSemanticWindowIdSchemaZ.parse(row.semanticWindowId);
      indexes.add(row.index);
      if (row.active) activeCount++;
      const semantic = semanticByRuntime.get(row.runtimeWindowId);
      const runtime = runtimeBySemantic.get(row.semanticWindowId);
      if (
        (semantic !== undefined && semantic !== row.semanticWindowId) ||
        (runtime !== undefined && runtime !== row.runtimeWindowId)
      )
        throw new TypeError("Window backing identity is inconsistent");
      semanticByRuntime.set(row.runtimeWindowId, row.semanticWindowId);
      runtimeBySemantic.set(row.semanticWindowId, row.runtimeWindowId);
    }
    if (activeCount !== 1) throw new TypeError("Expected one active window link");
    const rows = [...observations].sort((left, right) => left.index - right.index);
    const changed =
      rows.length !== this.records.size ||
      rows.some((row) => {
        const prior = this.records.get(row.index);
        return (
          prior?.runtimeWindowId !== row.runtimeWindowId ||
          prior?.semanticWindowId !== row.semanticWindowId
        );
      });
    const revision = this.revision + (changed ? 1 : 0);
    if (!Number.isSafeInteger(revision)) throw new RangeError("Window link revision exhausted");
    const next = new Map<number, LinkRecord>();
    for (const row of rows) {
      const prior = this.records.get(row.index);
      const retained =
        prior?.runtimeWindowId === row.runtimeWindowId &&
        prior.semanticWindowId === row.semanticWindowId;
      next.set(row.index, {
        ...row,
        linkId: retained ? prior.linkId : `window-link.${randomUUID().replaceAll("-", "")}`,
      });
    }
    const records = [...next.values()];
    const topology = WindowLinkTopologySchemaZ.parse({
      liveSessionId: this.liveSessionId,
      linkRevision: revision,
      activeLinkId: records.find((row) => row.active)!.linkId,
      links: records.map((row) => ({
        linkId: row.linkId,
        semanticWindowId: row.semanticWindowId,
        displayIndex: row.index,
      })),
    });
    this.records = next;
    this.revision = revision;
    this.topology = topology;
    return this.snapshot()!;
  }

  snapshot(): WindowLinkTopology | null {
    return this.topology
      ? { ...this.topology, links: this.topology.links.map((link) => ({ ...link })) }
      : null;
  }

  /** Reconnect/gap/discontinuous observation must retire all previously issued handles. */
  invalidate(): void {
    this.records.clear();
    this.topology = null;
    this.revision++;
    if (!Number.isSafeInteger(this.revision)) this.disposed = true;
  }

  dispose(): void {
    this.invalidate();
    this.disposed = true;
  }

  resolve(target: WindowLinkTarget): ResolvedWindowLink {
    WindowLinkTargetSchemaZ.parse(target);
    if (target.liveSessionId !== this.liveSessionId)
      throw new WindowLinkResolutionError("window_link_session_mismatch");
    if (!this.topology || this.disposed || target.linkRevision !== this.revision)
      throw new WindowLinkResolutionError("window_link_stale");
    const record = [...this.records.values()].find((row) => row.linkId === target.linkId);
    if (!record) throw new WindowLinkResolutionError("window_link_stale");
    if (record.semanticWindowId !== target.expectedSemanticWindowId)
      throw new WindowLinkResolutionError("window_link_backing_mismatch");
    return {
      runtimeSessionId: this.runtimeSessionId,
      runtimeWindowId: record.runtimeWindowId,
      index: record.index,
    };
  }

  /** Legacy backing-only selection is safe only when exactly one link applies. */
  uniqueTargetForBacking(semanticWindowId: string): WindowLinkTarget {
    if (!this.topology || this.disposed) throw new WindowLinkResolutionError("window_link_stale");
    const links = [...this.records.values()].filter(
      (row) => row.semanticWindowId === semanticWindowId,
    );
    if (links.length === 0) throw new WindowLinkResolutionError("window_link_stale");
    if (links.length !== 1) throw new WindowLinkResolutionError("window_link_ambiguous");
    return {
      liveSessionId: this.liveSessionId,
      linkId: links[0]!.linkId,
      expectedSemanticWindowId: semanticWindowId,
      linkRevision: this.revision,
    };
  }
}
