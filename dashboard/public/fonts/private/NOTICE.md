# Private Fonts — Do Not Distribute

Files in this directory are **privately licensed** and are NOT part of the
tmux-ide OSS distribution. They are gitignored and must never be committed,
published to npm, or bundled into a public release artifact.

## Berkeley Mono

`Berkeley-Mono-Variable.woff2` — used by the in-browser terminal renderer
when present. Licensed by [Berkeley Graphics](https://berkeleygraphics.com/)
to the project owner only. Reuse, redistribution, or sub-licensing is
prohibited by the Berkeley Mono End-User License Agreement.

If you are an OSS contributor / fork maintainer / self-hoster:

- The terminal will fall back automatically to `ui-monospace, SFMono-Regular,
  "JetBrains Mono", "IBM Plex Mono", monospace` when this file is absent.
- To use Berkeley Mono yourself, purchase a license at berkeleygraphics.com
  and drop the variable WOFF2 here.
- Do not commit, vendor, or otherwise distribute the font file.

## Adding other private fonts

Place the WOFF2 in this directory and add an `@font-face` rule in
`dashboard/app/globals.css` that points at `/fonts/private/<name>.woff2`.
The browser falls back gracefully when the file is missing, so the OSS
build keeps working without the font.
