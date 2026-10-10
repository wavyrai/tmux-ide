//! Process bootstrap and window opening. CLI parsing and the updater helper
//! run before GPUI starts, so an invalid option or `--build-info` exits without
//! ever creating a window.

use crate::{
    APP_VERSION, HerdrWindow, Hide, HideOthers, Quit, ShowAll, ShowLogs, WINDOW_TITLE, app_icon,
    bind_keys, cli,
    config::{Config, Theme},
    diagnostics, icons, log_window, menus, titlebar, updater,
};
#[cfg(feature = "integration-test")]
use crate::{performance, smoke};
use anyhow::Result;
use gpui::{prelude::*, *};
use herdr_client::ConnectTarget;

/// The first frame must not use default density while disk settings load.
/// Load before the UI event loop; later windows reuse the last validated pair.
#[derive(Clone, Default)]
pub(crate) struct InitialAppearance {
    pub config: Config,
    pub theme: Theme,
    pub error: Option<String>,
}

impl Global for InitialAppearance {}

impl InitialAppearance {
    fn load(load: impl FnOnce() -> crate::Result<Config>, light: bool) -> Self {
        match load().and_then(|config| Ok((config.theme(light)?, config))) {
            Ok((theme, config)) => Self {
                config,
                theme,
                error: None,
            },
            Err(error) => Self {
                error: Some(format!("Load GUI config: {error}")),
                ..Self::default()
            },
        }
    }
}

/// Whether the system appearance is light, which picks the side of a
/// `light:…,dark:…` theme and Herdr's light palette.
pub(crate) fn light_appearance(cx: &App) -> bool {
    matches!(
        cx.window_appearance(),
        WindowAppearance::Light | WindowAppearance::VibrantLight
    )
}

/// Startup reads settings before the event loop, when the system appearance
/// is not yet known, so a theme that follows it has both sides resolved and
/// the first frame picks one without any disk work on the UI thread.
struct StartupAppearance {
    dark: InitialAppearance,
    light: Option<Theme>,
}

impl StartupAppearance {
    fn load(load: impl FnOnce() -> crate::Result<Config>) -> Self {
        let dark = InitialAppearance::load(load, false);
        let light = (dark.error.is_none()
            && crate::config::ThemeName::follows_system(&dark.config.theme))
        .then(|| dark.config.theme(true))
        .and_then(|theme| {
            theme
                .inspect_err(|error| tracing::warn!(%error, "Could not load the light theme"))
                .ok()
        });
        Self { dark, light }
    }

    fn select(self, light: bool) -> InitialAppearance {
        match self.light {
            Some(theme) if light => InitialAppearance { theme, ..self.dark },
            _ => self.dark,
        }
    }
}

/// Opens one main window onto `target`. Every window is an independent client
/// of that daemon: its own connection, surface lease, and workspace focus.
pub(crate) fn open_window(
    target: ConnectTarget,
    updater: updater::Updater,
    cx: &mut App,
    #[cfg(feature = "integration-test")] fixture: bool,
) -> Result<WindowHandle<HerdrWindow>> {
    // Cascade rather than stack windows exactly, so a new one is visible at once.
    let existing = cx
        .windows()
        .iter()
        .filter(|handle| handle.downcast::<HerdrWindow>().is_some())
        .count();
    let step = px(28. * existing.min(6) as f32);
    let mut bounds = Bounds::centered(None, size(px(1200.), px(780.)), cx);
    bounds.origin += point(step, step);
    let (bounds, display_id) = crate::window_state::WindowState::placement(bounds, cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            display_id,
            window_min_size: Some(size(px(640.), px(400.))),
            titlebar: Some(titlebar::options(WINDOW_TITLE)),
            app_owns_titlebar_drag: cfg!(target_os = "macos"),
            app_id: Some(crate::constants::APP_ID.into()),
            ..Default::default()
        },
        |window, cx| {
            cx.new(|cx| {
                let mut view = HerdrWindow::new(
                    target,
                    window,
                    cx,
                    #[cfg(feature = "integration-test")]
                    fixture,
                );
                view.updater = updater;
                crate::window_state::WindowState::observe(window, cx);
                view
            })
        },
    )
}

/// The app's one sound worker. Each window holds its own connection and the
/// daemon sends every notification to each of them, so a worker per window
/// played one notification once per open window.
struct SharedSound(std::rc::Rc<crate::sound::Service>);

impl Global for SharedSound {}

fn shared_sound(cx: &mut App) -> std::rc::Rc<crate::sound::Service> {
    if let Some(shared) = cx.try_global::<SharedSound>() {
        return shared.0.clone();
    }
    let sound = std::rc::Rc::new(crate::sound::Service::new());
    cx.set_global(SharedSound(sound.clone()));
    sound
}

/// Opens another window from inside the focused window's own update.
pub(crate) fn open_additional_window(target: ConnectTarget, cx: &mut App) {
    cx.defer(move |cx| {
        let opened = open_window(
            target,
            updater::Updater::secondary(),
            cx,
            #[cfg(feature = "integration-test")]
            false,
        );
        let sound = shared_sound(cx);
        match opened {
            Ok(handle) => {
                let _ = handle.update(cx, |view, window, _| {
                    view.sound = sound;
                    window.activate_window();
                });
            }
            Err(_) => tracing::error!("Unable to open an additional Herdr window"),
        }
    });
}

pub(crate) fn run() -> std::process::ExitCode {
    use cli::{LaunchMode, LaunchOptions};
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let Some(exit) = updater::run_helper(&args) {
        return exit;
    }
    let LaunchOptions { target, mode } = match LaunchOptions::parse(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!(
                "{error}\nUsage: herdr-gpui [--socket CLIENT_SOCKET | --session NAME [--dev]]\n       herdr-gpui browser open URL [--workspace ID] [--no-focus]"
            );
            return std::process::ExitCode::from(2);
        }
    };
    if let LaunchMode::Browser(command) = mode {
        return crate::control::run(command);
    }
    // A separate app of its own: no daemon, control socket, stores, or updater.
    #[cfg(feature = "mockup")]
    if let LaunchMode::Mockup(options) = mode {
        return crate::mockup::run(options);
    }
    if mode == LaunchMode::BuildInfo {
        print!("{}", cli::build_info());
        return std::process::ExitCode::SUCCESS;
    }
    if mode == LaunchMode::Help {
        println!(
            "herdr-gpui [--socket CLIENT_SOCKET | --session NAME [--dev]]\nConnects to Local and saved SSH hosts; never installs remote software.\nStarts the local Herdr daemon if needed; never stops it.\nExplicit --socket and --dev targets are attach-only; --socket isolates the GUI to one existing daemon."
        );
        println!(
            "  --build-info        Print the executable's build identity without starting the GUI"
        );
        println!(
            "  browser open URL    Show URL in a browser tab of the running app (see browser --help)"
        );
        #[cfg(feature = "integration-test")]
        println!(
            "  --integration-test  Run native GUI checks (requires explicit --socket)\n  --sidebar-test      Run native sidebar fixtures without connecting to a daemon\n  --performance-test  Measure native dense-terminal hover/scroll without a daemon (macOS)"
        );
        #[cfg(feature = "mockup")]
        println!(
            "  --mockup [--feedback PATH]\n                      Compare the UI variants built in from HERDR_MOCKUP_FILE; must come first"
        );
        return std::process::ExitCode::SUCCESS;
    }
    #[cfg(feature = "integration-test")]
    let integration_test = mode == LaunchMode::Integration;
    #[cfg(feature = "integration-test")]
    let sidebar_test = mode == LaunchMode::Sidebar;
    #[cfg(feature = "integration-test")]
    let performance_test = mode == LaunchMode::Performance;
    #[cfg(feature = "integration-test")]
    if mode != LaunchMode::Normal {
        smoke::EXIT_CODE.store(1, std::sync::atomic::Ordering::SeqCst);
    }
    let startup_failed = std::rc::Rc::new(std::cell::Cell::new(false));
    if let Err(error) = diagnostics::init() {
        eprintln!("Unable to initialize diagnostics: {error}");
        return std::process::ExitCode::FAILURE;
    }
    tracing::info!(
        version = APP_VERSION,
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "GPUI client starting"
    );
    // Only read first-frame settings here. Migration, defaults refresh, and font
    // discovery run after opening; CLI and fixtures skip personal settings.
    let appearance = if mode == LaunchMode::Normal {
        let started = std::time::Instant::now();
        let appearance = StartupAppearance::load(Config::load_startup);
        tracing::debug!(
            elapsed_us = started.elapsed().as_micros() as u64,
            "Startup appearance loaded"
        );
        appearance
    } else {
        StartupAppearance {
            dark: InitialAppearance::default(),
            light: None,
        }
    };
    let failed = startup_failed.clone();
    let window_state = (mode == LaunchMode::Normal).then(crate::window_state::WindowState::load);
    // Fixtures never ask about, or touch, agent configuration.
    let agent_skill = if mode == LaunchMode::Normal {
        crate::agent_skill::AgentSkill::load()
    } else {
        crate::agent_skill::AgentSkill::default()
    };
    // Fixtures start with no tabs and never write the file.
    let browser_tabs = if mode == LaunchMode::Normal {
        crate::browser::Store::load()
    } else {
        crate::browser::Store::default()
    };
    // Nor with usage Keychain grants, so a fixture never makes macOS ask.
    let keychain_grants = if mode == LaunchMode::Normal {
        crate::usage::KeychainGrants::load()
    } else {
        crate::usage::KeychainGrants::default()
    };
    // Nor with saved editor groups, which they would overwrite.
    let group_layouts = if mode == LaunchMode::Normal {
        crate::browser::Layouts::load()
    } else {
        crate::browser::Layouts::default()
    };
    // Nor with the user's worktree notes, which they would overwrite.
    let worktree_notes = if mode == LaunchMode::Normal {
        crate::worktree_notes::Notes::load()
    } else {
        crate::worktree_notes::Notes::default()
    };
    // Nor with where the user's worktrees went.
    let dispatch_history = if mode == LaunchMode::Normal {
        crate::dispatch::History::load()
    } else {
        crate::dispatch::History::default()
    };
    gpui_platform::application()
        .with_assets(icons::Icons)
        .run(move |cx| {
            let window_count = window_state.as_ref().map_or(1, |state| state.count());
            if let Some(state) = window_state {
                state.install(cx);
            }
            browser_tabs.install(cx);
            group_layouts.install(cx);
            worktree_notes.install(cx);
            dispatch_history.install(cx);
            agent_skill.install_global(cx);
            keychain_grants.install(cx);
            // Only the user's own app answers agents; native test modes stay private.
            if mode == LaunchMode::Normal {
                crate::control::install(cx);
                crate::window::system_notifications::install(cx);
            }
            cx.set_global(appearance.select(light_appearance(cx)));
            app_icon::install();
            #[cfg(target_os = "macos")]
            crate::app_badge::install(cx);
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.on_action(|_: &Hide, cx| cx.hide());
            cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
            cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
            cx.on_action(|_: &ShowLogs, cx| log_window::open(cx));
            bind_keys(cx);
            menus::install(cx);
            cx.on_window_closed(move |cx, _| {
                if cx.windows().is_empty() {
                    #[cfg(feature = "integration-test")]
                    if performance_test {
                        std::process::exit(1);
                    }
                    cx.quit();
                }
            })
            .detach();
            // Native test modes and CLI invocations never start an updater worker.
            let updater = if mode == LaunchMode::Normal {
                updater::Updater::start()
            } else {
                updater::Updater::default()
            };
            let opened = open_window(
                target.clone(),
                updater,
                cx,
                #[cfg(feature = "integration-test")]
                {
                    sidebar_test || performance_test
                },
            );
            match opened {
                Ok(_window) => {
                    if mode == LaunchMode::Normal {
                        let sound = shared_sound(cx);
                        let _ = _window.update(cx, |view, _, _| {
                            view.sound = sound;
                        });
                        for _ in 1..window_count {
                            open_additional_window(target.clone(), cx);
                        }
                    }
                    #[cfg(feature = "integration-test")]
                    if performance_test {
                        performance::start(_window, cx);
                    }
                    #[cfg(feature = "integration-test")]
                    if integration_test {
                        smoke::start(_window, cx);
                    }
                    #[cfg(feature = "integration-test")]
                    if sidebar_test {
                        smoke::start_sidebar(_window, cx);
                    }
                }
                Err(error) => {
                    tracing::error!("Unable to open main window");
                    eprintln!("Unable to open Herdr window: {error}");
                    failed.set(true);
                    #[cfg(feature = "integration-test")]
                    if performance_test {
                        std::process::exit(1);
                    }
                    cx.quit();
                }
            }
            cx.activate(true);
        });
    if startup_failed.get() {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::{Config, InitialAppearance, StartupAppearance, Theme};
    #[cfg(feature = "integration-test")]
    use super::{ConnectTarget, HerdrWindow};
    use crate::config::LayoutMode;
    #[cfg(feature = "integration-test")]
    use gpui::px;

    #[test]
    fn startup_appearance_loads_a_coherent_pair_and_reports_errors() {
        let appearance = InitialAppearance::load(
            || {
                let mut config = Config {
                    theme: "Nord".into(),
                    ..Default::default()
                };
                config.layout.mode = LayoutMode::from(crate::config::Density::Compact);
                Ok(config)
            },
            false,
        );
        assert_eq!(
            appearance.config.layout.mode,
            LayoutMode::from(crate::config::Density::Compact)
        );
        assert_eq!(Some(appearance.theme), Theme::builtin("Nord"));
        assert!(appearance.error.is_none());
        for appearance in [
            InitialAppearance::load(|| Err(crate::Error::MissingHome), false),
            InitialAppearance::load(
                || {
                    Ok(Config {
                        theme: "../invalid".into(),
                        ..Default::default()
                    })
                },
                false,
            ),
        ] {
            assert_eq!(
                appearance.config.layout.mode,
                LayoutMode::from(crate::config::Density::Normal)
            );
            assert_eq!(appearance.theme, Theme::default());
            assert!(appearance.error.is_some());
        }
    }

    #[test]
    fn startup_resolves_both_sides_so_the_first_frame_needs_no_disk_read() {
        let load = || {
            StartupAppearance::load(|| {
                Ok(Config {
                    theme: "light:Catppuccin Latte,dark:Nord".into(),
                    ..Default::default()
                })
            })
        };
        assert_eq!(
            Some(load().select(true).theme),
            Theme::builtin("Catppuccin Latte")
        );
        assert_eq!(Some(load().select(false).theme), Theme::builtin("Nord"));
        let single = StartupAppearance::load(|| {
            Ok(Config {
                theme: "Nord".into(),
                ..Default::default()
            })
        });
        assert!(single.light.is_none());
        assert_eq!(Some(single.select(true).theme), Theme::builtin("Nord"));
    }

    #[cfg(feature = "integration-test")]
    #[gpui::test]
    fn first_window_frame_uses_startup_layout(cx: &mut gpui::TestAppContext) {
        use crate::config::{Density, Style};
        for mode in [Density::Compact, Density::Normal, Density::Comfortable]
            .into_iter()
            .flat_map(|density| {
                [Style::Flat, Style::Rounded].map(|style| LayoutMode::new(density, style))
            })
        {
            let (view, cx) = cx.add_window_view(|window, cx| {
                let mut appearance = InitialAppearance::load(
                    || {
                        Ok(Config {
                            theme: "Nord".into(),
                            ..Default::default()
                        })
                    },
                    false,
                );
                appearance.config.layout.mode = mode;
                cx.set_global(appearance);
                HerdrWindow::new(
                    ConnectTarget::Socket("/unused-startup.sock".into()),
                    window,
                    cx,
                    true,
                )
            });
            // Draw immediately, without polling a background config completion.
            cx.update(|window, cx| {
                let state = view.read(cx);
                assert_eq!(state.config.layout.mode, mode);
                assert_eq!(Some(state.theme.clone()), Theme::builtin("Nord"));
                assert!(state.config_load.is_none());
                crate::sidebar::layout_tests::full_draw(window, cx).clear(cx);
            });
            let row = cx
                .debug_bounds("row-herdr")
                .unwrap_or_else(|| panic!("missing first-frame row"));
            // Rounded rows add padding inside their highlight and spacing
            // around it: a third of the density's gap, each, twice.
            assert_eq!(
                row.size.height,
                px(match (mode.density(), mode.style()) {
                    (Density::Compact, Style::Flat) => 16.,
                    (Density::Normal, Style::Flat) => 32.,
                    (Density::Comfortable, Style::Flat) => 40.,
                    (Density::Compact, Style::Rounded) => 16. + 2. + 2.,
                    (Density::Normal, Style::Rounded) => 32. + 4. + 4.,
                    (Density::Comfortable, Style::Rounded) => 40. + 6. + 6.,
                })
            );
        }
    }
}
