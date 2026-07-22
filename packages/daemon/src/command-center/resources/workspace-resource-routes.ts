import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";

import {
  WORKSPACE_CHANGE_DIFF_RESOURCE_VERSION,
  WORKSPACE_CHANGES_CATALOG_RESOURCE_VERSION,
  WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
  WORKSPACE_FILES_CATALOG_RESOURCE_VERSION,
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  WorkspaceResourceWorkspaceNameSchemaZ,
  type DaemonInstanceIdentity,
} from "@tmux-ide/contracts";

import type { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { ChangesAuthority } from "./workspace-changes-authority.ts";
import { FilesAuthority } from "./workspace-files-authority.ts";

export interface WorkspaceResourceRouteOptions {
  readonly daemon: DaemonInstanceIdentity;
  /** Owner-only capability. Never the remote-access or local-bypass token. */
  readonly ownerToken: string | null;
  readonly registry: Pick<WorkspaceRegistry, "get">;
}

function bearerMatches(header: string | undefined, ownerToken: string | null): boolean {
  if (!header || !ownerToken) return false;
  const supplied = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${ownerToken}`, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

/**
 * Mounts the owner-only, generation-stamped Files and Changes read resources.
 * The route param is a semantic workspace name resolved through the private
 * `WorkspaceRegistry` to a project directory; the renderer never supplies a
 * path. Both authorities return typed contract states for every failure, so
 * these handlers only ever wrap a validated resource in a stamped envelope.
 */
export function mountWorkspaceResourceRoutes(
  app: Hono,
  options: WorkspaceResourceRouteOptions,
): void {
  // FilesAuthority holds a private id table that must persist across a
  // list-then-preview flow, so it is cached per resolved workspace root.
  const filesAuthorities = new Map<string, FilesAuthority>();

  const authorize = (c: Context): Response | null => {
    if (!options.ownerToken) {
      return c.json({ error: "Workspace resource capability is unavailable" }, 503);
    }
    if (!bearerMatches(c.req.header("Authorization"), options.ownerToken)) {
      return c.json({ error: "Workspace resource access requires owner authority" }, 401);
    }
    return null;
  };

  const resolveWorkspace = (
    c: Context,
  ): { name: string; projectDir: string } | { error: Response } => {
    const rawName = c.req.param("name");
    const nameParse = WorkspaceResourceWorkspaceNameSchemaZ.safeParse(rawName);
    if (!nameParse.success) {
      return { error: c.json({ error: "Invalid workspace name" }, 400) };
    }
    const workspace = options.registry.get(nameParse.data);
    if (!workspace) {
      return { error: c.json({ error: "Workspace not found" }, 404) };
    }
    return { name: nameParse.data, projectDir: workspace.projectDir };
  };

  const filesAuthorityFor = (name: string, projectDir: string): FilesAuthority => {
    const key = `${name}\u0000${projectDir}`;
    let authority = filesAuthorities.get(key);
    if (!authority) {
      authority = new FilesAuthority(projectDir, name);
      filesAuthorities.set(key, authority);
    }
    return authority;
  };

  app.get("/api/project/:name/files", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    const resolved = resolveWorkspace(c);
    if ("error" in resolved) return resolved.error;

    const authority = filesAuthorityFor(resolved.name, resolved.projectDir);
    const directoryId = c.req.query("directoryId") ?? null;
    const resource = authority.catalog(directoryId);
    const envelope = WorkspaceFilesCatalogEnvelopeV1SchemaZ.parse({
      version: WORKSPACE_FILES_CATALOG_RESOURCE_VERSION,
      daemon: options.daemon,
      resource,
    });
    c.header("Cache-Control", "no-store");
    return c.json(envelope);
  });

  app.get("/api/project/:name/file-preview", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    const resolved = resolveWorkspace(c);
    if ("error" in resolved) return resolved.error;

    const fileId = c.req.query("fileId");
    if (!fileId) return c.json({ error: "A fileId query parameter is required" }, 400);

    const authority = filesAuthorityFor(resolved.name, resolved.projectDir);
    const resource = authority.preview(fileId);
    const envelope = WorkspaceFilePreviewEnvelopeV1SchemaZ.parse({
      version: WORKSPACE_FILE_PREVIEW_RESOURCE_VERSION,
      daemon: options.daemon,
      resource,
    });
    c.header("Cache-Control", "no-store");
    return c.json(envelope);
  });

  app.get("/api/project/:name/changes", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    const resolved = resolveWorkspace(c);
    if ("error" in resolved) return resolved.error;

    const resource = new ChangesAuthority(resolved.projectDir, resolved.name).catalog();
    const envelope = WorkspaceChangesCatalogEnvelopeV1SchemaZ.parse({
      version: WORKSPACE_CHANGES_CATALOG_RESOURCE_VERSION,
      daemon: options.daemon,
      resource,
    });
    c.header("Cache-Control", "no-store");
    return c.json(envelope);
  });

  app.get("/api/project/:name/change-diff", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    const resolved = resolveWorkspace(c);
    if ("error" in resolved) return resolved.error;

    const changeId = c.req.query("changeId");
    if (!changeId) return c.json({ error: "A changeId query parameter is required" }, 400);

    const resource = new ChangesAuthority(resolved.projectDir, resolved.name).diff(changeId);
    const envelope = WorkspaceChangeDiffEnvelopeV1SchemaZ.parse({
      version: WORKSPACE_CHANGE_DIFF_RESOURCE_VERSION,
      daemon: options.daemon,
      resource,
    });
    c.header("Cache-Control", "no-store");
    return c.json(envelope);
  });
}
