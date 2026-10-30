use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

const INSTALLED: [&str; 7] = [
    "b Mono",
    "A Mono",
    "",
    "bad\nname",
    "A Mono",
    "Symbols Nerd Font Mono",
    "Test Mono",
];
/// What main's launch-time listing produced from `INSTALLED`.
const LISTED: [&str; 4] = ["A Mono", "b Mono", "Symbols Nerd Font Mono", "Test Mono"];
const NERD: &str = "Symbols Nerd Font Mono";

fn installed() -> Vec<String> {
    INSTALLED.iter().map(|name| (*name).to_owned()).collect()
}

/// A preferences folder naming Test Mono 15, and a font source the test can
/// change between listings, as if fonts were installed or removed.
struct Fixture {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
    fonts: Arc<Mutex<Vec<String>>>,
}
impl Fixture {
    fn new(fonts: Vec<String>) -> Result<Self> {
        let dir = tempfile::tempdir()?;
        std::fs::write(
            dir.path().join("gpui-fonts.json"),
            r#"{"version":1,"family":"Test Mono","size":15}"#,
        )?;
        Ok(Self {
            dir,
            calls: Arc::new(AtomicUsize::new(0)),
            fonts: Arc::new(Mutex::new(fonts)),
        })
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn install(&self, fonts: Vec<String>) {
        *self.fonts.lock().unwrap() = fonts;
    }
    fn source(&self) -> crate::tmux_snapshot::terminal_font::FontSource {
        let calls = self.calls.clone();
        let fonts = self.fonts.clone();
        Arc::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            fonts.lock().unwrap().clone()
        })
    }
    /// A window that has run the launch step but not yet drawn a frame.
    fn launch<'a>(
        &self,
        cx: &'a mut TestAppContext,
    ) -> (Entity<SnapshotView>, &'a mut VisualTestContext) {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        let source = self.source();
        let path = self.dir.path().join("gpui-fonts.json");
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.terminal_font = crate::tmux_snapshot::terminal_font::Settings::pending();
                view.terminal_font.path = Some(path);
                view.terminal_font.source = Some(source);
                view.discover_terminal_fonts(cx);
            })
        });
        cx.run_until_parked();
        (view, cx)
    }
}
/// What `launch_terminal_fonts` schedules for the window's first frame.
fn first_frame(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    cx.update(|_, cx| view.update(cx, |view, cx| view.list_terminal_fonts(cx)));
    cx.run_until_parked();
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
fn fallbacks(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> Option<Vec<String>> {
    view.read_with(cx, |view, _| view.terminal_font.config.fallbacks.clone())
}

#[gpui::test]
fn the_launch_step_reads_the_saved_font_and_lists_fonts_only_on_the_first_frame(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new(installed()).unwrap();
    let (view, cx) = fixture.launch(cx);
    assert_eq!(fixture.calls(), 0, "fonts listed during app start");
    view.read_with(cx, |view, _| {
        assert!(!view.terminal_font.ready);
        assert_eq!(view.terminal_font.config.family, "Test Mono");
        assert_eq!(view.terminal_font.config.size, 15.);
    });
    first_frame(&view, cx);
    assert_eq!(fixture.calls(), 1);
    view.read_with(cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(view.terminal_font.names, LISTED);
        assert_eq!(view.terminal_font.config.family, "Test Mono");
    });
    assert_eq!(fallbacks(&view, cx), Some(vec![NERD.to_owned()]));
    open_font_picker(&view, cx);
    assert_eq!(fixture.calls(), 1, "the listing was not kept");
}

#[gpui::test]
fn a_font_installed_between_launches_is_found_on_the_next_launch(cx: &mut TestAppContext) {
    let fixture = Fixture::new(vec!["Test Mono".into()]).unwrap();
    let (view, first) = fixture.launch(cx);
    first_frame(&view, first);
    assert_eq!(fallbacks(&view, first), Some(Vec::new()));
    fixture.install(installed());
    let (view, next) = fixture.launch(cx);
    first_frame(&view, next);
    assert_eq!(fallbacks(&view, next), Some(vec![NERD.to_owned()]));
    let files: Vec<_> = std::fs::read_dir(fixture.dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(files, ["gpui-fonts.json"], "a launch wrote font state");
}

#[gpui::test]
fn an_empty_listing_keeps_the_saved_font_and_the_picker_lists_again(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Vec::new()).unwrap();
    let (view, cx) = fixture.launch(cx);
    let before = view.read_with(cx, |view, _| view.terminal_font.config.clone());
    first_frame(&view, cx);
    assert_eq!(fixture.calls(), 1);
    view.read_with(cx, |view, _| {
        let font = &view.terminal_font;
        assert!(!font.ready, "an empty listing made the picker ready");
        assert!(font.names.is_empty());
        assert_eq!(font.config.family, before.family);
        assert_eq!(font.config.size, before.size);
        assert_eq!(font.config.fallbacks, before.fallbacks);
    });
    fixture.install(installed());
    open_font_picker(&view, cx);
    assert_eq!(fixture.calls(), 2, "the picker did not list again");
    view.read_with(cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(view.terminal_font.names, LISTED);
    });
    assert_eq!(fallbacks(&view, cx), Some(vec![NERD.to_owned()]));
}

#[gpui::test]
fn an_empty_listing_before_the_saved_font_loads_is_not_kept(cx: &mut TestAppContext) {
    let fixture = Fixture::new(Vec::new()).unwrap();
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    let source = fixture.source();
    let path = fixture.dir.path().join("gpui-fonts.json");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.terminal_font = crate::tmux_snapshot::terminal_font::Settings::pending();
            view.terminal_font.path = Some(path);
            view.terminal_font.source = Some(source);
            view.list_terminal_fonts(cx);
        })
    });
    cx.run_until_parked();
    cx.update(|_, cx| view.update(cx, |view, cx| view.discover_terminal_fonts(cx)));
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert!(!view.terminal_font.ready));
    fixture.install(installed());
    open_font_picker(&view, cx);
    assert_eq!(fixture.calls(), 2);
    view.read_with(cx, |view, _| {
        assert!(view.terminal_font.ready);
        assert_eq!(view.terminal_font.names, LISTED);
    });
}

#[gpui::test]
fn reopening_the_picker_while_fonts_are_listed_does_not_list_them_again(cx: &mut TestAppContext) {
    let fixture = Fixture::new(installed()).unwrap();
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
fn a_picker_opened_before_the_saved_font_loads_keeps_its_listing(cx: &mut TestAppContext) {
    let fixture = Fixture::new(installed()).unwrap();
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    let source = fixture.source();
    let path = fixture.dir.path().join("gpui-fonts.json");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.terminal_font = crate::tmux_snapshot::terminal_font::Settings::pending();
            view.terminal_font.path = Some(path);
            view.terminal_font.source = Some(source);
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
