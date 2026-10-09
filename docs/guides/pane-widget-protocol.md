# In-band rich rendering (m49.7)

A pane opts into rich rendering by **printing one line**. There is no protocol,
no registration and no handshake: any command, script or agent that can `echo`
can render a document, a diagram or a GIF into its own pane, and the pane never
stops being a real tmux pane while it does.

```bash
tmux-ide widget markdown PLAN.md      # or: … | tmux-ide widget markdown
tmux-ide widget image demo.gif
printf '%s' '{"title":"Build","items":[{"type":"progress","value":72}]}' | tmux-ide widget card
# Ctrl-C returns the pane to a shell.
```

The retained OpenTUI host renders Markdown through its native renderer and cards
through the shared text projection. Images use a named fallback unless a pixel
protocol is owned. The former Web/Electron rendering implementations are retired.
The marker remains strict data, not executable JavaScript or arbitrary HTML.

## The marker

One line, four space-separated fields, wrapped in SGR 8 (conceal) so a terminal
with no tmux-ide attached shows a blank line rather than machine noise:

```
ESC[8m TMUXIDE-WIDGET/1 <id> <payload> <digest> ESC[0m
```

| Field     | Grammar                         | Meaning                                          |
| --------- | ------------------------------- | ------------------------------------------------ |
| sentinel  | `TMUXIDE-WIDGET/1`              | Token and grammar version, inseparable           |
| `id`      | `[a-z][a-z0-9-]{0,31}`          | A key of the widget registry                     |
| `payload` | base64url of UTF-8 JSON, or `-` | The widget's arguments                           |
| `digest`  | 8 lowercase hex digits          | FNV-1a 32 over `` `<sentinel>:<id>:<payload>` `` |

The grammar lives in `packages/contracts/src/pane-widget-marker.ts` because it
is a contract between two processes — a CLI that encodes it and a renderer that
decodes it — and a duplicated digest is a digest that will eventually disagree
with itself.

### Why it cannot fire by accident

A line activates a widget only if **all five** hold:

1. it contains the sentinel token, and starts with it once trimmed;
2. it splits into exactly four whitespace-separated fields;
3. field 2 is a syntactically valid id **and** a key of the registry;
4. field 3 is valid base64url decoding to valid JSON that matches that widget's
   **strict** schema (no unknown keys);
5. field 4 equals the FNV-1a digest of fields 1–3.

The digest is an accident detector, not a signature — anyone can compute one.
That is exactly the requirement: ordinary output cannot satisfy all five
conditions at once, so `cat`-ing this file, grepping for the sentinel, or
printing a log that quotes a marker inside a longer line leaves the pane alone.
Every case in that list is a test in `pane-widget-marker.test.ts`.

Version is inside the token rather than beside it, so a future `/2` grammar is
simply not a `/1` marker: an old build leaves it as terminal output instead of
half-parsing it.

## Detection and limits

`detectWidgetMarker` consumes cell rows and reconstructs wrapped logical lines.
The newest valid marker wins. Invalid/truncated markers remain terminal output.
The shared contract caps the encoded payload at 96 KiB (98,304 characters).

The CLI supports Markdown text or an asset ID, strict card descriptors, and
bounded image announcements. Supported image extensions are PNG, JPEG, GIF,
WebP and AVIF. The source-byte limit is
`floor((98,304 / 1.78) * 0.94)`: image data is base64-encoded inside JSON,
then the JSON is base64url-encoded into the marker. The safety factor reserves
space for metadata. Narrow panes or insufficient retained rows can still truncate
a marker; detection fails closed instead of displaying a partial widget.

The authoritative implementations are `packages/contracts/src/pane-widget-marker.ts`
and `packages/daemon/src/lib/pane-widget.ts`. OpenTUI presentation lives under
`packages/daemon/src/tui/mirror`; this document does not promise the retired
browser renderer's HTML, Mermaid, image-animation, or interaction behavior.
