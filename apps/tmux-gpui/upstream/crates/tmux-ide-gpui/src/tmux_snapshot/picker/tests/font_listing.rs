use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const INSTALLED: [&str; 7] = [
    "b Mono",
    "A Mono",
    "",
    "bad\nname",
    "A Mono",
    "Symbols Nerd Font Mono",
    "Test Mono",
];
/// What the launch-time listing produced before it moved to the picker.
const LISTED: [&str; 4] = ["A Mono", "b Mono", "Symbols Nerd Font Mono", "Test Mono"];

struct Fixture {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
}
impl Fixture {
    fn new(cache: Option<&str>) -> Result<Self> {
        let dir = tempfile::tempdir()?;
        std::fs::write(
            dir.path().join("gpui-fonts.json"),
            r#"{"version":1,"family":"Test Mono","size":15}"#,
        )?;
        if let Some(cache) = cache {
            std::fs::write(dir.path().join("gpui-font-cache.json"), cache)?;
        }
        Ok(Self {
            dir,
            calls: Arc::new(AtomicUsize::new(0)),
        })
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn cache(&self) -> Result<serde_json::Value> {
        let bytes = std::fs::read(self.dir.path().join("gpui-font-cache.json"))?;
        Ok(serde_json::from_slice(&bytes)?)
    }
    /// A window that has run the launch-time font step.
    fn launch<'a>(
        &self,
        cx: &'a mut TestAppContext,
    ) -> (Entity<SnapshotView>, &'a mut VisualTestContext) {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        let calls = self.calls.clone();
        let path = self.dir.path().join("gpui-fonts.json");
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.terminal_font.path = Some(path);
                view.terminal_font.source = Some(Arc::new(move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    INSTALLED.iter().map(|name| (*name).to_owned()).collect()
                }));
                view.discover_terminal_fonts(cx);
            })
        });
        cx.run_until_parked();
        (view, cx)
    }
}
fn open_font_picker(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.close_picker(window, cx);
            view.open_picker_mode(Mode::Font, window, cx);
        })
    });
    cx.run_until_parked();
}
const REMEMBERED: &str = r#"{"version":1,"family":"Test Mono","resolved":"Test Mono","fallbacks":["Symbols Nerd Font Mono"]}"#;

#[gpui::test]
fn launch_with_a_remembered_font_lists_fonts_only_when_the_picker_first_opens(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new(Some(REMEMBERED)).unwrap();
    let (view, cx) = fixture.launch(cx);
    assert_eq!(fixture.calls(), 0, "fonts listed at launch");
    view.read_with(cx, |view, _| {
        let font = &view.terminal_font;
        assert!(!font.ready);
        assert_eq!(font.config.family, "Test Mono");
        assert_eq!(font.config.size, 15.);
        assert_eq!(
            font.config.fallbacks.as_deref(),
            Some(&["Symbols Nerd Font Mono".to_owned()][..])
        );
    });
    open_font_picker(&view, cx);
    assert_eq!(fixture.calls(), 1);
    open_font_picker(&view, cx);
    assert_eq!(fixture.calls(), 1, "the listing was not kept");
    view.read_with(cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(view.terminal_font.names, LISTED);
    });
}

#[gpui::test]
fn picker_lists_the_same_fonts_as_a_launch_without_a_remembered_font(cx: &mut TestAppContext) {
    let eager = Fixture::new(None).unwrap();
    let (eager_view, eager_cx) = eager.launch(cx);
    assert_eq!(eager.calls(), 1);
    let eager_names = eager_view.read_with(eager_cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(
            view.terminal_font.config.fallbacks.as_deref(),
            Some(&["Symbols Nerd Font Mono".to_owned()][..])
        );
        view.terminal_font.names.clone()
    });
    assert_eq!(eager_names, LISTED);
    assert_eq!(
        eager.cache().unwrap(),
        serde_json::from_str::<serde_json::Value>(REMEMBERED).unwrap()
    );
    let lazy = Fixture::new(Some(REMEMBERED)).unwrap();
    let (lazy_view, lazy_cx) = lazy.launch(cx);
    open_font_picker(&lazy_view, lazy_cx);
    let lazy_names = lazy_view.read_with(lazy_cx, |view, _| view.terminal_font.names.clone());
    assert_eq!(lazy_names, eager_names);
}

#[gpui::test]
fn a_remembered_font_for_another_family_is_not_used(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Some(
        r#"{"version":1,"family":"Other Mono","resolved":"Other Mono","fallbacks":[]}"#,
    ))
    .unwrap();
    let (view, cx) = fixture.launch(cx);
    assert_eq!(fixture.calls(), 1);
    view.read_with(cx, |view, _| {
        assert_eq!(view.terminal_font.config.family, "Test Mono");
        assert_eq!(
            view.terminal_font.config.fallbacks.as_deref(),
            Some(&["Symbols Nerd Font Mono".to_owned()][..])
        );
    });
    assert_eq!(fixture.cache().unwrap()["family"], "Test Mono");
}

#[gpui::test]
fn opening_the_picker_refreshes_a_stale_remembered_cascade(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Some(
        r#"{"version":1,"family":"Test Mono","resolved":"Test Mono","fallbacks":[]}"#,
    ))
    .unwrap();
    let (view, cx) = fixture.launch(cx);
    assert_eq!(fixture.calls(), 0);
    let revision = view.read_with(cx, |view, _| {
        assert_eq!(
            view.terminal_font.config.fallbacks.as_deref(),
            Some(&[][..])
        );
        view.terminal_font.revision
    });
    open_font_picker(&view, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.terminal_font.config.fallbacks.as_deref(),
            Some(&["Symbols Nerd Font Mono".to_owned()][..])
        );
        assert!(view.terminal_font.revision > revision);
    });
    assert_eq!(
        fixture.cache().unwrap(),
        serde_json::from_str::<serde_json::Value>(REMEMBERED).unwrap()
    );
}

#[gpui::test]
fn choosing_a_family_remembers_its_resolution(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Some(REMEMBERED)).unwrap();
    let (view, cx) = fixture.launch(cx);
    open_font_picker(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.choose_terminal_font(
                crate::tmux_snapshot::terminal_font::Choice::Family("A Mono".into()),
                cx,
            )
        })
    });
    cx.run_until_parked();
    let cache = fixture.cache().unwrap();
    assert_eq!(cache["family"], "A Mono");
    assert_eq!(cache["resolved"], "A Mono");
    assert_eq!(cache["fallbacks"][0], "Symbols Nerd Font Mono");
}

#[gpui::test]
fn a_corrupt_remembered_font_falls_back_to_listing_at_launch(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Some("{not json")).unwrap();
    let (view, cx) = fixture.launch(cx);
    assert_eq!(fixture.calls(), 1);
    view.read_with(cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(view.terminal_font.config.family, "Test Mono");
        assert_eq!(view.terminal_font.names, LISTED);
        assert_eq!(
            view.terminal_font.config.fallbacks.as_deref(),
            Some(&["Symbols Nerd Font Mono".to_owned()][..])
        );
    });
    assert_eq!(
        fixture.cache().unwrap(),
        serde_json::from_str::<serde_json::Value>(REMEMBERED).unwrap()
    );
}

#[gpui::test]
fn reopening_the_picker_while_fonts_are_listed_does_not_list_them_again(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Some(REMEMBERED)).unwrap();
    let (view, cx) = fixture.launch(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker_mode(Mode::Font, window, cx);
            view.close_picker(window, cx);
            view.open_picker_mode(Mode::Font, window, cx);
        })
    });
    cx.run_until_parked();
    assert_eq!(fixture.calls(), 1);
}

#[gpui::test]
fn the_picker_resolves_the_saved_family_rather_than_its_remembered_substitute(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new(Some(
        r#"{"version":1,"family":"Test Mono","resolved":"A Mono","fallbacks":[]}"#,
    ))
    .unwrap();
    let (view, cx) = fixture.launch(cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.terminal_font.config.family, "A Mono");
    });
    open_font_picker(&view, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.terminal_font.config.family, "Test Mono");
    });
    assert_eq!(fixture.cache().unwrap()["resolved"], "Test Mono");
}

#[gpui::test]
fn a_picker_opened_before_the_saved_font_loads_keeps_its_listing(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Some(REMEMBERED)).unwrap();
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    let calls = fixture.calls.clone();
    let path = fixture.dir.path().join("gpui-fonts.json");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.terminal_font = crate::tmux_snapshot::terminal_font::Settings::pending();
            view.terminal_font.path = Some(path);
            view.terminal_font.source = Some(Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                INSTALLED.iter().map(|name| (*name).to_owned()).collect()
            }));
            view.open_picker_mode(Mode::Font, window, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(
            !view.terminal_font.ready,
            "chosen before the saved font loaded"
        )
    });
    cx.update(|_, cx| view.update(cx, |view, cx| view.discover_terminal_fonts(cx)));
    cx.run_until_parked();
    open_font_picker(&view, cx);
    assert_eq!(fixture.calls(), 1);
    view.read_with(cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(view.terminal_font.names, LISTED);
        assert_eq!(view.terminal_font.config.family, "Test Mono");
        assert_eq!(view.terminal_font.config.size, 15.);
    });
}
