//! Onboarding A0: Home's setup phases, its own states and the act-needed
//! card say what happens in plain words: no "daemon", "CLI", "fleet",
//! "catalog" or "F5".
use super::*;
use crate::tmux_snapshot::connection::{self, Act, jargon};
use browser::local_setup::Phase;

/// Every phase, so a new one has to be checked too.
fn phases() -> [Phase; 7] {
    let all = [
        Phase::Available,
        Phase::Running,
        Phase::Missing,
        Phase::Unsupported,
        Phase::Unrecognized,
        Phase::Failed,
        Phase::StoppedWaiting,
    ];
    for phase in all {
        match phase {
            Phase::Available
            | Phase::Running
            | Phase::Missing
            | Phase::Unsupported
            | Phase::Unrecognized
            | Phase::Failed
            | Phase::StoppedWaiting => {}
        }
    }
    all
}

/// Every act, so a new one has to be checked too.
fn acts() -> [Act; 8] {
    let all = [
        Act::DaemonUpdate,
        Act::Record,
        Act::Credentials,
        Act::Platform,
        Act::Unreadable,
        Act::GaveUp,
        Act::AppUpdate,
        Act::SshIdentity,
    ];
    for act in all {
        match act {
            Act::DaemonUpdate
            | Act::Record
            | Act::Credentials
            | Act::Platform
            | Act::Unreadable
            | Act::GaveUp
            | Act::AppUpdate
            | Act::SshIdentity => {}
        }
    }
    all
}

fn check(failures: &mut Vec<String>, what: &str, text: &str) {
    if let Some(word) = jargon(text) {
        failures.push(format!("{what}: {word:?} in {text:?}"));
    }
}

#[test]
fn setup_home_and_the_act_card_speak_plainly() {
    let mut failures = Vec::new();
    for phase in phases() {
        check(&mut failures, "phase label", phase.label());
        check(&mut failures, "phase guidance", phase.guidance());
        let state = browser::State {
            local_setup: Some(browser::local_setup::Setup { phase }),
            ..Default::default()
        };
        if let Some(card) = connection::card(&state, true) {
            check(&mut failures, "setup card", &card.title);
            check(&mut failures, "setup card", &card.detail);
            check(&mut failures, "setup card", card.action.unwrap_or_default());
        }
    }
    for act in acts() {
        // The detail is the publication's status, checked where it is made
        // (home_recovery's own test); here the card's own words.
        let state = browser::State {
            act: Some(act),
            status: "Plain status.".into(),
            ..Default::default()
        };
        let card = connection::card(&state, true).unwrap();
        check(&mut failures, "act card", card.slot);
        check(&mut failures, "act card", &card.title);
        check(&mut failures, "act card", &card.detail);
        check(&mut failures, "act card", card.action.unwrap_or_default());
    }
    for (what, text) in [
        ("credentials detail", connection::CREDENTIALS_DETAIL),
        ("connection lost", CONNECTION_LOST),
        ("list failed", LIST_FAILED),
        ("empty title", EMPTY_TITLE),
        ("empty hint", EMPTY_HINT),
        ("local guidance", LOCAL_GUIDANCE),
        ("setup not sent", SETUP_NOT_SENT),
    ] {
        check(&mut failures, what, text);
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// browser_local_setup.rs holds only user-facing words: every string
/// literal in it reads plainly.
#[test]
fn every_string_in_the_setup_phases_is_plain() {
    let source: String = include_str!("../../browser_local_setup.rs")
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut failures = Vec::new();
    for (index, part) in source.split('"').enumerate() {
        // Odd parts sit between quotes.
        if index % 2 == 1 {
            check(&mut failures, "literal", part);
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// About Tmux IDE (0.1.17) reads plainly too: every string literal in
/// about.rs that a user can read.
#[test]
fn every_string_in_about_is_plain() {
    let source: String = include_str!("../../about.rs")
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut failures = Vec::new();
    for (index, part) in source.split('"').enumerate() {
        if index % 2 == 1 {
            check(&mut failures, "about literal", part);
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn the_jargon_check_finds_each_word() {
    for (text, word) in [
        ("Start the local daemon.", "daemon"),
        ("Install the tmux-ide CLI.", "CLI"),
        ("select a fleet server", "fleet"),
        ("The catalog is empty", "catalog"),
        ("Copy diagnostics in the F5 menu", "F5"),
    ] {
        assert_eq!(jargon(text), Some(word), "{text}");
    }
    assert_eq!(jargon("Clicking the client"), None);
}
