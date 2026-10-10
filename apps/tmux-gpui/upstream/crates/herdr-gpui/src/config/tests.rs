use super::*;
use anyhow::Context as _;
use std::sync::atomic::{AtomicU64, Ordering};

mod bitmap_fonts;
mod bold_color;
mod default_fonts;
mod discovery;
mod fonts;
mod github;
mod keybindings;
mod line_height;
mod loading;
mod notification_settings;
mod preferences;
mod sidebar_settings;
mod sidebar_style;
mod status_bar;
mod system_themes;
mod theme_files;
mod themes;

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let path = env::temp_dir().join(format!(
                "herdr-theme-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
