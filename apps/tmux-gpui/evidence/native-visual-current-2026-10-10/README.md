# Current native visual observation

Native source commit3b3abe18, executable SHA256
db7ef7cab470f8fd71e90e27cbcdefc2394c3c937a4f21d6558adc435994a110.
Used a separate copy of the Session Opening app with only CFBundleIdentifier
changed to com.tmux-ide.gpui.visual-qualification for unambiguous CUA targeting.
Both native executable hashes match. This is not a fresh signed package receipt.

Ran native-visual-smoke.mjs with private daemon/socket/session and minimal app PATH.
CUA Escape activated the app on Home; Refresh then Open automatically selected
the sole pane. Native screenshot in the conversation showed ASCII, CJK界語,
combining e-acute/A-ring, emoji, bold/italic/underline, distinct palette cells,
orange-on-blue truecolor sample, a magenta styled blank span, wrapped continuation
and cursor on X. No missing/reordered sample text or evident glyph overlap was
observed. This is human-style visual comparison, not pixel/colorimetry or font
metrics testing. One window size/theme/display scale only.

After the screenshot, capture.request recorded source-visible.json from real tmux
at matching fixture geometry. Closed only this owned app via Cmd-Q. Fixture exit0
confirms source session survived app close before owned cleanup. Its automatic
result deliberately retains visualVerdict=unassessed and matrixComplete=false;
this separate note records the bounded manual observation, not an automated pass.
The user's two-window demo controller54706 remained live; no production session
was touched. Clipboard, IME composition, other display scales and broad terminal
visual parity are not proved by this specimen.
