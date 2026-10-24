import { createHash } from "node:crypto";

export type NativeFrameScope = Readonly<{ key: string; proof: string }>;
const digest = (domain: string, value: string) =>
  createHash("sha256").update(domain).update("\0").update(value).digest("hex");

/** Exact legacy frameProof(key), including route incarnation/epoch and appearance theme.
 * Private route identity never appears in a publication; this carries no terminal cells.
 */
export function createDirectNativePreview(
  frameProof: (key: string) => string | null,
  now: () => number = Date.now,
) {
  let pending: { key: string; proof: string; request: number; expires: number } | null = null;
  const scope = (key: string): NativeFrameScope | null => {
    if (!key || key.length > 16384) return null;
    const proof = frameProof(key);
    if (!proof || proof.length > 16384) return null;
    return {
      key: digest("tmux-native-frame-key-v1", key),
      proof: digest("tmux-native-frame-proof-v1", proof),
    };
  };
  return {
    scope,
    begin(key: string, request: number) {
      pending = null;
      if (!Number.isSafeInteger(request) || request < 0) return;
      const value = scope(key);
      if (value) pending = { key, proof: value.proof, request, expires: now() + 5000 };
    },
    continue(key: string, request: number) {
      if (pending?.key === key && Number.isSafeInteger(request) && request > pending.request)
        pending.request = request;
    },
    clear() {
      pending = null;
    },
    publication(context: {
      request: number;
      foreground: boolean;
      workspace: boolean;
      liveAvailable: boolean;
    }): NativeFrameScope | null {
      if (!pending) return null;
      const current = scope(pending.key);
      if (
        context.request !== pending.request ||
        !context.foreground ||
        !context.workspace ||
        context.liveAvailable ||
        now() >= pending.expires ||
        !current ||
        current.proof !== pending.proof
      ) {
        pending = null;
        return null;
      }
      return current;
    },
  };
}
