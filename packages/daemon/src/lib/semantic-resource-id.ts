import { createHash } from "node:crypto";

/**
 * Mint the wire-safe product identity used to correlate a durable tmux stamp
 * without publishing the raw stamp through application-shell resources.
 */
export function semanticResourceDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function semanticResourceId(namespace: string, value: string): string {
  return `${namespace}.${semanticResourceDigest(value)}`;
}

export function terminalWindowResourceId(semanticWindowId: string): string {
  return semanticResourceId("terminal-window", semanticWindowId);
}
