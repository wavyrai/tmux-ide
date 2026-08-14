import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";

type TerminalAuthorityClient = Pick<
  OpenTuiProductionWorkspaceClient,
  "noteActivity" | "releaseAuthority" | "requestAuthority" | "setPresence"
>;

/**
 * Renderer-focus adapter for the shared WorkspaceClient authority protocol.
 * It owns no lease state: it only projects host focus to the canonical client.
 */
export class OpenTuiTerminalHostFocus {
  #client: TerminalAuthorityClient | null = null;
  #focused: boolean;

  constructor(initiallyFocused = true) {
    this.#focused = initiallyFocused;
  }

  adopt(client: TerminalAuthorityClient | null): void {
    if (client === this.#client) return;
    const previous = this.#client;
    this.#client = client;
    if (previous) this.#yield(previous);
    if (client) this.#apply(client);
  }

  focus(): void {
    if (this.#focused) return;
    this.#focused = true;
    if (this.#client) this.#claim(this.#client);
  }

  blur(): void {
    if (!this.#focused) return;
    this.#focused = false;
    if (this.#client) this.#yield(this.#client);
  }

  dispose(): void {
    const client = this.#client;
    this.#client = null;
    if (client) this.#yield(client);
  }

  #apply(client: TerminalAuthorityClient): void {
    if (this.#focused) this.#claim(client);
    else client.setPresence("background");
  }

  #claim(client: TerminalAuthorityClient): void {
    client.setPresence("foreground");
    client.noteActivity("focus");
    void Promise.all([
      client.requestAuthority("input"),
      client.requestAuthority("focus"),
      client.requestAuthority("geometry"),
    ]).catch(() => undefined);
  }

  #yield(client: TerminalAuthorityClient): void {
    void Promise.all([
      client.releaseAuthority("input"),
      client.releaseAuthority("focus"),
      client.releaseAuthority("geometry"),
    ]).catch(() => undefined);
    client.setPresence("background");
  }
}
