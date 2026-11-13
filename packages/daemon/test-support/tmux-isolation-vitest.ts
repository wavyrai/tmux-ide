import { afterAll, beforeAll } from "vitest";
import { allowDefaultTmuxServerInPrivateNamespace } from "./tmux-isolation.ts";

/**
 * Call once at the top of a test file whose subject is a daemon with no tmux
 * server intent: no explicit socket and no TMUX. Such a daemon addresses the
 * socket named "default"; the test guard keeps that in a private, empty
 * namespace (what a machine without a tmux server looks like), and this
 * declaration tells it that the redirect is intended for this file. Without
 * it the run fails and names the file.
 *
 * Do not use it to quiet a test that could pick a private server instead.
 */
export function declareDaemonWithoutTmuxServer(): void {
  let withdraw = (): void => {};
  beforeAll(() => {
    withdraw = allowDefaultTmuxServerInPrivateNamespace();
  });
  afterAll(() => withdraw());
}
