//! Dedicated product boundary: no argument can dispatch to Herdr startup.
use std::{ffi::OsString, process::ExitCode};

const HELP: &str = "tmux-ide native preview\n\
Usage: tmux-ide-gpui [--help | --version | --tmux-live-stdin | --tmux-browser-stdio | --tmux-snapshot FILE [--validate-only]]\n\
No arguments opens the disconnected preview window.\n\
Live connections currently require the monorepo live-preview.sh launcher.\n\
Native session selection, basic keyboard input and Cmd-V paste are available through browse-preview.sh. Native text composition and window resizing are experimental; automatic reconnect is not available yet.";

pub(crate) fn run(args: Vec<OsString>) -> ExitCode {
    let result = match args.first().and_then(|arg| arg.to_str()) {
        None if args.is_empty() => crate::tmux_snapshot::welcome(),
        Some("--help" | "-h") if args.len() == 1 => {
            println!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Some("--version") if args.len() == 1 => {
            // Upstream's package version is not a tmux-ide release version.
            println!("tmux-ide-gpui development preview (unreleased)");
            return ExitCode::SUCCESS;
        }
        Some("--tmux-browser-stdio") if args.len() == 1 => crate::tmux_snapshot::browse(),
        Some("--tmux-live-stdin") if args.len() == 1 => crate::tmux_snapshot::live(),
        Some("--tmux-snapshot")
            if args.len() == 2 || (args.len() == 3 && args[2] == "--validate-only") =>
        {
            crate::tmux_snapshot::run(args.into_iter().skip(1).collect())
        }
        _ => {
            eprintln!("Invalid preview arguments.\n{HELP}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
