import { randomUUID } from "node:crypto";
import { DesktopWebHostClientIdSchemaZ, type DesktopWebHostClientId } from "@tmux-ide/contracts";

/** Minted only in the trusted Electron main process, once per renderer generation. */
export function mintDesktopWebHostClientId(): DesktopWebHostClientId {
  return DesktopWebHostClientIdSchemaZ.parse(`web:${randomUUID()}`);
}
