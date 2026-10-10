#![allow(clippy::unwrap_used)]
use super::*;
use crate::sidebar::layout_tests::fixture_window;
use gpui::{Entity, Modifiers, VisualTestContext, point, px};
use herdr_client::{
    ConnectTarget,
    protocol::{
        CellData, ClientShellSnapshot, FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect,
    },
};
use std::sync::Arc;

#[test]
fn paths_resolve_under_home_or_the_pane_directory() {
    let home = Path::new("home");
    let root = std::env::temp_dir();
    let link = |path: &str, cwd: Option<&Path>| FileLink {
        path: path.into(),
        cwd: cwd.map(|cwd| cwd.to_str().unwrap().into()),
    };
    assert_eq!(
        link("~/notes/a.md", None).resolve(Some(home)),
        Some(home.join("notes/a.md"))
    );
    assert_eq!(link("~/a", None).resolve(None), None);
    let absolute = root.join("a.rs");
    assert_eq!(
        link(absolute.to_str().unwrap(), Some(Path::new("elsewhere"))).resolve(Some(home)),
        Some(absolute)
    );
    assert_eq!(
        link("src/a.rs", Some(&root)).resolve(Some(home)),
        Some(root.join("src/a.rs"))
    );
    assert_eq!(link("src/a.rs", None).resolve(Some(home)), None);
    assert_eq!(
        link("src/a.rs", Some(Path::new("relative"))).resolve(Some(home)),
        None
    );
}

#[test]
fn only_documents_and_plain_folders_open_themselves() {
    let root = tempfile::tempdir().unwrap();
    // Symlinks resolved, as on macOS where the temporary folder is behind
    // one; not `canonicalize`, which also expands Windows short names.
    let real = real_path(root.path()).unwrap();
    let file = |name: &str| {
        let path = root.path().join(name);
        std::fs::write(&path, "x").unwrap();
        path
    };
    for name in ["notes.txt", "README.MD", "Makefile"] {
        assert_eq!(opened(&file(name)), Some(real.join(name)), "{name}");
    }
    for name in [
        "setup.exe",
        "run.command",
        "tool.py",
        "open.terminal",
        "a.unknown",
    ] {
        assert_eq!(opened(&file(name)), Some(real.clone()), "{name}");
    }
    let docs = root.path().join("docs");
    std::fs::create_dir(&docs).unwrap();
    assert_eq!(opened(&docs), Some(real.join("docs")));
    let bundle = root.path().join("Tool.app");
    std::fs::create_dir(&bundle).unwrap();
    assert_eq!(opened(&bundle), Some(real.clone()));
    assert_eq!(opened(&root.path().join("gone.txt")), None);
    assert!(!remote(root.path()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = file("build");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(opened(&script), Some(real.clone()));
        // A document's name on a symlink does not disguise where it leads.
        let disguise = root.path().join("notes.md");
        std::os::unix::fs::symlink(&bundle, &disguise).unwrap();
        assert_eq!(opened(&disguise), Some(real.clone()));
        // Nor does a folder named like one hide a bundle above it.
        let inside = bundle.join("run.sh");
        std::fs::write(&inside, "x").unwrap();
        assert_eq!(opened(&inside), Some(real.clone()));
        // A link into the automounter's host map is refused before it is
        // followed, and so is a loop.
        std::os::unix::fs::symlink("/net/elsewhere/share", root.path().join("share")).unwrap();
        assert_eq!(opened(&root.path().join("share/notes.txt")), None);
        std::os::unix::fs::symlink("loop", root.path().join("loop")).unwrap();
        assert_eq!(opened(&root.path().join("loop")), None);
        // Relative links and `..` resolve as the system would.
        std::os::unix::fs::symlink("docs/../notes.txt", root.path().join("alias.txt")).unwrap();
        assert_eq!(
            opened(&root.path().join("alias.txt")),
            Some(real.join("notes.txt"))
        );
    }
    assert!(remote(Path::new("/net/host/share")) == cfg!(unix));
    #[cfg(windows)]
    {
        for share in [
            r"\\server\share\a.txt",
            r"\\?\UNC\server\share\a.txt",
            r"\\.\UNC\server\share\a.txt",
            r"\\?\GLOBALROOT\Device\Mup\server\share\a.txt",
        ] {
            assert!(remote(Path::new(share)), "{share}");
        }
        for local in [r"C:\a.txt", r"\\?\C:\a.txt"] {
            assert!(!remote(Path::new(local)), "{local}");
        }
    }
}

/// A window whose only pane prints `text` and runs in `cwd`.
fn window<'a>(
    text: &str,
    cwd: &Path,
    cx: &'a mut gpui::TestAppContext,
) -> (Entity<HerdrWindow>, &'a mut VisualTestContext) {
    let text = text.to_owned();
    let cwd = cwd.to_str().unwrap().to_owned();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = fixture_window(window, cx);
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        snapshot.panes[0].foreground_cwd = Some(cwd);
        let rect = SurfaceRect {
            x: 0,
            y: 0,
            width: 60,
            height: 2,
        };
        let mut symbols = text.chars();
        view.live.surface = Some(Arc::new(PaneSurfaceFrame {
            boot_id: snapshot.boot_id.clone(),
            projection_revision: snapshot.revision,
            surface_revision: 1,
            frame: FrameData {
                width: rect.width,
                height: rect.height,
                cells: (0..120)
                    .map(|_| CellData {
                        symbol: symbols.next().unwrap_or(' ').to_string(),
                        fg: 0,
                        bg: 0,
                        modifier: 0,
                        skip: false,
                        hyperlink: None,
                    })
                    .collect(),
                cursor: None,
                hyperlinks: vec![],
                graphics: vec![],
            },
            panes: vec![PaneSurfacePane {
                pane_id: snapshot.panes[0].pane_id.clone(),
                content_revision: 2,
                rect,
                inner_rect: rect,
                scrollbar_rect: None,
                scroll: None,
                focused: true,
                mouse_reporting: false,
                sgr_pixel_mouse: false,
                alternate_screen_active: false,
                pixel_width: 600,
                pixel_height: 40,
            }],
            splits: vec![],
            popup: None,
            graphics: Default::default(),
        }));
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    (view, cx)
}

/// The middle of the first row's cell `col`.
fn at(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, col: u16) -> Point<Pixels> {
    view.read_with(cx, |view, _| {
        view.bounds.origin
            + point(
                px((f32::from(col) + 0.5) * view.cell_width),
                px(view.config.terminal.line_height() / 2.),
            )
    })
}

#[gpui::test]
fn a_link_modifier_click_opens_a_printed_file_that_exists(cx: &mut gpui::TestAppContext) {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("docs")).unwrap();
    std::fs::write(root.path().join("docs/notes.txt"), "notes").unwrap();
    let (view, cx) = window("see docs/notes.txt:3 or docs/gone.txt", root.path(), cx);
    let found = at(&view, cx, 6);
    let missing = at(&view, cx, 26);

    // Without the modifier a path is plain text.
    view.read_with(cx, |view, _| {
        assert!(!view.terminal_link_hovered(found, Modifiers::default()));
        assert!(view.terminal_link_hovered(found, Modifiers::secondary_key()));
        assert!(view.link_modifier_held(found, Modifiers::secondary_key()));
    });
    cx.simulate_click(found, Modifiers::default());
    cx.run_until_parked();
    assert!(cx.opened_url().is_none());

    // Held over the path, the modifier underlines it, location included.
    cx.simulate_mouse_move(found, None, Modifiers::secondary_key());
    view.read_with(cx, |view, _| {
        let link = view.hovered_local_link().unwrap();
        assert_eq!((link.row, link.columns.clone()), (0, 4..20));
    });
    cx.simulate_mouse_move(found, None, Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.hovered_local_link().is_none()));

    cx.simulate_click(missing, Modifiers::secondary_key());
    cx.run_until_parked();
    assert!(cx.opened_url().is_none());

    cx.simulate_click(found, Modifiers::secondary_key());
    cx.run_until_parked();
    let real = real_path(&root.path().join("docs/notes.txt")).unwrap();
    let expected = url::Url::from_file_path(real).unwrap();
    assert_eq!(cx.opened_url().as_deref(), Some(expected.as_str()));
}

#[gpui::test]
fn a_pane_on_an_ssh_host_has_no_file_links(cx: &mut gpui::TestAppContext) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.txt"), "a").unwrap();
    let (view, cx) = window("open ./a.txt", root.path(), cx);
    let position = at(&view, cx, 7);
    view.update(cx, |view, _| {
        assert!(view.file_link_at(position).is_some());
        view.endpoints[view.selected_endpoint].connection.target = ConnectTarget::Ssh {
            target: "unused".into(),
            session: "default".into(),
        };
        assert!(view.file_link_at(position).is_none());
        assert!(view.local_link_at(position).is_none());
        assert!(!view.terminal_link_hovered(position, Modifiers::secondary_key()));
    });
    cx.simulate_click(position, Modifiers::secondary_key());
    cx.run_until_parked();
    assert!(cx.opened_url().is_none());
}
