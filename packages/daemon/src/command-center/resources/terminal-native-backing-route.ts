import type {
  NativeBackingIdentity,
  TerminalNativeBackingResponse,
} from "../../terminal/session-runtime/native-seed-backing.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { ownerAuthorityGate } from "../owner-authority.ts";
import { encodeNativeGridCapture } from "../../terminal/mirror/native-grid-capture.ts";

const requestSchema = z
  .object({
    generation: z.uuid(),
    incarnation: z.string().min(1).max(512),
    revision: z.coerce.number().int().nonnegative(),
    stateHash: z.string().min(1).max(128),
  })
  .strict();

/** Owner read of an already subscribed pane; this never starts or resizes tmux. */
export function mountTerminalNativeBackingRoute(
  app: Hono,
  options: {
    ownerToken: string | null;
    generation: string;
    resolveSession(workspace: string): string | null;
    capture(
      session: string,
      pane: string,
      expected: NativeBackingIdentity,
    ): Promise<TerminalNativeBackingResponse>;
  },
): void {
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Terminal backing is unavailable",
    mismatchMessage: "Terminal backing requires owner authority",
  });
  const pending = new Map<string, Promise<TerminalNativeBackingResponse>>();
  let readers = 0;
  app.get("/api/project/:name/terminal-native-backing/:pane", async (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    const parsed = requestSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ status: "invalid" }, 400);
    const expected = parsed.data;
    if (expected.generation !== options.generation) return c.json({ status: "retired" }, 409);
    const workspace = c.req.param("name");
    const pane = c.req.param("pane");
    if (workspace.length > 512 || pane.length > 512) return c.json({ status: "invalid" }, 400);
    const session = options.resolveSession(workspace);
    if (!session) return c.json({ status: "unavailable" }, 404);
    const key = JSON.stringify([
      session,
      pane,
      expected.generation,
      expected.incarnation,
      expected.revision,
      expected.stateHash,
    ]);
    if (readers >= 32 || (!pending.has(key) && pending.size >= 16))
      return c.json({ status: "busy" }, 429);
    let capture = pending.get(key);
    if (!capture) {
      const operation = Promise.resolve()
        .then(() => options.capture(session, pane, expected))
        .finally(() => {
          if (pending.get(key) === operation) pending.delete(key);
        });
      capture = operation;
      pending.set(key, operation);
    }
    readers++;
    try {
      const result = await capture;
      if (result.status !== "captured" && result.status !== "retained")
        return c.json({ status: result.status }, 409);
      if (
        options.resolveSession(workspace) !== session ||
        !result.isCurrent() ||
        result.authority.generation !== expected.generation ||
        result.authority.incarnation !== expected.incarnation ||
        result.authority.revision !== expected.revision ||
        result.authority.stateHash !== expected.stateHash ||
        result.authority.semanticPaneId !== pane
      )
        return c.json({ status: "changed" }, 409);
      const prefix = JSON.stringify({ ...result.authority, workspaceName: workspace }) + "\n";
      const body =
        result.status === "retained"
          ? result.encodeBody(new TextEncoder().encode(prefix))
          : encodeNativeGridCapture(result.snapshot);
      if (!body) return c.json({ status: "unavailable" }, 413);
      // No await between this final admission check and handing off immutable bytes.
      if (!result.isCurrent()) return c.json({ status: "changed" }, 409);
      c.header("Cache-Control", "no-store");
      c.header("Content-Type", "application/x-ndjson");
      return typeof body === "string" ? c.body(prefix + body) : c.body(body);
    } catch {
      return c.json({ status: "unavailable" }, 503);
    } finally {
      readers--;
    }
  });
}
