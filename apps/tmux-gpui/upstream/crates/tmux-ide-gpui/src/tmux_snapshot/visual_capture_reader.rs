//! `<theme>+reader` (#756): a Markdown reader pane beside a terminal, with find
//! open on "changes", as in the approved mockups. Dev-only, behind the
//! `visual-capture` feature.
use crate::tmux_snapshot::{SnapshotView, browser, reader};
use anyhow::Result;
use gpui::{Context, Window};
use std::{collections::BTreeMap, sync::Arc};

const SOURCE: &str = r#"# Release notes: Mac app 0.1.16

This release adds the Markdown reader. Run `tmux-ide open notes.md` in any session and the file opens in a pane next to the one you ran it from. See the [pane card design](https://tmux-ide.dev/docs/pane-cards) for how headers work.

> [!NOTE]
> The reader is read-only in this release. Editing comes later.

## What changed

- [x] Open `.md` files with `tmux-ide open`
- [x] Reload when the file changes on disk
- [ ] Find in the document with `⌘F`

## Supported syntax

| Block | How it shows |
|---|---|
| Headings | Three sizes, then body weight |
| Code fences | Monospace on the code wash, with a copy button |
| Tables | Hairline rows, header in medium weight |
| Remote images | Not loaded; shown as a link |

## Configuration

```yaml
reader:
  max_file_mb: 4
  remote_images: off   # changes need an explicit opt-in
  reload: on
```

![Pane layout](images/pane-layout.png)

![Diagram](https://cdn.example.com/diagram.png)
"#;

/// A plain diagram standing in for the document's local picture, written where
/// the reader keeps fetched images.
fn picture(dir: &std::path::Path) -> Result<std::path::PathBuf> {
    let path = dir.join("pane-layout.png");
    let image = image::RgbaImage::from_fn(1200, 300, |x, y| {
        let card = |l: u32, r: u32| x > l && x < r && y > 24 && y < 276;
        if card(24, 380) || card(404, 860) || card(884, 1176) {
            image::Rgba([250, 248, 244, 255])
        } else {
            image::Rgba([232, 227, 218, 255])
        }
    });
    image.save(&path)?;
    Ok(path)
}

pub(super) fn with_reader(
    mut state: browser::State,
    dir: &std::path::Path,
) -> Result<browser::State> {
    let doc = bezel_markdown::parse(SOURCE);
    let assets = BTreeMap::from([(
        "images/pane-layout.png".to_owned(),
        reader::policy::Asset::Ready(picture(dir)?),
    )]);
    let (rendered, _) = reader::policy::rewrite(&doc, &assets);
    state
        .reader_panes
        .insert("pane-b".into(), "release-notes.md".into());
    state.readers.insert(
        "pane-b".into(),
        Arc::new(reader::Published {
            name: "release-notes.md".into(),
            folder: "docs".into(),
            status: reader::Status::Ready,
            doc: Some(Arc::new(rendered)),
            lossy: false,
            generation: 1,
        }),
    );
    state.selected_pane = Some("pane-b".into());
    Ok(state)
}

/// Opens find on the reader with a query, as the mockup shows it.
pub(super) fn find(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.capture_reader_find("pane-b", "changes", window, cx);
}
