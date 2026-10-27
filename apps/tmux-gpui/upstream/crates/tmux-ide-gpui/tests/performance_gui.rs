//! Explicit native opt-in: unlike GPUI unit tests, this launches a real AppKit app.
#![cfg(target_os = "macos")]
use anyhow::{Context as _, Result, bail};
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
#[ignore = "opens native fixture window; run explicitly on a macOS desktop"]
fn dense_terminal_sidebar_performance() -> Result<()> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_herdr-gpui"))
        .arg("--performance-test")
        .env_remove("HERDR_PERF_UNCACHED")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("spawning native performance fixture")?;
    let start = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .context("polling native performance fixture")?
        {
            assert!(
                status.success(),
                "native performance fixture failed: {status}"
            );
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(180) {
            child
                .kill()
                .context("killing timed-out native performance fixture")?;
            child
                .wait()
                .context("reaping timed-out native performance fixture")?;
            bail!("native performance fixture timed out");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
