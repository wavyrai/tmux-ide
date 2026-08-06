/**
 * A wire-to-pixel flight recorder for the first interactive attachment.
 *
 * A locator timeout can only say that the terminal did not appear. This probe
 * names the product boundary that did appear: HTTP issue, WebSocket redeem,
 * ready, initial output, renderer commit, or painted marker. It deliberately
 * records frame TYPES and byte counts only — the one-use redemption ticket is
 * never copied into an artifact.
 */
import type { Page, TestInfo, WebSocket } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import type { RunningDaemon } from "./daemon.ts";
import type { ScratchFleet } from "./scratch-fleet.ts";

const ISSUE_PATH = "/api/v1/terminal/attachments/issue";
const REDEEM_PATH = "/v1/terminal/attachments/redeem";

export const FIRST_ATTACH_PHASES = [
  "issue-request",
  "issue-response",
  "socket-observed",
  "redeem-frame",
  "ready-frame",
  "first-output-frame",
  "surface-connected",
  "seed-committed",
  "first-paint",
] as const;

export type FirstAttachPhase = (typeof FIRST_ATTACH_PHASES)[number];

interface PhaseEntry {
  readonly phase: FirstAttachPhase;
  readonly elapsedMs: number;
  readonly detail?: string;
}

interface PhaseWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function frameType(payload: string): string | null {
  try {
    const value = JSON.parse(payload) as { readonly type?: unknown };
    return typeof value.type === "string" ? value.type : null;
  } catch {
    return null;
  }
}

export interface FirstAttachDiagnosticsContext {
  readonly page: Page;
  readonly daemon: RunningDaemon;
  readonly fleet: ScratchFleet;
  readonly sessionName: string;
  readonly testInfo: TestInfo;
}

export class FirstAttachProbe {
  readonly #startedAt = Date.now();
  readonly #entries: PhaseEntry[] = [];
  readonly #observations: string[] = [];
  readonly #reached = new Map<FirstAttachPhase, PhaseEntry>();
  readonly #waiters = new Map<FirstAttachPhase, Set<PhaseWaiter>>();
  #firstIssueSeen = false;
  #firstSocketSeen = false;
  #artifactAttached = false;

  constructor(page: Page) {
    page.on("request", (request) => {
      if (this.#firstIssueSeen || !new URL(request.url()).pathname.endsWith(ISSUE_PATH)) return;
      this.#firstIssueSeen = true;
      this.mark("issue-request", `${request.method()} ${ISSUE_PATH}`);
    });
    page.on("response", (response) => {
      if (!this.#firstIssueSeen || this.#reached.has("issue-response")) return;
      if (!new URL(response.url()).pathname.endsWith(ISSUE_PATH)) return;
      if (response.ok()) {
        this.mark("issue-response", `HTTP ${response.status()}`);
      } else {
        this.#observe(`issue response was HTTP ${response.status()}`);
      }
    });
    page.on("websocket", (socket) => this.#observeSocket(socket));
  }

  mark(phase: FirstAttachPhase, detail?: string): void {
    if (this.#reached.has(phase)) return;
    const entry: PhaseEntry = {
      phase,
      elapsedMs: Date.now() - this.#startedAt,
      ...(detail ? { detail } : {}),
    };
    this.#entries.push(entry);
    this.#reached.set(phase, entry);
    const waiters = this.#waiters.get(phase);
    if (!waiters) return;
    this.#waiters.delete(phase);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  async require(phase: FirstAttachPhase, timeoutMs = 30_000): Promise<void> {
    if (this.#reached.has(phase)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.#waiters.get(phase);
        waiters?.delete(waiter);
        reject(
          new Error(`first attachment stalled after "${this.lastCompleted()}"; missing "${phase}"`),
        );
      }, timeoutMs);
      const waiter: PhaseWaiter = { resolve, reject, timer };
      const waiters = this.#waiters.get(phase) ?? new Set<PhaseWaiter>();
      waiters.add(waiter);
      this.#waiters.set(phase, waiters);
    });
  }

  lastCompleted(): FirstAttachPhase | "nothing" {
    for (const phase of [...FIRST_ATTACH_PHASES].reverse()) {
      if (this.#reached.has(phase)) return phase;
    }
    return "nothing";
  }

  entries(): readonly PhaseEntry[] {
    return this.#entries;
  }

  async attachArtifact(context: FirstAttachDiagnosticsContext, failure?: unknown): Promise<void> {
    if (this.#artifactAttached) return;
    this.#artifactAttached = true;
    const terminalSurfaces = await context.page
      .locator(".terminal-surface")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          phase: node.getAttribute("data-phase"),
          preservesFrame: node.getAttribute("data-preserves-frame"),
          sourceGrid: node.getAttribute("data-source-grid"),
          clientViewport: node.getAttribute("data-client-viewport"),
          text: (node.textContent ?? "").trim().slice(0, 500),
        })),
      )
      .catch(() => []);
    const readiness = await context.daemon.readiness().catch(() => null);
    const paneCapture = (() => {
      try {
        return context.fleet.capturePane(context.sessionName).slice(-4_000);
      } catch (error) {
        return `capture failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    const artifact = {
      result: failure === undefined ? "passed" : "failed",
      failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      lastCompleted: this.lastCompleted(),
      phases: FIRST_ATTACH_PHASES.map((phase) => ({
        phase,
        status: this.#reached.has(phase) ? "observed" : "missing",
        ...this.#reached.get(phase),
      })),
      observations: this.#observations,
      terminalSurfaces,
      startupReadiness: readiness,
      tmuxCapture: paneCapture,
    };
    const path = context.testInfo.outputPath("first-attach-phases.json");
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await context.testInfo.attach("first-attach-phases.json", {
      path,
      contentType: "application/json",
    });
  }

  #observeSocket(socket: WebSocket): void {
    if (this.#firstSocketSeen || !new URL(socket.url()).pathname.endsWith(REDEEM_PATH)) return;
    this.#firstSocketSeen = true;
    this.mark("socket-observed", REDEEM_PATH);
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && frameType(payload) === "redeem") {
        this.mark("redeem-frame", "one-use ticket sent (contents redacted)");
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") {
        const type = frameType(payload);
        if (type === "ready") {
          this.mark("ready-frame", "daemon accepted lease");
        } else if (type) {
          this.#observe(`received control frame "${type}" before first paint`);
        }
        return;
      }
      this.mark("first-output-frame", `${payload.byteLength} bytes`);
    });
    socket.on("socketerror", (error) => this.#observe(`attachment socket error: ${error}`));
    socket.on("close", () => this.#observe("attachment socket closed"));
  }

  #observe(detail: string): void {
    this.#observations.push(`+${Date.now() - this.#startedAt}ms ${detail}`);
  }
}
