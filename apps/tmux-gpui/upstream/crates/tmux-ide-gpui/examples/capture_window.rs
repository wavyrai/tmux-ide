//! Dev-only: screenshots of the real window in catalog themes, with no display.
//! `cargo run -p tmux-ide-gpui --features visual-capture --example capture_window
//! -- <dir> dark,light,dracula,solarized-light`. Without args it reads
//! `TMUX_IDE_CAPTURE_DIR` and `TMUX_IDE_CAPTURE_THEMES`.
use std::path::PathBuf;

const DEFAULT_THEMES: &str = "dark,light,dracula,solarized-light";

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let dir = args
        .next()
        .or_else(|| std::env::var_os("TMUX_IDE_CAPTURE_DIR"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("usage: capture_window <dir> [theme,theme,...]"))?;
    let themes = args
        .next()
        .map(|themes| themes.to_string_lossy().into_owned())
        .or_else(|| std::env::var("TMUX_IDE_CAPTURE_THEMES").ok())
        .unwrap_or_else(|| DEFAULT_THEMES.into());
    let themes: Vec<&str> = themes
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect();
    // main() runs on the main thread, which the macOS platform requires.
    tmux_ide_gpui::capture_catalog_themes(&dir, &themes)
}
