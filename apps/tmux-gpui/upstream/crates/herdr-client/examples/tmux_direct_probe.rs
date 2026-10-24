//! Isolated live-daemon qualification: reads a private, one-use handoff from stdin.
//! Prints structural commit evidence only; never terminal cells or credentials.
use herdr_client::{tmux_controller::Controller, tmux_handoff::Handoff};
use std::{
    io::{self, Read},
    time::{Duration, Instant},
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin().take(16385).read_to_end(&mut bytes)?;
    if bytes.len() > 16384 {
        return Err("handoff too large".into());
    }
    let handoff = Handoff::parse(&bytes)?;
    let mut controller = Controller::spawn(handoff)?;
    let started = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut commits = 0;
    while Instant::now() < deadline {
        let updates = controller.poll(started.elapsed().as_millis() as u64)?;
        for (_, update) in updates.panes {
            commits += 1;
            println!(
                "{}",
                serde_json::json!({"commits":commits,
                "revision":update.identity.canonical_revision,
                "changedRows":update.changed_rows,
                "rows":update.snapshot.as_ref().map(|s|s.rows),
                "alternateScreen":update.snapshot.as_ref().map(|s|s.modes.alternate_screen),
                "deferredHistoryRows":update.snapshot.as_ref().and_then(|s| match &s.history {
                    herdr_client::tmux_delivery::History::Deferred(history) => Some(history.rows),
                    herdr_client::tmux_delivery::History::Complete(_) => None,
                })})
            );
            if commits >= 3 {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Err("direct terminal probe timed out".into())
}
fn main() {
    if let Err(error) = run() {
        // Display is deliberately redacted; sources may contain server payloads.
        eprintln!("direct terminal probe failed: {error}");
        std::process::exit(1);
    }
}
