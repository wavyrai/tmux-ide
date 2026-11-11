//! Commands → "Welcome to Tmux IDE…" opens the welcome (onboarding A1), and
//! nothing else: not About (#374 review).
use super::*;

#[gpui::test]
fn the_palette_row_opens_the_welcome_and_only_the_welcome(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_picker_mode(Mode::Commands, window, cx);
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .rows
                    .iter()
                    .any(|row| row.target == Target::Command(Action::Welcome)
                        && row.label == "Welcome to Tmux IDE…")
            );
            v.choose_picker(Target::Command(Action::Welcome), window, cx);
            assert!(v.picker.is_none());
            assert!(v.welcome.open, "the welcome opens");
            assert!(v.about.is_none(), "About stays closed");
            assert_eq!(v.browser_state.surface, browser::Surface::Home);
        });
    });
}
