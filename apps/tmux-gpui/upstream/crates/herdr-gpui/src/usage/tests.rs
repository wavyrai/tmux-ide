#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::{
    Reading, UsageConfig,
    cookies::CookieJar,
    model::{Account, Kind, Provider, Report, WEEK, Window},
    probe::{Consent, Exec, Probe},
    registry,
};
use crate::Error;
use std::time::{Duration, Instant, SystemTime};

#[cfg(unix)]
mod antigravity_consent;
mod browser_cookies;
#[cfg(unix)]
mod claude_keychain;
mod keychain_access;
mod labels;
mod provider_data;
mod provider_settings;
mod refresh;
#[cfg(unix)]
mod remote_hosts;
mod shown_providers;
mod status_bar_room;

fn at(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

fn provider(id: &str) -> Provider {
    registry::find(id).unwrap()
}

fn report(provider: Provider, used: f64) -> Report {
    Report::new(
        provider,
        Account::default(),
        vec![Window::new(Kind::Session, used, None, None)],
    )
}

fn begin(usage: &mut super::Usage, host: &super::Host, now: Instant) {
    usage.host = Some(host.clone());
    usage.begin(host.clone(), now);
}
