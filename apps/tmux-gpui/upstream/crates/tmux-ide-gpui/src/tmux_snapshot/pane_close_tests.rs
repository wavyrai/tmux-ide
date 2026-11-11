use super::*;
use core::prelude::v1::test;

fn plain(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|s| match s {
            Segment::Text(t) => t.as_str(),
            Segment::Code(c) => c,
        })
        .collect()
}

#[test]
fn an_agent_mid_turn_says_it_stops_and_how_to_resume() {
    let body = body(Some(("Claude", Some("claude-code"), Agent::Working)));
    assert_eq!(
        plain(&body),
        "Claude is working on this. Closing stops it mid-turn. The conversation is saved; \
         claude --resume in a new pane picks it up."
    );
    assert!(body.contains(&Segment::Code("claude --resume")));
    let codex = body_text(Some(("Codex", Some("codex"), Agent::Working)));
    assert!(codex.contains("codex resume in a new pane"));
    // A harness with no resume story.
    assert_eq!(
        body_text(Some(("Aider", Some("aider"), Agent::Working))),
        "Aider is working on this. The agent stops mid-turn."
    );
}

fn body_text(agent: Option<(&str, Option<&str>, Agent)>) -> String {
    plain(&body(agent))
}

#[test]
fn an_agent_at_rest_still_asks_and_says_how_to_resume() {
    assert_eq!(
        body_text(Some(("Codex", Some("codex"), Agent::AtRest))),
        "Codex has finished. Closing ends the agent; the conversation is saved, and \
         codex resume in a new pane picks it up."
    );
    assert_eq!(
        body_text(Some(("Agent", None, Agent::AtRest))),
        "Agent has finished. Closing ends the agent."
    );
}

#[test]
fn anything_else_gets_the_generic_line() {
    assert_eq!(body_text(None), "The shell and anything running in it end.");
    assert_eq!(title("cargo test"), "Close “cargo test”?");
}

#[test]
fn the_roster_decides_working_or_at_rest() {
    let row = |status: &str, attention: bool| -> Row {
        serde_json::from_value(serde_json::json!({"key":"k","sessionId":"s","paneId":"p",
            "name":"Claude","sessionLabel":"x","harness":"claude-code","status":status,
            "attention":attention,"available":true}))
        .unwrap_or_else(|e| panic!("{e}"))
    };
    for (status, attention, expected) in [
        ("WORKING", false, Agent::Working),
        ("BLOCKED", false, Agent::Working),
        ("IDLE", true, Agent::Working),
        ("DONE", false, Agent::AtRest),
        ("IDLE", false, Agent::AtRest),
        ("DISCONNECTED", false, Agent::Unknown),
        ("FAILED", false, Agent::Failed),
        // Asking for the user still reads as working, whatever the state.
        ("DISCONNECTED", true, Agent::Working),
        ("FAILED", true, Agent::Working),
    ] {
        let rows = [row(status, attention)];
        assert_eq!(
            agent_on(&rows, "p", false).map(|(_, a)| a),
            Some(expected),
            "{status}"
        );
        assert!(agent_on(&rows, "q", false).is_none());
    }
}

#[test]
fn the_card_hangs_under_its_button_and_flips_above_near_the_bottom() {
    let viewport = size(px(1440.), px(900.));
    let button = Bounds::new(point(px(1000.), px(40.)), size(px(24.), px(24.)));
    let (at, anchor) = placement(button, viewport);
    assert_eq!(anchor, Anchor::TopRight);
    assert_eq!(at, point(px(1024.), px(70.)));
    // A bottom pane's button with under 140 pt below: the card flips above.
    let low = Bounds::new(point(px(1000.), px(780.)), size(px(24.), px(24.)));
    let (at, anchor) = placement(low, viewport);
    assert_eq!(anchor, Anchor::BottomRight);
    assert_eq!(at, point(px(1024.), px(774.)));
}

/// The line wraps between words; the 12 pt command is one word with the
/// space after it, and no word starts with a space.
#[test]
fn the_body_wraps_between_words_and_keeps_the_command_whole() {
    let body = body(Some(("Claude", Some("claude-code"), Agent::Working)));
    let words = words(&body);
    let joined: String = words.iter().flatten().map(|(t, _)| t.as_str()).collect();
    assert_eq!(joined, plain(&body));
    assert!(words.iter().all(|w| !w[0].0.starts_with(' ')));
    assert!(words.contains(&vec![("saved; ".into(), false)]));
    assert!(words.contains(&vec![("claude --resume".into(), true), (" ".into(), false)]));
    assert!(words.contains(&vec![("in ".into(), false)]));
    assert_eq!(words.iter().flatten().filter(|(_, code)| *code).count(), 1);
}

/// #356 review: a Disconnected or Failed agent is never "finished"; each
/// state's line says only what is true of it.
#[test]
fn every_agent_state_reads_true() {
    let claude = |state| body_text(Some(("Claude", Some("claude-code"), state)));
    let other = |state| body_text(Some(("Aider", Some("aider"), state)));
    assert_eq!(
        claude(Agent::Unknown),
        "Claude isn't reporting its state, so it may still be running. Closing stops it \
         if it is. The conversation is saved; claude --resume in a new pane picks it up."
    );
    assert_eq!(
        other(Agent::Unknown),
        "Aider isn't reporting its state, so it may still be running. Closing stops it if it is."
    );
    assert_eq!(
        claude(Agent::Failed),
        "Claude stopped with an error. Closing ends the agent; the conversation is saved, \
         and claude --resume in a new pane picks it up."
    );
    assert_eq!(
        other(Agent::Failed),
        "Aider stopped with an error. Closing ends the agent."
    );
    for state in [Agent::Working, Agent::Unknown, Agent::Failed] {
        assert!(!claude(state).contains("finished"), "{state:?}");
        assert!(!other(state).contains("finished"), "{state:?}");
    }
}
