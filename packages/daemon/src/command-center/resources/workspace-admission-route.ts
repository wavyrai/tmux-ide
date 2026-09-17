import type { Hono } from "hono";
import {
  WorkspaceAdmissionSnapshotSchemaZ,
  type DaemonInstanceIdentity,
  type WorkspaceAdmissionSnapshot,
  type WorkspaceAdmissionResource,
} from "@tmux-ide/contracts";
import { ownerAuthorityGate } from "../owner-authority.ts";

interface AdmissionBackend {
  admissionSnapshot?(): WorkspaceAdmissionSnapshot;
}
/** Null means unavailable/unknown, never ready. No identity, inventory or mutation probes. */
function snapshot(backend: AdmissionBackend | undefined): WorkspaceAdmissionSnapshot | null {
  try {
    const result = WorkspaceAdmissionSnapshotSchemaZ.safeParse(backend?.admissionSnapshot?.());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
export function mountWorkspaceAdmissionRoute(
  app: Hono,
  options: {
    daemon: DaemonInstanceIdentity;
    ownerToken: string | null;
    promotion?: AdmissionBackend;
    open?: AdmissionBackend;
  },
): void {
  const gate = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Workspace admission diagnostics require an owner capability.",
    mismatchMessage: "Workspace admission diagnostics require the owner bearer.",
  });
  app.get("/api/resources/workspace-admission", (c) => {
    const rejection = gate(c);
    if (rejection) return rejection;
    c.header("Cache-Control", "no-store");
    return c.json({
      version: 1,
      daemon: options.daemon,
      promotion: snapshot(options.promotion),
      open: snapshot(options.open),
    } satisfies WorkspaceAdmissionResource);
  });
}
