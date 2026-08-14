import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./host-local-tmux-adapter.ts", import.meta.url)),
  "utf8",
);

describe("host-local tmux adapter boundary", () => {
  it("contains only client-local put-away and clipboard policy commands", () => {
    expect(source.match(/runTmux\(\[/gu)).toHaveLength(4);
    expect(source).toContain('["switch-client", "-l"]');
    expect(source).toContain('["detach-client"]');
    expect(source).toContain('["set-option", "-gq", "set-clipboard", "on"]');
    expect(source).toContain('["set-option", "-gq", "allow-passthrough", "on"]');
    for (const forbidden of [
      "new-session",
      "new-window",
      "split-window",
      "kill-pane",
      "resize-pane",
      "select-pane",
      "send-keys",
    ]) {
      expect(source).not.toContain(`\"${forbidden}\"`);
    }
  });
});
