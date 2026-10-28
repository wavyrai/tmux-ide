//! Amp Free, subscription, and credit balances, in CodexBar's order: the Amp
//! CLI's own report (`amp usage`, from `PATH` or `~/.amp/bin`), then an
//! access token from the config or `AMP_API_KEY` sent to the
//! `userDisplayBalanceInfo` call, which answers with the same report text,
//! then the ampcode.com `session` cookie (the `cookie` setting, else, when
//! the provider is listed, Chrome or Safari) for the settings page, which
//! only carries Amp Free.
//!
//! Not ported: CodexBar reads the CLI's standard error when standard output
//! is empty; the probe discards standard error, so such a report is missed.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, DAY, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
        values::invalid,
    },
};
use chrono::{Datelike, Months, NaiveDate, TimeZone, Utc, Weekday};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const API_URL: &str = "https://ampcode.com/api/internal?userDisplayBalanceInfo";
const SETTINGS_URL: &str = "https://ampcode.com/settings";
/// Runs the Amp CLI from `PATH`, else from its installer's directory.
const CLI: &str = r#"if command -v amp >/dev/null 2>&1; then exec amp usage; elif [ -x "$HOME/.amp/bin/amp" ]; then exec "$HOME/.amp/bin/amp" usage; else exit 127; fi"#;

pub(crate) struct Amp;

static META: Meta = Meta::new("amp", "Amp")
    .dashboard("https://ampcode.com/settings/usage")
    .settings(&[
        Setting::new(
            "api_key",
            &["AMP_API_KEY"],
            "An Amp access token, created in Amp's settings at \
             https://ampcode.com/settings. Not needed when the Amp CLI is installed and \
             signed in on the host (`amp login`).",
        ),
        Setting::new(
            "cookie",
            &[],
            "Your ampcode.com browser session, used when neither the CLI nor a token is \
             available; it shows Amp Free only. Sign in at https://ampcode.com, open \
             Developer Tools → Application → Cookies → https://ampcode.com, and copy the \
             `session` cookie as \"session=value\".",
        ),
    ]);

impl Service for Amp {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let now = SystemTime::now();
        let mut failure = None;
        if let Ok(output) = probe.command("sh", &["-c", CLI], Duration::from_secs(15))
            && output.success
        {
            match parse_report(&output.stdout, now) {
                Ok(report) => return Some(Ok(report)),
                Err(Error::UsageRejected) => failure = Some(Error::UsageRejected),
                Err(_) => failure = Some(Error::UsageCommand("amp usage")),
            }
        }

        if let Some(token) = probe
            .setting("api_key")
            .or_else(|| probe.env("AMP_API_KEY"))
        {
            let request = Request::post(API_URL)
                .bearer(&token)
                .header("Accept", "application/json")
                .json(r#"{"method":"userDisplayBalanceInfo","params":{}}"#);
            return Some(probe.body(request).and_then(|body| parse_api(&body, now)));
        }

        if let Some(cookie) = probe.cookies(&["ampcode.com", "www.ampcode.com"], &["session"]) {
            let request = Request::get(SETTINGS_URL)
                .cookie(&cookie)
                .header(
                    "Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                )
                .header("Accept-Language", "en-US,en;q=0.9")
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
                )
                .header("Origin", "https://ampcode.com")
                .header("Referer", SETTINGS_URL);
            return Some(probe.body(request).and_then(|html| parse_html(&html, now)));
        }
        failure.map(Err)
    }
}

pub(crate) fn parse_api(body: &str, now: SystemTime) -> Result<Report> {
    let response: ApiResponse = json(body)?;
    if !response.ok {
        return Err(
            match response.error.and_then(|error| error.code).as_deref() {
                Some("auth-required") => Error::UsageRejected,
                _ => invalid(),
            },
        );
    }
    let text = response
        .result
        .map(|result| result.display_text)
        .filter(|text| !text.is_empty())
        .ok_or_else(invalid)?;
    parse_report(&text, now)
}

/// The usage report the CLI prints and the API returns, e.g.
///
/// ```text
/// Signed in as user@example.com (team)
/// Amp Megawatt Tier: agent usage $18.57 of $20 remaining (93%), orb usage 732.8h of 750h
///   a1.small orb hours remaining (98%) - period 2026-09-13 to 2026-10-13, resets upon renewal in 27 days
/// Amp Free: 61% remaining today (resets daily)
/// Individual credits: $20 remaining
/// Workspace Test Team: $7.25 remaining
/// ```
///
/// (each entry on one line).
pub(crate) fn parse_report(text: &str, now: SystemTime) -> Result<Report> {
    let text = strip_ansi(text).replace("**", "");
    let mut identity = None;
    let mut free = None;
    let mut subscription = None;
    let mut individual = None;
    let mut workspaces = Vec::new();
    for line in text.lines().map(str::trim) {
        if identity.is_none()
            && let Some(rest) = line.strip_prefix("Signed in as ")
        {
            identity = signed_in(rest);
        }
        if free.is_none()
            && let Some(rest) = line.strip_prefix("Amp Free:")
        {
            free = free_line(rest, now);
        }
        if subscription.is_none() {
            subscription = tier(line, now).or_else(|| legacy(line, now));
        }
        if individual.is_none()
            && let Some(rest) = line.strip_prefix("Individual credits:")
        {
            individual = remaining(rest);
        }
        if let Some(rest) = line.strip_prefix("Workspace ")
            && let Some((name, rest)) = rest.split_once(':')
            && let Some(amount) = remaining(rest)
            && !name.trim().is_empty()
        {
            workspaces.push((name.trim().to_owned(), amount));
        }
    }
    if identity.is_none() && looks_signed_out(&text) {
        return Err(Error::UsageRejected);
    }
    if free.is_none() && subscription.is_none() && individual.is_none() && workspaces.is_empty() {
        return Err(invalid());
    }

    let (email, organization) = identity.unwrap_or_default();
    let plan = match (&subscription, &free) {
        (Some(subscription), _) => subscription.plan.clone(),
        (None, Some(_)) => "Amp Free".into(),
        (None, None) => "Amp".into(),
    };
    let mut windows: Vec<Window> = free.into_iter().collect();
    let mut facts = Vec::new();
    if let Some(subscription) = subscription {
        windows.push(Window::new(
            Kind::Monthly,
            subscription.agent_used,
            Some(subscription.resets_at),
            subscription.length,
        ));
        if let Some(orb) = subscription.orb_used {
            windows.push(Window::new(
                Kind::Named("Orb usage".into()),
                orb,
                Some(subscription.resets_at),
                subscription.length,
            ));
        }
        if let Some(agent) = subscription.agent_remaining {
            facts.push(("Agent".to_owned(), format!("${agent:.2}")));
        }
        if let Some(hours) = subscription.orb_hours_remaining {
            let hours = if hours > 0. && hours < 1. {
                "< 1h".to_owned()
            } else {
                format!("{}h", hours.max(0.).floor())
            };
            facts.push(("Orb (a1.small hours)".to_owned(), hours));
        }
    }
    let usd = || Unit::Currency("USD".into());
    let balances = individual
        .map(|amount| Balance::new("Individual credits", amount, usd()))
        .into_iter()
        .chain(
            workspaces
                .into_iter()
                .map(|(name, amount)| Balance::new(format!("Workspace {name}"), amount, usd())),
        );
    let sections = [
        (!facts.is_empty()).then(|| Section::Facts {
            title: "Monthly allowances".into(),
            facts,
        }),
        organization.map(|organization| Section::Facts {
            title: "Account".into(),
            facts: vec![("Organization".into(), organization)],
        }),
    ];
    Ok(Report::new(
        Provider(&Amp),
        Account {
            email,
            plan: Some(plan),
        },
        windows,
    )
    .with_balances(balances)
    .with_sections(sections.into_iter().flatten()))
}

/// The legacy settings page embeds `freeTierUsage:{quota:…,used:…,…}`.
pub(crate) fn parse_html(html: &str, now: SystemTime) -> Result<Report> {
    let usage = ["freeTierUsage", "getFreeTierUsage"]
        .iter()
        .find_map(|token| {
            let object = object_after(html, token)?;
            Some((
                field(object, "quota")?,
                field(object, "used")?,
                field(object, "hourlyReplenishment")?,
                field(object, "windowHours"),
            ))
        });
    let Some((quota, used, hourly, window_hours)) = usage else {
        return Err(if looks_signed_out(html) {
            Error::UsageRejected
        } else {
            invalid()
        });
    };
    let free = dollar_free(quota, quota - used, hourly, window_hours, now);
    Ok(Report::new(
        Provider(&Amp),
        Account {
            email: None,
            plan: Some("Amp Free".into()),
        },
        vec![free],
    ))
}

struct Subscription {
    plan: String,
    agent_used: f64,
    orb_used: Option<f64>,
    resets_at: SystemTime,
    length: Option<Duration>,
    agent_remaining: Option<f64>,
    orb_hours_remaining: Option<f64>,
}

/// `user@example.com (team)`.
fn signed_in(rest: &str) -> Option<(Option<String>, Option<String>)> {
    let email: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '(')
        .collect();
    let organization = rest
        .split_once('(')
        .and_then(|(_, tail)| tail.split_once(')'))
        .map(|(inside, _)| inside.trim().to_owned())
        .filter(|inside| !inside.is_empty());
    (!email.is_empty()).then_some((Some(email), organization))
}

/// `$6/$10 remaining (replenishes +$0.5/hour)` or `61% remaining today`.
fn free_line(rest: &str, now: SystemTime) -> Option<Window> {
    if let Some((left, tail)) = dollars(rest)
        && let Some(tail) = tail.trim_start().strip_prefix('/')
        && let Some((quota, tail)) = dollars(tail)
        && let Some(tail) = tail.trim_start().strip_prefix("remaining")
    {
        let hourly = tail
            .trim_start()
            .strip_prefix("(replenishes")
            .and_then(|tail| tail.trim_start().strip_prefix('+'))
            .and_then(dollars)
            .filter(|(_, tail)| tail.trim_start().starts_with("/hour"))
            .map_or(0., |(hourly, _)| hourly);
        let hours = (hourly > 0.).then(|| (quota / hourly).round().max(1.));
        return Some(dollar_free(quota, left, hourly, hours, now));
    }
    let (left, tail) = amount(rest.trim_start())?;
    let tail = tail.trim_start().strip_prefix('%')?.trim_start();
    tail.starts_with("remaining").then(|| {
        Window::new(
            Kind::Daily,
            100. - left.clamp(0., 100.),
            next_free_reset(now),
            Some(DAY),
        )
    })
}

/// Dollar-based Amp Free refills hourly; it is full again once what was
/// spent has been replenished.
fn dollar_free(quota: f64, left: f64, hourly: f64, hours: Option<f64>, now: SystemTime) -> Window {
    let quota = quota.max(0.);
    let used = (quota - left).max(0.);
    let percent = if quota > 0. { used / quota * 100. } else { 0. };
    let full = (quota > 0. && hourly > 0.)
        .then(|| Duration::try_from_secs_f64(used / hourly * 3600.).ok())
        .flatten()
        .and_then(|wait| now.checked_add(wait));
    let length = hours
        .filter(|hours| *hours > 0.)
        .and_then(|hours| Duration::try_from_secs_f64(hours * 3600.).ok());
    Window::new(Kind::Named("Amp Free".into()), percent, full, length)
}

/// `Amp Megawatt Tier: agent usage $18.57 of $20 remaining …, resets upon
/// renewal in 27 days`; agent dollars are exact where the percentage is
/// rounded.
fn tier(line: &str, now: SystemTime) -> Option<Subscription> {
    let (plan, rest) = line.strip_prefix("Amp ")?.split_once(" Tier:")?;
    let rest = rest.trim_start().strip_prefix("agent usage")?;
    let (remaining, rest) = dollars(rest)?;
    let (limit, rest) = dollars(rest.trim_start().strip_prefix("of")?)?;
    let rest = rest.trim_start().strip_prefix("remaining")?;
    if limit <= 0. {
        return None;
    }
    let (middle, renewal) = rest.split_once("resets upon renewal in ")?;
    let period = period(middle);
    let resets_at = match period {
        Some((_, end)) => end,
        None => renewal_date(renewal, now)?,
    };
    let orb = middle.find("orb usage ").and_then(|at| {
        let rest = &middle[at + "orb usage ".len()..];
        let (left, rest) = amount(rest)?;
        let rest = rest.strip_prefix('h')?.trim_start().strip_prefix("of")?;
        let (total, rest) = amount(rest.trim_start())?;
        let rest = rest.strip_prefix('h')?.trim_start();
        (rest.starts_with("a1.small orb hours remaining") && total > 0.).then_some((left, total))
    });
    Some(Subscription {
        plan: plan.trim().to_owned(),
        agent_used: ((limit - remaining) / limit * 100.).clamp(0., 100.),
        orb_used: orb.map(|(left, total)| ((total - left) / total * 100.).clamp(0., 100.)),
        resets_at,
        length: period.and_then(|(start, end)| end.duration_since(start).ok()),
        agent_remaining: Some(remaining),
        orb_hours_remaining: orb.map(|(left, _)| left),
    })
}

/// `Amp Megawatt Subscription: 68% other usage and 97% orb usage remaining -
/// resets upon renewal in 5 days`, or `Subscription Megawatt: …`.
fn legacy(line: &str, now: SystemTime) -> Option<Subscription> {
    let (plan, rest) = match line.strip_prefix("Subscription ") {
        Some(rest) => rest.split_once(':')?,
        None => line.strip_prefix("Amp ")?.split_once(" Subscription:")?,
    };
    let (other, rest) = amount(rest.trim_start())?;
    let rest = rest
        .trim_start()
        .strip_prefix('%')?
        .trim_start()
        .strip_prefix("other usage and")?;
    let (orb, rest) = amount(rest.trim_start())?;
    let rest = rest
        .trim_start()
        .strip_prefix('%')?
        .trim_start()
        .strip_prefix("orb usage remaining")?
        .trim_start()
        .strip_prefix('-')?
        .trim_start()
        .strip_prefix("resets upon renewal in ")?;
    let plan = plan.trim();
    if plan.is_empty() {
        return None;
    }
    Some(Subscription {
        plan: plan.to_owned(),
        agent_used: 100. - other.clamp(0., 100.),
        orb_used: Some(100. - orb.clamp(0., 100.)),
        resets_at: renewal_date(rest, now)?,
        length: Some(MONTH),
        agent_remaining: None,
        orb_hours_remaining: None,
    })
}

/// `period 2026-09-13 to 2026-10-13`, as UTC days: the CLI gives dates only.
fn period(text: &str) -> Option<(SystemTime, SystemTime)> {
    let rest = &text[text.find("period ")? + "period ".len()..];
    let day = |text: &str| {
        let date = NaiveDate::parse_from_str(text.get(..10)?, "%Y-%m-%d").ok()?;
        Some(SystemTime::from(date.and_hms_opt(0, 0, 0)?.and_utc()))
    };
    let start = day(rest)?;
    let end = day(rest
        .get(10..)?
        .trim_start()
        .strip_prefix("to")?
        .trim_start())?;
    (end > start).then_some((start, end))
}

/// `27 days` or `1 month` from now.
fn renewal_date(text: &str, now: SystemTime) -> Option<SystemTime> {
    let (count, unit) = amount(text.trim_start())?;
    let count = u32::try_from(count as u64).ok()?;
    let unit = unit.trim_start();
    if unit.starts_with("month") {
        let at = chrono::DateTime::<Utc>::from(now).checked_add_months(Months::new(count))?;
        Some(at.into())
    } else if unit.starts_with("day") {
        now.checked_add(Duration::from_secs(u64::from(count) * 86_400))
    } else {
        None
    }
}

/// Amp Free resets daily at 8:00 PM in New York.
fn next_free_reset(now: SystemTime) -> Option<SystemTime> {
    let today = chrono::DateTime::<Utc>::from(now).date_naive();
    (-1..=2)
        .filter_map(|offset| {
            let day = today.checked_add_signed(chrono::TimeDelta::days(offset))?;
            let local = day.and_hms_opt(20, 0, 0)?;
            let utc =
                Utc.from_utc_datetime(&local) - chrono::TimeDelta::hours(new_york_offset(day));
            Some(SystemTime::from(utc))
        })
        .filter(|reset| *reset > now)
        .min()
}

/// Hours New York is behind UTC on `day`: daylight time runs from the second
/// Sunday of March to the first Sunday of November.
fn new_york_offset(day: NaiveDate) -> i64 {
    let year = day.year();
    let start = NaiveDate::from_weekday_of_month_opt(year, 3, Weekday::Sun, 2);
    let end = NaiveDate::from_weekday_of_month_opt(year, 11, Weekday::Sun, 1);
    match (start, end) {
        (Some(start), Some(end)) if day >= start && day < end => -4,
        _ => -5,
    }
}

/// `$20 remaining`.
fn remaining(text: &str) -> Option<f64> {
    let (amount, rest) = dollars(text)?;
    rest.trim_start().starts_with("remaining").then_some(amount)
}

fn dollars(text: &str) -> Option<(f64, &str)> {
    let text = text.trim_start();
    amount(text.strip_prefix('$').unwrap_or(text))
}

/// `1,000` or `18.57`, and what follows it.
fn amount(text: &str) -> Option<(f64, &str)> {
    let bytes = text.as_bytes();
    if !bytes.first()?.is_ascii_digit() {
        return None;
    }
    let mut end = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_digit() || **byte == b',')
        .count();
    if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 1 + bytes[end + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
    }
    let value = text[..end].replace(',', "").parse().ok()?;
    Some((value, &text[end..]))
}

/// The balanced `{…}` after `token`, skipping braces inside strings.
fn object_after<'a>(text: &'a str, token: &str) -> Option<&'a str> {
    let start = text.find(token)? + token.len();
    let open = start + text[start..].find('{')?;
    let (mut depth, mut in_string, mut escaped) = (0_usize, false, false);
    for (index, c) in text[open..].char_indices() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&text[open..=open + index]);
                }
            }
            _ => {}
        }
    }
    None
}

/// `key:12.5` or `"key":12.5` inside a JavaScript object literal.
fn field(object: &str, key: &str) -> Option<f64> {
    object.match_indices(key).find_map(|(at, _)| {
        let before = object[..at].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            return None;
        }
        let after = &object[at + key.len()..];
        let rest = after.strip_prefix('"').unwrap_or(after);
        let rest = rest.trim_start().strip_prefix(':')?;
        amount(rest.trim_start()).map(|(value, _)| value)
    })
}

fn looks_signed_out(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["sign in", "log in", "login"]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.next_if_eq(&'[').is_some() {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct ApiResponse {
    ok: bool,
    result: Option<ApiResult>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiResult {
    #[serde(rename = "displayText")]
    display_text: String,
}

#[derive(Deserialize)]
struct ApiError {
    code: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(text: &str) -> SystemTime {
        chrono::DateTime::parse_from_rfc3339(text)
            .unwrap()
            .to_utc()
            .into()
    }

    #[test]
    fn reads_a_tier_with_orb_hours_and_credits() {
        let now = at("2026-09-16T12:00:00Z");
        let text = concat!(
            "Signed in as user@example.com\n",
            "Amp Megawatt Tier: agent usage $18.57 of $20 remaining (93%), ",
            "orb usage 732.8h of 750h a1.small orb hours remaining (98%) - ",
            "period 2026-09-13 to 2026-10-13, resets upon renewal in 27 days\n",
            "Individual credits: $20 remaining (replenishes automatically) - https://ampcode.com/settings\n",
        );
        let body = serde_json::json!({"ok": true, "result": {"displayText": text}}).to_string();
        let report = parse_api(&body, now).unwrap();
        assert_eq!(report.account.email.as_deref(), Some("user@example.com"));
        assert_eq!(report.account.plan.as_deref(), Some("Megawatt"));
        let agent = &report.windows[0];
        assert_eq!(agent.kind, Kind::Monthly);
        assert!((agent.used - 7.15).abs() < 1e-3);
        assert_eq!(agent.resets_at, Some(at("2026-10-13T00:00:00Z")));
        assert_eq!(agent.length, Some(Duration::from_secs(30 * 86_400)));
        let orb = &report.windows[1];
        assert_eq!(orb.kind, Kind::Named("Orb usage".into()));
        assert!((orb.used - 2.2933).abs() < 1e-3);
        assert_eq!(
            report.balances,
            vec![Balance::new(
                "Individual credits",
                20.,
                Unit::Currency("USD".into())
            )]
        );
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Monthly allowances".into(),
                facts: vec![
                    ("Agent".into(), "$18.57".into()),
                    ("Orb (a1.small hours)".into(), "732h".into()),
                ],
            }]
        );
    }

    #[test]
    fn reads_dollar_free_usage_and_workspaces() {
        let now = at("2026-09-16T12:00:00Z");
        let text = "\x1b[2mSigned in as ampcode@example.net (echo)\x1b[0m\n\
                    Amp Free: $4.71/$10 remaining (replenishes +$0.42/hour) - https://ampcode.com/settings#amp-free\n\
                    Individual credits: $25.64 remaining (set up automatic top-up to avoid running out)\n\
                    Workspace meow: $10.22 remaining (set up automatic top-up to avoid running out)\n";
        let report = parse_report(text, now).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Amp Free"));
        let free = &report.windows[0];
        assert_eq!(free.kind, Kind::Named("Amp Free".into()));
        assert!((free.used - 52.9).abs() < 1e-3);
        assert_eq!(free.length, Some(Duration::from_secs(24 * 3600)));
        let wait = free.resets_at.unwrap().duration_since(now).unwrap();
        assert!((wait.as_secs_f64() - 5.29 / 0.42 * 3600.).abs() < 1.);
        assert_eq!(report.balances.len(), 2);
        assert_eq!(report.balances[1].label, "Workspace meow");
        assert!((report.balances[1].amount - 10.22).abs() < 1e-9);
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Account".into(),
                facts: vec![("Organization".into(), "echo".into())],
            }]
        );
    }

    #[test]
    fn reads_daily_free_usage_and_a_legacy_subscription() {
        let now = at("2026-09-16T12:00:00Z");
        let text = "Signed in as you@example.com (name)\n\
                    **Amp Free:** 0% remaining today (resets daily) - https://ampcode.com/settings\n\
                    **Amp Megawatt Subscription:** 68% other usage and 97% orb usage remaining - resets upon renewal in 5 days\n\
                    **Individual credits:** $3.23 remaining (set up auto-reload to avoid running out)\n";
        let report = parse_report(text, now).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Megawatt"));
        let free = &report.windows[0];
        assert_eq!(free.kind, Kind::Daily);
        assert_eq!(free.percent(), 100);
        // 8:00 PM EDT on 2026-09-16 is midnight UTC.
        assert_eq!(free.resets_at, Some(at("2026-09-17T00:00:00Z")));
        assert_eq!(report.windows[1].kind, Kind::Monthly);
        assert_eq!(report.windows[1].percent(), 32);
        assert_eq!(
            report.windows[1].resets_at,
            Some(at("2026-09-21T12:00:00Z"))
        );
        assert_eq!(report.windows[2].percent(), 3);
    }

    #[test]
    fn free_resets_at_8pm_new_york_in_winter() {
        let reset = next_free_reset(at("2026-12-01T12:00:00Z")).unwrap();
        assert_eq!(reset, at("2026-12-02T01:00:00Z"));
    }

    #[test]
    fn an_empty_tier_keeps_the_credits() {
        let text = "Amp Megawatt Tier: agent usage $0 of $0 remaining - resets upon renewal in 27 days\n\
                    Individual credits: $12 remaining\n";
        let report = parse_report(text, SystemTime::now()).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("Amp"));
        assert_eq!(report.balances[0].amount, 12.);
    }

    #[test]
    fn maps_sign_in_failures() {
        assert!(matches!(
            parse_report("Please log in with `amp login`", SystemTime::now()),
            Err(Error::UsageRejected)
        ));
        assert!(matches!(
            parse_api(
                r#"{"ok":false,"error":{"code":"auth-required"}}"#,
                SystemTime::now()
            ),
            Err(Error::UsageRejected)
        ));
    }

    #[test]
    fn reads_the_settings_page_free_tier() {
        let now = at("2026-09-16T12:00:00Z");
        let html = r#"<script>window.__data={user:{},freeTierUsage:{bucket:"ubi",quota:1000,hourlyReplenishment:42,windowHours:24,used:338.5}};</script>"#;
        let report = parse_html(html, now).unwrap();
        let free = &report.windows[0];
        assert!((free.used - 33.85).abs() < 1e-3);
        assert_eq!(free.length, Some(Duration::from_secs(24 * 3600)));
        assert!(matches!(
            parse_html("<a href=\"/login\">Log in</a>", now),
            Err(Error::UsageRejected)
        ));
    }
}
