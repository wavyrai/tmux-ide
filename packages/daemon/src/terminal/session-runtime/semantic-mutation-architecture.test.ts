import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("semantic mutation production architecture", () => {
  it("constructs one executor and one tmux authority only in their lifecycle owners", () => {
    const registry = source("./registry.ts");
    const daemon = source("../../lib/daemon-embed.ts");
    expect(registry.match(/new SessionSemanticMutationExecutor\(/gu)).toHaveLength(1);
    expect(daemon.match(/new WorkspaceMultiplexerAuthority\(/gu)).toHaveLength(1);
    expect(daemon.match(/workspaceMultiplexer\.(?:mutate|readPane)\(/gu)).toHaveLength(2);
  });

  it("keeps every transport on mandatory trusted metadata with no adapter origin rewrite", () => {
    const executor = source("./semantic-mutation-executor.ts");
    const backend = source("./multiplexer-backend.ts");
    expect(executor).toContain("authority: SessionRuntimeSubmissionAuthority");
    expect(executor).toContain("origin: authority.origin");
    expect(backend).not.toContain("withTrustedOrigin");
    expect(backend).toContain("Semantic mutation requires a live host, pane, or owner principal");
  });

  it("gates pane send and suppresses the legacy generic completion channel", () => {
    const server = source("../../command-center/server.ts");
    const dispatcher = source("../../command-center/actions/dispatcher.ts");
    const semanticActions = source("../../command-center/actions/semantic-multiplexer-actions.ts");
    expect(server).toContain('"workspace.pane.send": "owner-and-operation-id"');
    expect(server).toContain("isSemanticMultiplexerActionName(actionName");
    expect(dispatcher).toContain("isSemanticMultiplexerActionName(actionName)");
    expect(dispatcher).toContain("WorkspaceMultiplexerMutationResultSchemaZ.safeParse(result)");
    expect(semanticActions).toContain('"workspace.pane.send"');
    expect(dispatcher).toContain("ownerAuthorized: ownerAuthorizedContexts.has(c)");
  });

  it("contains no fixed internal-read suppression marker", () => {
    expect(source("../../lib/tmux-interaction-options.ts")).not.toContain(
      "tmux-ide-internal-read-v1",
    );
    expect(source("../../lib/tmux-external-interaction-observer.ts")).toContain(
      "consumeInternalReadOperation",
    );
  });
});
