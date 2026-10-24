//! Isolated native input qualification. The owner supplies a private scratch capability on stdin.
use herdr_client::{
    tmux_control::{Authority, Input, InputResult, Lifetime},
    tmux_controller::Controller,
    tmux_handoff::Handoff,
};
use std::{
    io::{self, Read},
    time::{Duration, Instant},
};
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin().take(16385).read_to_end(&mut bytes)?;
    let handoff = Handoff::parse(&bytes)?;
    let pane = handoff.selected_pane.clone();
    let mut controller = Controller::spawn(handoff)?;
    let start = Instant::now();
    let mut stage = 0;
    let mut acks = 0;
    controller.presence(true, 1, 0)?;
    while start.elapsed() < Duration::from_secs(20) {
        let now = u64::try_from(start.elapsed().as_millis())?;
        let update = controller.poll(now)?;
        for input in update.inputs {
            if input.result != InputResult::Ok {
                return Err("input completion was uncertain".into());
            }
            acks += 1;
        }
        let coherent = update.window.as_ref().is_some_and(|w| w.coherent);
        if controller.owns(Authority::Input) && coherent {
            let committed = controller
                .committed(&pane)
                .ok_or("missing canonical pane")?;
            let lifetime = Lifetime {
                generation: committed.identity.generation.clone(),
                incarnation: committed.identity.incarnation.clone(),
            };
            if stage == 0 {
                // The expected output never appears contiguously in the typed command.
                controller.input(
                    &pane,
                    &lifetime,
                    Input::Text("printf 'RIG_NATIVE_%s\\n' 'CONTROL_DONE'".into()),
                    now,
                )?;
                stage = 1;
            } else if stage == 1 && acks == 1 {
                controller.input(&pane, &lifetime, Input::Key("Enter".into()), now)?;
                stage = 2;
            }
        }
        if stage == 2
            && acks == 2
            && let Some(snapshot) = controller
                .committed(&pane)
                .and_then(|p| p.snapshot.as_ref())
        {
            let observed = snapshot.grid.iter().any(|row| {
                row.cells()
                    .iter()
                    .map(|c| c.grapheme.as_ref())
                    .collect::<String>()
                    .contains("RIG_NATIVE_CONTROL_DONE")
            });
            if observed {
                println!(
                    "{}",
                    serde_json::json!({"inputAcknowledgements":acks,"controlledOutput":true,"coherent":coherent})
                );
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Err("native controller probe timed out".into())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("native controller probe failed: {error}");
        std::process::exit(1);
    }
}
