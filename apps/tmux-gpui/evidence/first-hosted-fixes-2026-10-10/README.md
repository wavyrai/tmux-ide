# First hosted qualification fixes — 10 October 2026

Ubuntu job 114275932949 in run 38073624289 failed the packaging inventory test
with FileNotFoundError for Input.app/FOO. The mocked listing supplied foo and FOO
but the fixture created only foo; sorting visits FOO first. macOS's usual
case-insensitive filesystem hid the absent file. The fixture now creates both
spellings and removes both before the separate limit checks, so alias rejection
cannot mask limit behavior. Four focused tests pass locally with no skips.
Independent review approved test SHA-256
`a4705a97d77e5a88c00a2307cf1b2ed43e641005d6df0413cae888d119faa262`.
Linux passing evidence still requires the next hosted run.

Root lint passed locally against the clean source checkout. Root format check
failed nine files; formatted maintained prose and explicitly excluded generated
JSON evidence receipts to preserve exact recorded bytes. Full format check then
passed in the isolated checkout with the six formatting changes applied. Product
runtime and imported upstream source were not modified by these corrections.

Hosted Docs build also failed maintained TUI demo source fingerprints after
theme/shared-model extraction. The same check failed locally. Running the
maintained pnpm demo:tui generator changed only five source fingerprints;
visual outputs were byte-identical. The same check and full uncached docs build
then passed all seven documentation gates. Generated fingerprint diff reviewed.

Recorded text logs normalize trailing whitespace; raw local logs remain in /tmp.
