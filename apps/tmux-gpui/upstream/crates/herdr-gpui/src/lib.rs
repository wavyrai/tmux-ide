// objc 0.2's selectors expand a legacy cargo-clippy cfg in the native test adapter.
#![cfg_attr(feature = "integration-test", allow(unexpected_cfgs))]

// tmux-ide modification: isolated read-only snapshot entry point.
mod about;
mod actions;
mod agent_notes;
mod agent_skill;
mod app;
#[cfg(any(target_os = "macos", test))]
mod app_badge;
mod app_icon;
mod avatars;
mod bell;
mod browser;
mod caffeine;
mod checkpoint;
mod cli;
mod close_modal;
mod tmux_cli;
mod tmux_snapshot;

pub fn run_tmux() -> std::process::ExitCode {
    tmux_cli::run(std::env::args_os().skip(1).collect())
}
// `cloud` is the machinery every provider shares; alone it offers nothing to add.
#[cfg(all(feature = "cloud", not(any(feature = "coder", feature = "daytona"))))]
compile_error!(
    "the `cloud` feature is enabled through a provider feature, such as `coder` or `daytona`"
);
#[cfg(feature = "cloud")]
mod cloud;
#[cfg(feature = "coder")]
mod coder;
mod config;
mod config_diagnostic;
mod connection;
mod constants;
mod contrast;
mod control;
mod controls;
mod copy_mode;
mod daemon;
#[cfg(feature = "daytona")]
mod daytona;
mod diagnostics;
mod dialog_input;
mod dispatch;
mod endpoint;
mod error;
mod fan_out;
mod find;
mod font_picker;
mod font_sizes;
mod fonts;
mod git;
mod github;
mod group_menu;
mod group_terminals;
mod herdr_settings;
mod icons;
mod input;
mod integrations;
mod keymap;
mod lenient;
mod links;
mod listening_ports;
mod local_path;
mod log_window;
mod login_env;
mod menu;
mod menus;
#[cfg(feature = "mockup")]
mod mockup;
mod motion;
mod navigation;
mod notifications;
mod osc52;
mod palette;
mod pane_menu;
mod panel_resize;
mod port_forward;
mod pr_actions;
mod preferences;
mod presentation;
mod processes;
mod progress;
mod pull_request;
mod release_notes;
mod reorder;
mod repo_items;
mod review;
mod scrollback;
mod search_input;
mod sessions;
mod settings_panel;
mod settings_window;
mod sidebar;
mod sound;
mod state;
mod state_file;
mod storage_warning;
mod system_load;
mod tab_menu;
mod teleport;
mod terminal;
mod terminal_painter;
mod theme_picker;
mod titlebar;
mod toggles;
mod update_panel;
mod updater;
mod usage;
mod window;
mod window_state;
mod worktree;
mod worktree_banner;
mod worktree_notes;
mod worktree_scripts;

#[cfg(feature = "integration-test")]
mod performance;
#[cfg(feature = "integration-test")]
mod smoke;
#[cfg(all(test, unix))]
mod test_executable;

pub use error::{Error, Result};

pub(crate) use {
    actions::{
        CheckForUpdates, Hide, HideOthers, Minimize, PlaySound, Quit, RunCommand, ShowAll,
        ShowHerdrNotDetected, ShowLogs, ShowUpdatePreview, bind_keys,
    },
    app::open_additional_window,
    constants::{APP_VERSION, RELEASE_BUILD, TAB_HEIGHT, TAB_WIDTH, WINDOW_TITLE},
    menus::menus,
    navigation::{NavigationTarget, OwnedNavigationTarget},
    window::HerdrWindow,
};

// Re-exported at the root because they are referenced crate-wide; the domain
// modules below are where they are defined and changed.
#[cfg(feature = "integration-test")]
pub(crate) use app::open_window;
// Only the macOS smoke checks drive the connection status from the root.
#[cfg(all(feature = "integration-test", target_os = "macos"))]
pub(crate) use state::ConnectionStatus;

pub(crate) use {controls::Command, state::LiveState, terminal::WheelAccumulator};

pub fn run_herdr() -> std::process::ExitCode {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some(std::ffi::OsStr::new("--tmux-live-stdin")) {
        if args.next().is_some() {
            eprintln!("--tmux-live-stdin takes no arguments");
            return std::process::ExitCode::FAILURE;
        }
        return match tmux_snapshot::live() {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    if first.as_deref() == Some(std::ffi::OsStr::new("--tmux-snapshot")) {
        return match tmux_snapshot::run(args.collect()) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    let exit = app::run();
    if exit != std::process::ExitCode::SUCCESS {
        return exit;
    }
    #[cfg(feature = "integration-test")]
    return std::process::ExitCode::from(
        smoke::EXIT_CODE.load(std::sync::atomic::Ordering::SeqCst),
    );
    #[cfg(not(feature = "integration-test"))]
    std::process::ExitCode::SUCCESS
}
