use crate::{AppContext as _, Empty, TestAppContext, WindowBackgroundAppearance, WindowOptions};

#[gpui::test]
fn background_blur_is_per_window_and_survives_appearance_changes(cx: &mut TestAppContext) {
    let default_window = cx.add_window(|_, _| Empty);
    let custom_window = cx.update(|cx| {
        cx.open_window(
            WindowOptions {
                window_background: WindowBackgroundAppearance::Blurred,
                window_background_blur: 24.0,
                ..Default::default()
            },
            |_, cx| cx.new(|_| Empty),
        )
        .expect("window should open")
    });
    let default_platform = cx.test_window(default_window.into());
    let custom_platform = cx.test_window(custom_window.into());
    assert_eq!(default_platform.0.lock().background_blur, 60.0);
    assert_eq!(custom_platform.0.lock().background_blur, 24.0);

    cx.update_window(custom_window.into(), |_, window, _| {
        window.set_background_blur(0.0);
        window.set_background_appearance(WindowBackgroundAppearance::Opaque);
        window.set_background_appearance(WindowBackgroundAppearance::Blurred);
    })
    .expect("window should remain open");
    assert_eq!(custom_platform.0.lock().background_blur, 0.0);
    assert_eq!(default_platform.0.lock().background_blur, 60.0);

    cx.update_window(custom_window.into(), |_, window, _| {
        window.set_background_blur(32.0);
        window.set_background_blur(f64::NAN);
        window.set_background_blur(f64::INFINITY);
    })
    .expect("window should remain open");
    assert_eq!(custom_platform.0.lock().background_blur, 32.0);
}
