# Hosted Linux paste fixture correction

GPUI workflow 38073850628, Linux job 114276681373, failed its exact-row Unicode paste assertion. The observed snapshot contains the marker with a shell prompt prefix (`$ GPUI_PASTE_界🌍`); this is not evidence of dropped Unicode input.

The fixture now prints a leading newline before the marker. Its exact standalone-row assertion remains unchanged, including the long paste and Unicode payload. Local source browser smoke passed after the change; the next hosted Linux run must independently confirm the correction. No product code changed, and this does not prove signed-package or physical clipboard acceptance.

Original full log: `/tmp/gpui-hosted-bridge-second.log`. Extracted relevant rows and local result are retained here.
