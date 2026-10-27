//! Dedicated product boundary: no argument can dispatch to Herdr startup.
use std::{ffi::OsString, process::ExitCode};

const HELP: &str = "tmux-ide native preview\n\
Usage: tmux-ide-gpui [--help | --version | --tmux-live-stdin | --tmux-browser-stdio | --tmux-native-local | --tmux-native-daemon RECORD | --tmux-native-ssh TARGET [--environment UUID] [--local-daemon RECORD] | --tmux-browser-helper NODE BROKER HOST | --tmux-snapshot FILE [--validate-only]]\n\
No arguments opens the disconnected preview window.\n\
Native local startup resolves the validated runtime namespace; explicit daemon-record and SSH development entries remain available. Local registry operations require an explicit local record.\n\
Native session selection, basic keyboard input and Cmd-V paste are available through browse-preview.sh. Native text composition and window resizing are experimental; native catalog entries support bounded reconnect.";

pub(crate) fn run(args: Vec<OsString>) -> ExitCode {
    let result = match args.first().and_then(|arg| arg.to_str()) {
        None if args.is_empty() => crate::tmux_snapshot::welcome(),
        Some("--help" | "-h") if args.len() == 1 => {
            println!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Some("--tmux-bridge-capabilities") if args.len() == 1 => {
            println!(
                r#"{{"version":1,"snapshotEncodings":["rle-v1","rle-delta-v1","binary-rle-v1"]}}"#
            );
            return ExitCode::SUCCESS;
        }
        Some("--version") if args.len() == 1 => {
            // Upstream's package version is not a tmux-ide release version.
            println!("tmux-ide-gpui development preview (unreleased)");
            return ExitCode::SUCCESS;
        }
        Some("--tmux-native-local") if args.len() == 1 => {
            crate::tmux_snapshot::browse_native_local()
        }
        Some("--tmux-native-daemon") if args.len() == 2 => {
            crate::tmux_snapshot::browse_native((&args[1]).into())
        }
        #[cfg(unix)]
        Some("--tmux-native-ssh") if args.len() == 2 => {
            crate::tmux_snapshot::browse_native_remote(&args[1], None, None)
        }
        #[cfg(unix)]
        Some("--tmux-native-ssh") if args.len() == 4 && args[2] == "--environment" => {
            crate::tmux_snapshot::browse_native_remote(&args[1], Some(&args[3]), None)
        }
        #[cfg(unix)]
        Some("--tmux-native-ssh") if args.len() == 4 && args[2] == "--local-daemon" => {
            crate::tmux_snapshot::browse_native_remote(&args[1], None, Some((&args[3]).into()))
        }
        #[cfg(unix)]
        Some("--tmux-native-ssh")
            if args.len() == 6 && args[2] == "--environment" && args[4] == "--local-daemon" =>
        {
            crate::tmux_snapshot::browse_native_remote(
                &args[1],
                Some(&args[3]),
                Some((&args[5]).into()),
            )
        }
        Some("--tmux-browser-stdio") if args.len() == 1 => crate::tmux_snapshot::browse(),
        Some("--tmux-browser-helper") if args.len() == 4 => {
            crate::tmux_snapshot::browse_with_helper(&args[1], &args[2], &args[3])
        }
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
