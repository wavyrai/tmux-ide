# e2e/

Playwright end-to-end tests for tmux-ide v2.5.0.

These drive a real Chromium against a real `tmux-ide server` binary with a real PTY. They are the only tests that exercise the full client → WebSocket → node-pty → shell loop.

## Running

```bash
pnpm test:e2e            # run all e2e tests
pnpm test:e2e --ui       # Playwright UI mode
pnpm test:e2e --headed   # run headed
```

Server boots automatically via `playwright.config.ts` `webServer` setting.
