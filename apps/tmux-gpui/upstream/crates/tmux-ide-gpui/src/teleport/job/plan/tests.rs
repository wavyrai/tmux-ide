#![allow(clippy::unwrap_used)]
use super::*;
use crate::teleport::launch::{AgentKind, handoff_path};
use crate::teleport::snapshot::{AgentSession, SessionKind};

fn installed(programs: &[&str]) -> Vec<String> {
    programs.iter().map(|p| (*p).to_owned()).collect()
}

fn session(agent: AgentKind) -> Work {
    Work::Session {
        agent,
        session: AgentSession {
            agent: agent.name().into(),
            kind: SessionKind::Id,
            source: format!("herdr:{}", agent.name()),
            value: "id".into(),
        },
        flags: vec![],
    }
}

#[test]
fn actions_resume_when_possible_and_hand_off_otherwise() {
    let note = || "note".to_owned();
    assert_eq!(
        plan_action(
            &session(AgentKind::Opencode),
            &installed(&["opencode"]),
            note
        ),
        Action::Resume(AgentKind::Opencode)
    );
    // The destination lacks opencode, so the first available agent takes over.
    assert_eq!(
        plan_action(
            &session(AgentKind::Opencode),
            &installed(&["codex", "pi"]),
            note
        ),
        Action::Handoff {
            note: "note".into(),
            to: AgentKind::Codex
        }
    );
    assert_eq!(
        plan_action(&session(AgentKind::Claude), &installed(&[]), note),
        Action::Missing("claude".into())
    );
    let sessionless = Work::Agent {
        name: "claude".into(),
        argv: vec!["claude".into()],
    };
    assert_eq!(
        plan_action(&sessionless, &installed(&["claude"]), note),
        Action::Handoff {
            note: "note".into(),
            to: AgentKind::Claude
        }
    );
    // A known agent that cannot take a first prompt starts afresh.
    let droid = Work::Agent {
        name: "droid".into(),
        argv: vec!["droid".into(), "--auto".into(), "high".into()],
    };
    assert_eq!(
        plan_action(&droid, &installed(&["droid", "claude"]), note),
        Action::Start(vec!["droid".into(), "--auto".into(), "high".into()])
    );
    let copilot = Work::Agent {
        name: "copilot".into(),
        argv: vec!["copilot".into()],
    };
    assert_eq!(
        plan_action(&copilot, &installed(&["copilot"]), note),
        Action::Handoff {
            note: "note".into(),
            to: AgentKind::Copilot
        }
    );
    assert_eq!(
        plan_action(&session(AgentKind::Copilot), &installed(&["copilot"]), note),
        Action::Resume(AgentKind::Copilot)
    );
    let unknown = Work::Agent {
        name: "gemini".into(),
        argv: vec!["gemini".into(), "-y".into()],
    };
    assert_eq!(
        plan_action(&unknown, &installed(&["gemini"]), note),
        Action::Start(vec!["gemini".into(), "-y".into()])
    );
    assert_eq!(
        plan_action(&Work::Command(vec!["make".into()]), &installed(&[]), note),
        Action::Run(vec!["make".into()])
    );
    assert_eq!(
        plan_action(&Work::Shell, &installed(&[]), note),
        Action::Shell
    );
}

#[test]
fn notes_are_numbered_only_when_handed_off() {
    let notes = std::cell::Cell::new(0);
    let next = || {
        let path = handoff_path(notes.get());
        notes.set(notes.get() + 1);
        path
    };
    assert_eq!(
        plan_action(&session(AgentKind::Claude), &installed(&["claude"]), next),
        Action::Resume(AgentKind::Claude)
    );
    assert_eq!(notes.get(), 0);
    assert!(matches!(
        plan_action(&session(AgentKind::Pi), &installed(&["claude"]), next),
        Action::Handoff { note, .. } if note == ".herdr/teleport/handoff-1.md"
    ));
    assert_eq!(notes.get(), 1);
}
