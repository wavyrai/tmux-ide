# App-level end-to-end suite (m44.2)

Playwright drives the **real renderer** in a **real browser** against a **real
daemon** over a **real tmux fleet**. There are no mocks, no fixtures-as-data and
no adapter shims anywhere in a chain: the seam it enters through is the
browser-only development host documented in `../DEV-WEB-HOST.md`.

Run it:

```bash
pnpm e2e:app                 # from the repo root
pnpm --filter @tmux-ide/desktop-renderer run e2e   # from anywhere
E2E_HEADED=1 pnpm e2e:app    # watch it happen
```

Artifacts (screenshots, traces on failure) land in `e2e/artifacts/`, which is
gitignored.

## What this suite asserts, and what it refuses to assert

The suite has one rule that shapes every line in it: **assert what the user
sees**. A test here may not conclude that a feature works from the DOM alone.

| Not enough                        | Why it is not enough                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| `expect(locator).toBeAttached()`  | An element clipped to `0px`, translated off-screen, or buried under an |
|                                   | overlay is still attached. The DOM cannot see a layout bug.            |
| `textContent` contains the marker | Text in a `display:contents` node with a collapsed parent has content  |
|                                   | and no pixels.                                                         |
| `getComputedStyle(...).display`   | Style is an input to layout, not evidence of it.                       |

So every visual claim goes through `fixtures/visible.ts`, which proves three
things at once for an element: it has a **non-zero bounding rect**, that rect
sits **inside the viewport**, and a **hit test at its centre** lands on the
element or something inside its own widget — not on a modal, a spinner, or a
stacking-context accident. Terminal paint is proven harder still, by comparing
screenshot fingerprints of the same region before and after input.

Three further rules:

1. **User paths, not adapter calls.** Features are triggered the way a person
   triggers them — clicking the session row, clicking the mirror toggle, typing
   on the keyboard. Daemon HTTP calls appear **only** in setup, to build the
   world the feature is then exercised in, and each one says so.
2. **One feature, one chain.** A chain runs create → visible → interact →
   destroy → gone in a single test. State, DOM and style are not split into
   micro-tests that can each pass while the feature is broken.
3. **Every assertion names the bug that would make it fail.** If a failure
   message cannot name a real regression, the assertion is noise and is deleted.

## Layout

```
e2e/
  playwright.config.ts     runner config; serial, one worker (each test owns a daemon)
  fixtures/
    scratch-fleet.ts       isolated tmux server + temp state dirs, PID-scoped
    daemon.ts              headless daemon child + the startup-readiness ladder wait
    dev-server.ts          the Vite dev server pointed at that daemon
    live-app.ts            the composed `test` object every chain imports
    visible.ts             the visual-truth assertions
  alpha-loop.e2e.ts        the main chain: fleet → open → terminal → mirror → kill → degraded
  first-attach.e2e.ts      cold-load issue → redeem → seed → first-paint flight recorder
  empty-fleet.e2e.ts       cold start with nothing adopted → honest onboarding state
```

`fixtures/live-app.ts` composes the three infrastructure fixtures into one
`liveApp` fixture. A chain declares what world it needs with `test.use({...})`
and receives a running app plus the handles to perturb it:

```ts
test.use({ scratchSessions: 2 });

test("…", async ({ page, liveApp }) => {
  await page.goto(liveApp.pageUrl);
  liveApp.fleet.killSession(liveApp.fleet.sessionNames[1]!);
});
```

## Isolation discipline

Nothing here can reach the developer's real tmux server, real daemon, or real
config. Each test gets:

- a tmux server on its **own socket** under `/tmp` (not `os.tmpdir()`: on macOS
  the per-user temp dir realpaths long enough to blow the 104-byte `sun_path`
  limit);
- `HOME`, registry, settings, daemon-info and `TMUX_IDE_HOME` all pointed at a
  disposable directory;
- scratch session names that are **not** `zz-`-prefixed, because daemon
  discovery hides `zz-` and `_` sessions and such a session could never reach
  the page under test;
- every child spawned `detached`, so cleanup kills the whole **process group**.
  An orphaned daemon child outliving its harness has already caused one real
  support incident; group-kill on every exit path is why it cannot happen here.

Cleanup runs from the fixture's teardown, and again from a `process` exit hook,
so an interrupted run leaves nothing behind either.
