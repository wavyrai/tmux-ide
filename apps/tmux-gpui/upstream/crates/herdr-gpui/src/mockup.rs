//! Native UI mockups, a development tool behind the `mockup` feature.
//!
//! An agent writes several variants of a component as real GPUI code in one
//! file outside the repository, and `just mockup FILE` compiles it in through
//! `HERDR_MOCKUP_FILE` (see `build.rs`). `--mockup` then shows the variants
//! side by side in the app's own theme and fonts, so the design the user
//! picks is the code that ships, not an HTML approximation of it. The user
//! picks variants, writes notes, and sends them back to the agent as a file.
//!
//! The mode never connects to a daemon, answers the control socket, or writes
//! the user's settings: it only reads them for the first frame's look.

// Unused while an agent's file replaces it, but always compiled and tested.
#[cfg_attr(herdr_mockup_scratch, allow(dead_code))]
mod demo;
mod feedback;
mod window;

// The agent's file replaces the demo when one was given at build time. It is
// a child of this module, so it reaches the API below as `super::`.
#[cfg(herdr_mockup_scratch)]
mod scratch {
    include!(env!("HERDR_MOCKUP_SCRATCH"));
}

use crate::{
    Quit,
    cli::MockupOptions,
    config::{Config, Theme},
};
use anyhow::Context as _;
use gpui::{prelude::*, *};
use std::path::PathBuf;

/// What a variant is drawn with: the theme and fonts the window currently
/// shows. Views read it with `cx.global::<Look>()` in their render.
#[derive(Clone, Default)]
pub(crate) struct Look {
    pub theme: Theme,
    pub config: Config,
}

impl Global for Look {}

/// How a variant draws itself.
#[derive(Clone, Copy)]
pub(crate) enum Body {
    /// Stateless: rebuilt on every frame from the current look.
    Element(fn(&Look, &mut Window, &mut App) -> AnyElement),
    /// Stateful or interactive: built once when the window opens, then kept,
    /// so its state survives theme and width changes.
    View(fn(&mut Window, &mut App) -> AnyView),
}

/// One design direction.
pub(crate) struct Variant {
    /// A word or two naming the direction, such as "Dense" or "Card".
    pub name: &'static str,
    /// One line on what this variant tries, shown above it.
    pub note: &'static str,
    pub body: Body,
}

/// Everything the window compares. Variants are lettered A, B, C... in order.
pub(crate) struct Mockup {
    pub title: &'static str,
    /// The size each variant is designed for: its frame's width, and the
    /// least height it takes. Content taller than that grows the frame.
    pub frame: Size<Pixels>,
    pub variants: Vec<Variant>,
}

/// The mockup this build was compiled with.
fn current() -> Mockup {
    #[cfg(herdr_mockup_scratch)]
    return scratch::mockup();
    #[cfg(not(herdr_mockup_scratch))]
    demo::mockup()
}

/// The themes the window offers: the user's own first, when it is not one of
/// the built-in ones, then every built-in theme.
fn themes(config: &Config, yours: Option<Theme>) -> Vec<(SharedString, Theme)> {
    let builtin = Theme::BUILTIN_NAMES
        .iter()
        .filter_map(|name| Some((SharedString::from(*name), Theme::builtin(name)?)));
    yours
        .filter(|_| !Theme::BUILTIN_NAMES.contains(&config.theme.trim()))
        .map(|theme| (SharedString::from(config.theme.clone()), theme))
        .into_iter()
        .chain(builtin)
        .collect()
}

/// How long the window settles before `--capture` saves it: long enough for
/// the first frames and icon rasterization. Variants are compiled in and load
/// nothing, so there is no later content to wait for.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(750);

/// Saves a PNG of the window as GPUI last drew it, straight from the renderer:
/// no screen-recording permission, and covered windows capture whole.
fn capture(handle: WindowHandle<window::MockupWindow>, path: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(SETTLE).await;
        let image = handle.update(cx, |_, window, _| window.render_to_image());
        let saved = match image {
            Ok(Ok(image)) => {
                cx.background_executor()
                    .spawn(async move {
                        let mut png = Vec::new();
                        image
                            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                            .context("encode PNG")?;
                        feedback::write(&path, &png)?;
                        anyhow::Ok(path)
                    })
                    .await
            }
            Ok(Err(error)) => Err(error.context("render the window")),
            Err(error) => Err(error.context("the window closed")),
        };
        match saved {
            // The skill waits for this line before reading the file.
            Ok(path) => println!("mockup: captured {}", path.display()),
            Err(error) => eprintln!("mockup: capture failed: {error:#}"),
        }
    })
    .detach();
}

pub(crate) fn run(options: MockupOptions) -> std::process::ExitCode {
    let MockupOptions {
        feedback,
        capture: capture_path,
    } = options;
    // Read-only: no lock, migration, or writes. A broken config still shows
    // the mockup, in the defaults.
    let config = Config::load_startup().unwrap_or_else(|error| {
        eprintln!("mockup: using default settings: {error}");
        Config::default()
    });
    let yours = config
        .theme(false)
        .map_err(|error| eprintln!("mockup: using a built-in theme: {error}"))
        .ok();
    let themes = themes(&config, yours);
    let initial = themes
        .iter()
        .position(|(name, _)| name.as_ref() == config.theme.trim())
        .unwrap_or_default();
    let failed = std::rc::Rc::new(std::cell::Cell::new(false));
    let open_failed = failed.clone();
    gpui_platform::application()
        .with_assets(crate::icons::Icons)
        .run(move |cx| {
            cx.bind_keys(window::key_bindings());
            cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            let mockup = current();
            let bounds = Bounds::centered(None, size(px(1400.), px(900.)), cx);
            let title = format!("Mockup: {}", mockup.title);
            let result = cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(640.), px(400.))),
                    titlebar: Some(crate::titlebar::options(&title)),
                    app_owns_titlebar_drag: cfg!(target_os = "macos"),
                    app_id: Some("so.pen.herdr-gpui.mockup".into()),
                    ..Default::default()
                },
                |window, cx| {
                    cx.new(|cx| {
                        window::MockupWindow::new(
                            mockup,
                            window::Setup {
                                config,
                                themes,
                                theme: initial,
                                feedback,
                            },
                            window,
                            cx,
                        )
                    })
                },
            );
            match result {
                // The skill reads this line to know the window is up.
                Ok(handle) => {
                    println!("mockup: ready pid={}", std::process::id());
                    if let Some(path) = capture_path {
                        capture(handle, path, cx);
                    }
                }
                Err(error) => {
                    eprintln!("mockup: unable to open the window: {error}");
                    open_failed.set(true);
                    cx.quit();
                }
            }
            cx.activate(true);
        });
    if failed.get() {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn themes_offer_a_custom_theme_first_and_every_builtin() {
        let config = Config {
            theme: "my-ghostty-theme".into(),
            ..Config::default()
        };
        let custom = Theme {
            background: 0x123456,
            ..Theme::default()
        };
        let listed = themes(&config, Some(custom.clone()));
        assert_eq!(listed.len(), Theme::BUILTIN_NAMES.len() + 1);
        assert_eq!(listed[0], ("my-ghostty-theme".into(), custom));
        assert_eq!(
            listed[1..]
                .iter()
                .map(|(name, _)| name.as_ref())
                .collect::<Vec<_>>(),
            Theme::BUILTIN_NAMES
        );
        // A built-in name is not listed twice, and an unloadable one is left out.
        let nord = Config {
            theme: "Nord".into(),
            ..Config::default()
        };
        assert_eq!(
            themes(&nord, Theme::builtin("Nord")).len(),
            Theme::BUILTIN_NAMES.len()
        );
        assert_eq!(themes(&config, None).len(), Theme::BUILTIN_NAMES.len());
    }
}
