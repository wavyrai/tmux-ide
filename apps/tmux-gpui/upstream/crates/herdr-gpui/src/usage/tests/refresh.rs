use super::*;
use crate::usage::{Host, Message, Usage};
use std::{collections::HashSet, time::Instant};

#[test]
fn a_failed_refresh_keeps_the_last_numbers_and_says_why() {
    let now = Instant::now();
    let (claude, codex) = (provider("claude"), provider("codex"));
    let local = Host::Local;
    let mut usage = Usage::default();
    assert!(usage.poll(
        Some(local.clone()),
        &UsageConfig::default(),
        &HashSet::new(),
        0,
        false,
        now,
    ));
    assert!(
        usage.current().is_none(),
        "an inactive window reads nothing"
    );

    begin(&mut usage, &local, now);
    assert!(usage.busy());
    usage.apply(
        Message::Reading(local.clone(), claude, Ok(report(claude, 20.))),
        now,
    );
    usage.apply(Message::Done(local.clone(), Ok(())), now);
    assert!(!usage.busy());

    begin(&mut usage, &local, now);
    usage.apply(
        Message::Reading(local.clone(), claude, Err(Error::UsageRateLimited)),
        now,
    );
    usage.apply(
        Message::Reading(local.clone(), codex, Err(Error::UsageRejected)),
        now,
    );
    usage.apply(Message::Done(local.clone(), Ok(())), now);
    let entry = usage.current().unwrap();
    assert_eq!(
        entry.readings,
        [
            Reading {
                provider: codex,
                report: None,
                error: Some(Error::UsageRejected.to_string()),
                access: None,
            },
            Reading {
                provider: claude,
                report: Some(report(claude, 20.)),
                error: Some(Error::UsageRateLimited.to_string()),
                access: None,
            },
        ],
        "registry order, whatever order answers came in"
    );
    assert_eq!(entry.due, Some(now + super::super::RATE_LIMITED));

    begin(&mut usage, &local, now);
    usage.apply(
        Message::Done(local.clone(), Err(Error::UsageUnreachable)),
        now,
    );
    let entry = usage.current().unwrap();
    assert_eq!(
        entry.readings.len(),
        2,
        "an unreachable host keeps its readings"
    );
    assert_eq!(entry.due, Some(now + super::super::ERROR_BACKOFF));

    begin(&mut usage, &local, now);
    usage.apply(
        Message::Reading(local.clone(), codex, Ok(report(codex, 5.))),
        now,
    );
    usage.apply(Message::Done(local.clone(), Ok(())), now);
    let entry = usage.current().unwrap();
    assert_eq!(
        entry.readings.len(),
        1,
        "a provider that went silent is dropped"
    );
    assert_eq!(entry.readings[0].provider, codex);
}

#[test]
fn each_host_keeps_its_own_answer_within_a_bound() {
    let now = Instant::now();
    let claude = provider("claude");
    let mut usage = Usage::default();
    let remote = Host::Ssh("me@box".into());
    for host in [Host::Local, remote.clone()] {
        begin(&mut usage, &host, now);
        usage.apply(
            Message::Reading(host.clone(), claude, Ok(report(claude, 1.))),
            now,
        );
        usage.apply(Message::Done(host, Ok(())), now);
    }
    let config = UsageConfig::default();
    usage.poll(Some(Host::Local), &config, &HashSet::new(), 0, false, now);
    assert_eq!(usage.current().unwrap().readings.len(), 1);
    usage.poll(None, &config, &HashSet::new(), 0, false, now);
    assert!(usage.current().is_none());
    usage.poll(
        Some(remote.clone()),
        &config,
        &HashSet::new(),
        0,
        false,
        now,
    );
    for index in 0..super::super::HOST_LIMIT * 2 {
        usage.begin(Host::Ssh(format!("host-{index}")), now);
    }
    usage.busy = None;
    assert!(usage.entries.len() <= super::super::HOST_LIMIT);
    assert!(
        usage.current().is_some(),
        "the shown host survives trimming"
    );
    // A new config makes every host due.
    usage.poll(
        Some(remote.clone()),
        &config,
        &HashSet::new(),
        1,
        false,
        now,
    );
    assert!(usage.entries.values().all(|entry| entry.due == Some(now)));
}

#[test]
fn manual_refresh_is_spaced() {
    let now = Instant::now();
    let mut usage = Usage::default();
    begin(&mut usage, &Host::Local, now);
    usage.apply(Message::Done(Host::Local, Ok(())), now);
    usage.refresh(now + Duration::from_secs(1));
    assert_eq!(
        usage.current().unwrap().due,
        Some(now + super::super::REFRESH)
    );
    usage.refresh(now + super::super::MANUAL_SPACING);
    assert_eq!(
        usage.current().unwrap().due,
        Some(now + super::super::MANUAL_SPACING)
    );
}

/// Reads this machine's real sign-ins and prints what each provider found:
/// `cargo test -p herdr-gpui live_local_usage -- --ignored --nocapture`.
/// Prints windows, balances, and typed errors only, never credentials.
#[test]
#[ignore = "reads this machine's agent sign-ins and calls their services"]
fn live_local_usage() {
    let mut jar = CookieJar::default();
    super::super::read(
        &Host::Local,
        &UsageConfig::default(),
        &HashSet::new(),
        &mut jar,
        |provider, report| {
            match report {
                Ok(report) => println!(
                    "{}: plan {:?}, windows {:?}, balances {:?}",
                    provider.id(),
                    report.account.plan,
                    report
                        .windows
                        .iter()
                        .map(|w| format!("{} {}%", w.kind.title(), w.percent()))
                        .collect::<Vec<_>>(),
                    report.balances.iter().map(|b| b.text()).collect::<Vec<_>>()
                ),
                Err(error) => println!("{}: error {error:?}", provider.id()),
            }
            true
        },
    )
    .unwrap();
}
