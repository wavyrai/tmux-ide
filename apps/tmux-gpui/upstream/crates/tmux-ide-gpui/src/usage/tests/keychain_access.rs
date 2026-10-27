use super::*;
use crate::usage::{Access, Host, Message, Usage, access};
use std::time::Instant;

/// Another app's Keychain item makes macOS ask, so it is read only once the
/// user allowed it; a refusal is not asked again until they allow it anew.
#[test]
fn foreign_keychain_items_wait_for_the_user() {
    const SERVER: &str = "https://herdr-gpui.invalid/no-such-item";
    let item = format!("find-internet-password\n{SERVER}\n42");
    let zed = provider("zed");
    let mut exec = Exec::Local;
    let mut jar = CookieJar::default();

    let mut probe = Probe::new(&mut exec, zed, None, &mut jar, Consent::Quiet);
    assert!(
        probe
            .foreign_keychain_internet(SERVER, Some("42"))
            .is_none()
    );
    assert!(matches!(probe.missing(), Error::UsageNotSignedIn));

    let ask = Consent::Ask { browsers: true };
    let mut probe = Probe::new(&mut exec, zed, None, &mut jar, ask);
    assert!(
        probe
            .foreign_keychain_internet(SERVER, Some("42"))
            .is_none()
    );
    assert!(probe.cookies(&["zed.dev"], &["zed.session"]).is_none());
    assert!(matches!(probe.missing(), Error::UsageKeychainAccess));
    assert!(!jar.refused(zed, &item), "nothing asked before Allow");

    let mut probe = Probe::new(&mut exec, zed, None, &mut jar, Consent::Keychain);
    assert!(
        probe
            .foreign_keychain_internet(SERVER, Some("42"))
            .is_none()
    );
    assert!(matches!(probe.missing(), Error::UsageKeychainDenied));
    assert!(jar.refused(zed, &item), "a refusal is remembered");

    jar.forgive(zed);
    assert!(!jar.refused(zed, &item), "Allow lets macOS ask again");
}

#[test]
fn a_denied_prompt_is_reported_for_its_grant_to_be_dropped() {
    let now = Instant::now();
    let zed = provider("zed");
    let mut usage = Usage::default();
    begin(&mut usage, &Host::Local, now);
    usage.apply(
        Message::Reading(Host::Local, zed, Err(Error::UsageKeychainAccess)),
        now,
    );
    let entry = usage.current().unwrap();
    assert_eq!(entry.readings[0].access, Some(Access::Needed));
    assert_eq!(
        entry.headline(crate::usage::HEADLINE, None).len(),
        1,
        "a sign-in waiting on Keychain access gets a status bar segment to open"
    );
    assert!(usage.take_denied().is_empty());

    usage.apply(
        Message::Reading(Host::Local, zed, Err(Error::UsageKeychainDenied)),
        now,
    );
    assert_eq!(
        usage.current().unwrap().readings[0].access,
        Some(Access::Denied)
    );
    assert_eq!(usage.take_denied(), [zed]);
    assert!(usage.take_denied().is_empty());
}

#[test]
fn allowing_reads_at_once_and_forgets_refusals_once() {
    let now = Instant::now();
    let zed = provider("zed");
    let mut usage = Usage::default();
    begin(&mut usage, &Host::Local, now);
    usage.apply(Message::Done(Host::Local, Ok(())), now);
    // Unlike Refresh, Allow is not spaced: macOS should ask right away.
    usage.allow(zed, now + Duration::from_secs(1));
    assert_eq!(
        usage.current().unwrap().due,
        Some(now + Duration::from_secs(1))
    );
    assert!(usage.retry.contains(&zed));
}

#[test]
fn saved_grants_keep_only_known_providers() {
    let granted = access::parse_saved(r#"{"providers":["zed","no-such-provider"]}"#).unwrap();
    assert_eq!(granted.len(), 1);
    assert!(granted.contains(&provider("zed")));
}
