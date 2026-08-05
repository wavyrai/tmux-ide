# m48 multiplexer-verb completeness audit

Reconnaissance for the GUI-first milestone. The scope call makes terminals the
product, so the question this answers is narrow and literal: **which tmux verbs
can a person perform with the mouse today, and does the app tell the truth about
what it did?** Nothing here is fixed. Every gap becomes a card.

**Evidence.** Two passes, and a claim needs both. The live pass drove the real
app (real daemon, real tmux fleet, browser development host) through the e2e
fixtures and enumerated every rendered control, then attempted right-click on a
window card, right-click on bare canvas, right-click on a fleet row, double-click
on a window title, and the sidebar's overflow button — dumping the visible
control set after each. The code pass traced each affordance to the daemon route
behind it and, where a route exists, to the `tmux` argv it ultimately runs.

## The whole mutation surface

The desktop app can ask the daemon to change the world in exactly four ways.
This is not a summary — it is the complete list, and it is enforced by a type:

| Host call                               | Contract                         | What it runs                                             |
| --------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| `host.workspace.openProjectDirectory()` | `desktop-host.ts:626`            | `tmux new-session` (`lib/workspace-open.ts:737`)         |
| `host.daemon.promoteWorkspace(...)`     | `daemon-resource-request.ts:124` | adopts an existing session; creates nothing              |
| `host.daemon.createWorkspacePane(...)`  | `daemon-resource-request.ts:128` | `tmux new-window` (`lib/workspace-pane-creation.ts:758`) |
| `host.daemon.mutateAppWindow(...)`      | `daemon-resource-request.ts:133` | **no tmux at all** — see below                           |

Everything else on the wire is a read, a terminal attachment, or a pane-stream
lease. `DaemonResourceResultMap` (`daemon-resource-request.ts:158`) is a
`Record<DaemonResourceKind, …>`, so a fifth mutation cannot be added without
appearing there — which is why this table can be stated as complete rather than
as "what I found".

**The load-bearing fact:** `mutateAppWindow` does not touch tmux. It reads and
writes a daemon-persisted **AppWindow document** (`lib/app-window-mutation.ts` →
`app-window-repository.ts`). Focus, move, resize, float and dock rearrange the
app's own canvas layer. tmux still owns the PTYs, and its own window list, pane
geometry and layout are untouched by any of it.

## The verb table

Mouse-reachable means: a control a person can find and click, that reaches a
daemon route, in the shipping default configuration.

| Verb                | Mouse today | Path (clicks)                                                                                                                   | Feedback honest?                                             | Daemon route            |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------- |
| New session         | Partial     | Onboarding/chooser → "Open Folder" → native picker (2) — `live-app-composition.tsx:1271`                                        | Yes — phases through selecting/opening/waiting, names errors | `workspace-open`        |
| New window          | Yes         | Titlebar "+ New terminal or agent" → kind card → "Create terminal" (3) — `create-pane-flow.tsx`                                 | Yes — waits for an authoritative refresh before closing      | `workspace-pane-create` |
| Split horizontal    | **No**      | —                                                                                                                               | —                                                            | none                    |
| Split vertical      | **No**      | —                                                                                                                               | —                                                            | none                    |
| Rename session      | **No**      | —                                                                                                                               | —                                                            | none                    |
| Rename window       | **No**      | Title is set once at creation (`create-pane-flow-display-title`) and never editable after                                       | —                                                            | none                    |
| Rename pane         | **No**      | —                                                                                                                               | —                                                            | none                    |
| Kill session        | **No**      | —                                                                                                                               | —                                                            | none                    |
| Kill window         | **No**      | `kill-window` exists only as creation rollback (`workspace-pane-creation.ts:938`)                                               | —                                                            | none                    |
| Kill pane           | **No**      | A close button ships on every pane header, permanently disabled                                                                 | Yes — states the contract limit in its label and title       | none                    |
| Float window        | Yes         | Pane header, "Float this window on the canvas" (1) — `app-window-canvas.tsx:313`                                                | Yes for the card; silent about tmux (see gap 1)              | `mutateAppWindow`       |
| Dock window         | Yes         | Same control, inverted: "Dock this window" (1) — `app-window-canvas.tsx:313`                                                    | Same                                                         | `mutateAppWindow`       |
| Zoom pane (tmux -Z) | **No**      | "Maximize the floating window" maximizes the CARD (`app-window-canvas.tsx:325`); canvas zoom scales the VIEWPORT (`:1584-1617`) | Canvas controls are honestly labelled; see gap 2             | none                    |
| Focus / select pane | Yes         | Click the window card (1) — `window.focus` + canonical `moveFocus`                                                              | Yes                                                          | `mutateAppWindow`       |
| Reorder / move      | Yes         | Drag the card, or its "Move terminal pane" grip (1 drag) — `window.move`                                                        | Card moves; tmux window order does not (gap 1)               | `mutateAppWindow`       |
| Resize pane         | Yes         | Drag a card border (1 drag) — `window.resize`                                                                                   | Card resizes; tmux pane geometry does not (gap 1)            | `mutateAppWindow`       |

Seven of sixteen verbs are reachable. Two of those seven (`new session`,
`new window`) reach tmux; four (`float`, `dock`, `move`, `resize`) reach only the
app's own layout document; one (`focus`) is a mix.

## Gaps and dishonesties

Numbered for carding. 1–3 are honesty problems: the app is not lying in words,
but a reasonable user draws a false conclusion. 4–10 are absences.

1. **Canvas arrangement does not reach tmux, and nothing says so.** Float, dock,
   drag-to-move and border-resize all persist to the AppWindow document only. A
   user who spends five minutes arranging their panes, then attaches to the same
   session over ssh, finds the original tmux layout untouched. This is the single
   finding most directly against the "a die-hard loses nothing" bar — not because
   the die-hard loses something, but because the novice's work is invisible to
   them. Decide deliberately whether the canvas is a _view_ over tmux (in which
   case it should say so) or an _authority_ over it (in which case these verbs
   need `select-layout` / `resize-pane` / `swap-window` behind them).

2. **"Maximize" means two different things one control apart.** The pane header's
   "Maximize the floating window" maximizes the app card; tmux's own zoom
   (`resize-pane -Z`) is unreachable. A tmux user reads "maximize" on a pane as
   zoom. The canvas view controls are the good example here — they say "Canvas
   zoom 140 percent" and cannot be misread.

3. **The sidebar's "Workspace actions" (•••) button is inert.** Verified live: it
   is an `IconButton` with a label, a tooltip and no handler
   (`application-shell.tsx:1066`), and clicking it changes
   nothing on screen. An overflow glyph beside the workspace name is exactly where
   a user hunts for rename and close, and it answers by doing nothing at all.

4. **Right-click does nothing, anywhere.** Verified live on a window card, on
   bare canvas, and on a fleet row: the visible control set is byte-identical
   before and after. This is the largest single reachability gap — the terminal
   TUI has a full right-click verb menu, and the GUI, whose whole premise is
   mouse-first, has none.

5. **Splits are entirely absent.** No affordance and no route; `split-window`
   appears nowhere in the daemon's mutation path. "New terminal or agent" runs
   `new-window`, so a GUI user cannot produce a split pane at all — the layout
   every tmux user actually works in is unreachable.

6. **Nothing can be renamed.** Sessions, windows and panes are all named once (by
   the daemon, or by the create dialog's display title) and never again.

7. **Nothing can be killed.** No session, window or pane can be closed from the
   GUI. Creating is a one-way door: the only way to undo a "New terminal" is to
   leave the app. The disabled close button on every pane is honest about the
   contract but leaves the user with no alternative route.

8. **Creating a session requires an empty fleet.** "Open Folder" lives only on
   the onboarding and chooser surfaces. Once a workspace is open the application
   shell has no control that opens another project — verified live: the shell's
   full control set contains no such button. The fleet sidebar can only _adopt_
   sessions that already exist.

9. **The create dialog's vocabulary does not match its effect.** It is called
   "New terminal or agent", its button says "Create terminal", and it runs
   `tmux new-window`. Users who know tmux cannot predict where the thing lands;
   users who do not are given a third word ("pane", in the API and the docs) for
   the same object.

10. **`stack.activate` is built and unreachable.** The command is in the contract
    (`app-window-mutation.ts:50`), fully implemented in the daemon kernel
    (`lib/app-window-kernel.ts:83,191,382`) and covered by its own tests — and the
    renderer never dispatches it. It appears in the canvas presenter's command
    union (`app-window-canvas-presenter.ts:66`) and nowhere else in the app. So
    selecting a window inside a docked stack, the closest thing the app has to
    tmux's window list, has no affordance at all. This is the cheapest gap on the
    list: the authority already exists and works.

## What is genuinely good

Worth keeping while the gaps get fixed. The create-pane flow waits for an
authoritative daemon refresh rather than optimistically closing, so it never
claims a pane that does not exist. The disabled close button states the actual
contract limitation in its accessible label instead of hiding or faking itself.
The canvas view controls name their own units and cannot be confused with tmux
zoom. And `mutateAppWindow` carries generation and revision-conflict handling, so
a stale card cannot overwrite a newer layout.
