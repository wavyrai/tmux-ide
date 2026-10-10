# Repository Social Preview

These 1280x640 (2:1) images are candidates for GitHub's repository social
preview, which also feeds the link cards rendered by X, Slack, and other Open
Graph consumers. GitHub accepts one image per repository, so the variants are
alternatives rather than a set:

| File | Composition |
| --- | --- |
| `social-preview-light.png` | Ivory field with the ram bleeding off the right edge. Largest mark, so it survives being scaled into a feed. |
| `social-preview-light-ui.png` | Ivory field with the app tile and an interface mock on a lifted dark window. |
| `social-preview-dark.png` | Graphite field with the app tile and the same interface mock. |

The mock is illustrative, not a capture, but it follows what the client paints:
tabs are filled blocks with close controls and a trailing plus rather than
underlines, and the sidebar dots use Herdr's activity semantics (filled yellow
working, red blocked, teal unseen completion, hollow green idle, muted
unknown). Update it when that chrome changes; both mock variants share the
markup, so they change together. None of these images is embedded in the
application.

The `.svg` files are the sources. Each is self-contained and inlines the ram
path from `icons/herdr-icon-square-clean.svg` rather than referencing it, so
update them together when the mark changes and keep the `NOTICE` attribution
for the upstream artwork accurate. Regenerate the PNG exports with
[librsvg](https://wiki.gnome.org/Projects/LibRsvg):

```sh
for v in light light-ui dark; do
  rsvg-convert -w 1280 -h 640 "assets/social-preview-$v.svg" -o "assets/social-preview-$v.png"
done
```

Keep each export under GitHub's 1 MB social preview limit and upload the chosen
one from the repository's Settings > General > Social preview.
