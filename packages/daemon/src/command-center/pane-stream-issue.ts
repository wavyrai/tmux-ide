import type { Hono } from "hono";
import {
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamIssueDescriptorSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  type PaneStreamIssueResult,
  type TerminalIssueErrorCode,
  type PaneStreamLeaseRequest,
} from "@tmux-ide/contracts";

import type { WorkspaceRegistry } from "../lib/workspace-registry.ts";
import { decideOwnerAuthority } from "./owner-authority.ts";
import { PaneStreamLeaseError } from "../terminal/pane-stream/lease-manager.ts";
import {
  PaneStreamAdmissionError,
  type PaneStreamDescriptor,
} from "../terminal/pane-stream/pane-stream-websocket.ts";

const MAX_ISSUE_REQUEST_BYTES = 16 * 1024;

export interface PaneStreamIssueBackend {
  issue(
    request: PaneStreamLeaseRequest,
    context: {
      readonly requestId: string;
      readonly projectIdentity: string;
      readonly sessionName: string;
      readonly rendererOrigin: string;
      readonly hostClientId: string;
    },
  ): Promise<PaneStreamDescriptor>;
}

export interface PaneStreamIssueRouteOptions {
  readonly daemonInstanceId: string;
  readonly ownerToken: string | null;
  readonly workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  readonly backend: PaneStreamIssueBackend | null;
}

/** One issue-error vocabulary for both lease families — see issue-error.ts. */
function issueError(
  code: TerminalIssueErrorCode,
  reason: string,
  retryable = false,
): PaneStreamIssueResult {
  return PaneStreamIssueResultSchemaZ.parse({
    status: "error",
    error: { code, reason, retryable },
  });
}

function response(result: PaneStreamIssueResult): Response {
  const parsed = PaneStreamIssueResultSchemaZ.parse(result);
  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_ISSUE_REQUEST_BYTES) {
        await reader.cancel();
        throw new TypeError("request too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function exactHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (!value || value.includes(",") || /[\0\r\n]/u.test(value)) return null;
  return value;
}

function canonicalRendererOrigin(value: string | null): string | null {
  if (
    !value ||
    value.length > 2_048 ||
    value === "null" ||
    value === "*" ||
    /[\0\r\n\t ,]/u.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      !/^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) ||
      url.protocol === "file:" ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash ||
      !url.hostname
    ) {
      return null;
    }
    const canonical = `${url.protocol}//${url.host}`;
    return canonical === value ? canonical : null;
  } catch {
    return null;
  }
}

function mapBackendError(error: unknown): PaneStreamIssueResult {
  if (error instanceof PaneStreamLeaseError) {
    switch (error.code) {
      case "interactive-viewer-conflict":
        return issueError(
          "interactive-viewer-conflict",
          "A requested pane already has an interactive viewer.",
          true,
        );
      case "duplicate-request":
      case "invalid-request":
        return issueError("invalid-request", "Pane-stream request is invalid.");
      default:
        return issueError("attachment-unavailable", "Pane streaming is unavailable.", true);
    }
  }
  if (error instanceof PaneStreamAdmissionError) {
    switch (error.code) {
      case "daemon-shutting-down":
        return issueError("disposed", "Pane-stream admission is stopping.", true);
      case "invalid-origin":
        return issueError("invalid-request", "Pane-stream request is invalid.");
      case "pane-not-found":
        return issueError("pane-not-found", "A requested pane is unavailable.");
      case "pending-capacity-exhausted":
      case "preauth-capacity-exhausted":
      case "live-capacity-exhausted":
        return issueError("attachment-unavailable", "Pane streaming is unavailable.", true);
      default:
        return issueError("attachment-unavailable", "Pane streaming is unavailable.");
    }
  }
  return issueError("attachment-unavailable", "Pane streaming is unavailable.", true);
}

/**
 * Mounts the owner-only pane-stream issue mutation before project auth — the
 * same broker conventions as the terminal-attachment issue route: main-process
 * owner bearer, exact daemon-identity headers, bounded strict JSON. Remote
 * access tokens and renderer-authored identities never substitute.
 */
export function mountPaneStreamIssueRoute(app: Hono, options: PaneStreamIssueRouteOptions): void {
  app.post(PANE_STREAM_ISSUE_PATH, async (c) => {
    const invalid = () =>
      response(issueError("invalid-request", "Pane-stream request is invalid."));
    const request = c.req.raw;
    if (new URL(request.url).search.length > 0) return invalid();
    // Owner-only; ownerless rejects, because this route answers a typed issue
    // envelope rather than a status code and must never leak which half failed.
    const owner = decideOwnerAuthority(
      request.headers.get("Authorization"),
      options.ownerToken,
      "reject",
    );
    if (owner.kind !== "authorized") {
      return response(issueError("invalid-request", "Pane-stream request was rejected."));
    }
    if (exactHeader(request, "Content-Type")?.toLowerCase() !== "application/json") {
      return invalid();
    }
    const origin = canonicalRendererOrigin(exactHeader(request, "Origin"));
    const requestId = exactHeader(request, "X-Tmux-Ide-Request-Id");
    const expectedInstanceId = exactHeader(request, "X-Tmux-Ide-Expected-Daemon-Instance-Id");
    const hostClientId = exactHeader(request, "X-Tmux-Ide-Host-Client-Id");
    if (!origin || !requestId || !expectedInstanceId || !hostClientId) return invalid();

    let raw: unknown;
    try {
      raw = await readBoundedJson(request);
    } catch {
      return invalid();
    }
    const parsed = PaneStreamIssueMutationRequestSchemaZ.safeParse(raw);
    if (!parsed.success) return invalid();
    if (
      parsed.data.requestId !== requestId ||
      parsed.data.expectedDaemonInstanceId !== expectedInstanceId ||
      parsed.data.expectedDaemonInstanceId !== options.daemonInstanceId
    ) {
      return response(
        issueError(
          "daemon-identity-mismatch",
          "The daemon generation changed before the pane-stream issue.",
          true,
        ),
      );
    }
    if (!options.backend) {
      return response(
        issueError("daemon-unavailable", "Pane-stream admission is unavailable.", true),
      );
    }
    const workspace = options.workspaceRegistry.get(parsed.data.stream.workspaceName);
    if (!workspace) {
      return response(issueError("workspace-not-found", "The requested workspace is unavailable."));
    }

    try {
      const descriptor = await options.backend.issue(parsed.data.stream, {
        requestId: parsed.data.requestId,
        projectIdentity: workspace.name,
        sessionName: workspace.sessionName,
        rendererOrigin: origin,
        hostClientId,
      });
      return response({
        status: "issued",
        descriptor: PaneStreamIssueDescriptorSchemaZ.parse({
          ...descriptor,
          subprotocol: PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
        }),
      });
    } catch (error) {
      return response(mapBackendError(error));
    }
  });
}
