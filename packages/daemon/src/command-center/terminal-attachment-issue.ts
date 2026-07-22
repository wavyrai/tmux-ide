import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import {
  TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL,
  TerminalAttachmentIssueDescriptorSchemaZ,
  TerminalAttachmentIssueMutationRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentIssueErrorCode,
  type TerminalAttachmentIssueResult,
} from "@tmux-ide/contracts";

import type { WorkspaceRegistry } from "../lib/workspace-registry.ts";
import {
  AttachmentLeaseError,
  type AttachmentIssueContext,
} from "../terminal/attachments/lease-manager.ts";
import {
  TerminalAttachmentAdmissionError,
  type DirectTerminalAttachmentDescriptor,
} from "../terminal/attachments/direct-websocket.ts";
import { SemanticPaneCatalogError } from "../terminal/attachments/semantic-pane-catalog.ts";

export const TERMINAL_ATTACHMENT_ISSUE_PATH = "/api/v1/terminal/attachments/issue" as const;
const MAX_ISSUE_REQUEST_BYTES = 16 * 1024;

export interface TerminalAttachmentIssueBackend {
  issue(
    request: TerminalAttachRequest,
    context: AttachmentIssueContext & { readonly rendererOrigin: string },
  ): Promise<DirectTerminalAttachmentDescriptor>;
}

export interface TerminalAttachmentIssueRouteOptions {
  readonly daemonInstanceId: string;
  readonly ownerToken: string | null;
  readonly workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  readonly backend: TerminalAttachmentIssueBackend | null;
}

function issueError(
  code: TerminalAttachmentIssueErrorCode,
  reason: string,
  retryable = false,
): TerminalAttachmentIssueResult {
  return TerminalAttachmentIssueResultSchemaZ.parse({
    status: "error",
    error: { code, reason, retryable },
  });
}

function response(result: TerminalAttachmentIssueResult): Response {
  const parsed = TerminalAttachmentIssueResultSchemaZ.parse(result);
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

function ownerBearerMatches(value: string | null, ownerToken: string | null): boolean {
  if (!value || !ownerToken) return false;
  const supplied = Buffer.from(value, "utf8");
  const expected = Buffer.from(`Bearer ${ownerToken}`, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function mapBackendError(error: unknown): TerminalAttachmentIssueResult {
  if (error instanceof SemanticPaneCatalogError) {
    switch (error.code) {
      case "workspace-not-found":
        return issueError("workspace-not-found", "The requested workspace is unavailable.");
      case "pane-not-found":
        return issueError("pane-not-found", "The requested terminal pane is unavailable.");
      case "not-single-pane-window":
        return issueError("pane-not-attachable", "The requested pane is not attachable.");
      default:
        return issueError(
          "attachment-unavailable",
          "Terminal attachment discovery is unavailable.",
          true,
        );
    }
  }
  if (error instanceof AttachmentLeaseError) {
    if (error.code === "interactive-viewer-conflict") {
      return issueError(
        "interactive-viewer-conflict",
        "The requested pane already has an interactive viewer.",
        true,
      );
    }
    return issueError("attachment-unavailable", "Terminal attachment is unavailable.", true);
  }
  if (error instanceof TerminalAttachmentAdmissionError) {
    switch (error.code) {
      case "daemon-shutting-down":
        return issueError("disposed", "Terminal attachment admission is stopping.", true);
      case "invalid-origin":
        return issueError("invalid-request", "Terminal attachment request is invalid.");
      case "read_only_unavailable":
        return issueError("pane-not-attachable", "The requested pane is not attachable.");
      case "pending-capacity-exhausted":
      case "preauth-capacity-exhausted":
      case "live-capacity-exhausted":
        return issueError("attachment-unavailable", "Terminal attachment is unavailable.", true);
      default:
        return issueError("attachment-unavailable", "Terminal attachment is unavailable.");
    }
  }
  return issueError("attachment-unavailable", "Terminal attachment is unavailable.", true);
}

/**
 * Mounts the one owner-only semantic terminal mutation before project auth.
 * Remote access tokens, local query tokens, and renderer-authored identities
 * never substitute for the main-process owner bearer or daemon headers.
 */
export function mountTerminalAttachmentIssueRoute(
  app: Hono,
  options: TerminalAttachmentIssueRouteOptions,
): void {
  app.post(TERMINAL_ATTACHMENT_ISSUE_PATH, async (c) => {
    const invalid = () =>
      response(issueError("invalid-request", "Terminal attachment request is invalid."));
    const request = c.req.raw;
    if (new URL(request.url).search.length > 0) return invalid();
    if (!ownerBearerMatches(request.headers.get("Authorization"), options.ownerToken)) {
      return response(issueError("invalid-request", "Terminal attachment request was rejected."));
    }
    if (exactHeader(request, "Content-Type")?.toLowerCase() !== "application/json") {
      return invalid();
    }
    const origin = canonicalRendererOrigin(exactHeader(request, "Origin"));
    const requestId = exactHeader(request, "X-Tmux-Ide-Request-Id");
    const expectedInstanceId = exactHeader(request, "X-Tmux-Ide-Expected-Daemon-Instance-Id");
    if (!origin || !requestId || !expectedInstanceId) return invalid();

    let raw: unknown;
    try {
      raw = await readBoundedJson(request);
    } catch {
      return invalid();
    }
    const parsed = TerminalAttachmentIssueMutationRequestSchemaZ.safeParse(raw);
    if (!parsed.success) return invalid();
    if (
      parsed.data.requestId !== requestId ||
      parsed.data.expectedDaemonInstanceId !== expectedInstanceId ||
      parsed.data.expectedDaemonInstanceId !== options.daemonInstanceId
    ) {
      return response(
        issueError(
          "daemon-identity-mismatch",
          "The daemon generation changed before attachment issue.",
          true,
        ),
      );
    }
    if (!options.backend) {
      return response(
        issueError("daemon-unavailable", "Terminal attachment admission is unavailable.", true),
      );
    }
    const workspace = options.workspaceRegistry.get(parsed.data.attachment.target.workspaceName);
    if (!workspace) {
      return response(issueError("workspace-not-found", "The requested workspace is unavailable."));
    }

    try {
      const descriptor = await options.backend.issue(parsed.data.attachment, {
        requestId: parsed.data.requestId,
        projectIdentity: workspace.name,
        rendererOrigin: origin,
      });
      return response({
        status: "issued",
        descriptor: TerminalAttachmentIssueDescriptorSchemaZ.parse({
          ...descriptor,
          subprotocol: TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL,
        }),
      });
    } catch (error) {
      return response(mapBackendError(error));
    }
  });
}
