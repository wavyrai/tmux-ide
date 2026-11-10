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
    ] {
        let rows = [row(status, attention)];
        assert_eq!(
            agent_on(&rows, "p").map(|(_, a)| a),
            Some(expected),
            "{status}"
        );
        assert!(agent_on(&rows, "q").is_none());
    }
}
