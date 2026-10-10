# Hosted Linux paste fixture correction

GPUI workflow 38073850628, Linux job 114276681373, failed its exact-row Unicode paste assertion. The observed snapshot contains the marker with a shell prompt prefix (`$ GPUI_PASTE_界🌍`); this is not evidence of dropped Unicode input.

The fixture now prints a leading newline before the marker. Its exact standalone-row assertion remains unchanged, including the long paste and Unicode payload. Local source browser smoke passed after the change; the next hosted Linux run must independently confirm the correction. No product code changed, and this does not prove signed-package or physical clipboard acceptance.

Original full log: `/tmp/gpui-hosted-bridge-second.log`. Extracted relevant rows and local result are retained here.

Hosted confirmation: Linux job 114278954585 in run 38074625965 at commit 393692f26ed1c24025b60a820646a508c5df73d0 completed successfully. It reports 228 passed, zero failed, five explicit optional checks skipped, followed by eleven passing isolated source journeys including the corrected browser paste path. The full log is retained at `/tmp/gpui-hosted-bridge-393692f2.log`; summary output is in hosted-after.txt. This proves the Linux source bridge lane, not macOS physical acceptance or the still-running Rust/package lane.
