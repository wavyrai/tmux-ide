//! Kiro plan credits, read by running the Kiro CLI's own report,
//! `kiro-cli chat --no-interactive "/usage"`, with its AWS Builder ID
//! sign-in, as CodexBar does. `kiro-cli whoami` adds the account email. The
//! provider is found through the CLI's state database (`data.sqlite3` in
//! `~/Library/Application Support/kiro-cli`, `$XDG_DATA_HOME/kiro-cli`, or
//! `$KIRO_DATA_DIR`), which only shows the CLI has been set up.
//!
//! Not ported: CodexBar's `GetUsageLimits` enrichment, which reads the CLI's
//! token and profile out of that SQLite database to add the overage cap,
//! and its pseudo-terminal fallback for Kiro CLI releases that print nothing
//! through pipes; the `/context` window breakdown is left out too.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{HostPath, Probe},
        service::{Meta, Service},
        values::plain,
    },
};
use chrono::{Datelike, NaiveDate, TimeZone};
use std::time::{Duration, SystemTime};

const CLI: &str = "kiro-cli";

pub(crate) struct Kiro;

static META: Meta = Meta::new("kiro", "Kiro")
    .dashboard("https://app.kiro.dev/account/usage")
    .status_page("https://health.aws.amazon.com/health/status");

impl Service for Kiro {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let databases = if probe.is_macos() {
            vec![HostPath::env_or(
                "KIRO_DATA_DIR",
                "Library/Application Support/kiro-cli",
                "data.sqlite3",
            )]
        } else {
            vec![
                HostPath::env_or("KIRO_DATA_DIR", ".local/share/kiro-cli", "data.sqlite3"),
                HostPath::env_or("XDG_DATA_HOME", ".local/share", "kiro-cli/data.sqlite3"),
            ]
        };
        if !databases.iter().any(|path| probe.exists(path)) {
            return None;
        }
        let usage = match probe.command(
            CLI,
            &["chat", "--no-interactive", "/usage"],
            Duration::from_secs(20),
        ) {
            Ok(output) => output.stdout,
            Err(error) => return Some(Err(error)),
        };
        let email = probe
            .command(CLI, &["whoami"], Duration::from_secs(5))
            .ok()
            .and_then(|output| whoami_email(&output.stdout));
        Some(parse(&usage, email, SystemTime::now()))
    }
}

pub(crate) fn parse(output: &str, email: Option<String>, now: SystemTime) -> Result<Report> {
    let text = strip_ansi(output);
    let lower = text.to_lowercase();
    if text.trim().is_empty() || lower.contains("could not retrieve usage information") {
        return Err(Error::UsageCommand("kiro-cli /usage"));
    }
    if [
        "not logged in",
        "login required",
        "failed to initialize auth portal",
        "kiro-cli login",
        "oauth error",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return Err(Error::UsageRejected);
    }

    let plan = plan(&text);
    let managed = lower.contains("managed by admin") || lower.contains("managed by organization");
    let percent = bar_percent(&text);
    let credits = covered(&text);
    let has_metrics = percent.is_some() || credits.is_some();
    if !has_metrics && !(plan.new_format && (managed || plan.summary)) {
        return Err(Error::UsageCommand("kiro-cli /usage"));
    }

    let mut windows = Vec::new();
    let mut balances = Vec::new();
    if has_metrics {
        let (used, total) = credits.unwrap_or((0., 50.));
        let percent = percent.unwrap_or(if total > 0. { used / total * 100. } else { 0. });
        windows.push(Window::new(
            Kind::Monthly,
            percent,
            reset_date(&text, now),
            Some(MONTH),
        ));
        if credits.is_some() {
            balances.push(
                Balance::new(
                    "Credits left",
                    (total - used).max(0.),
                    Unit::Count("credits".into()),
                )
                .out_of(total),
            );
        }
    }
    if let Some((used, total)) = bonus(&text).filter(|(_, total)| *total > 0.) {
        let expires = after(&text, "expires in ")
            .and_then(leading_number)
            .map(|(days, _)| now + Duration::from_secs((days.max(0.) as u64) * 86_400));
        windows.push(Window::new(
            Kind::Named("Bonus credits".into()),
            used / total * 100.,
            expires,
            None,
        ));
    }

    let mut facts = Vec::new();
    if let Some(status) = after(&text, "Overages:").map(|rest| line(rest).trim().to_owned())
        && !status.is_empty()
    {
        facts.push(("Overages".to_owned(), status));
    }
    if let Some((used, _)) =
        after(&text, "Credits used:").and_then(|rest| leading_number(rest.trim_start()))
    {
        facts.push(("Overage credits used".to_owned(), plain(used)));
    }
    if let Some((cost, rest)) = after(&text, "Est. cost:").and_then(|rest| {
        let rest = rest.trim_start();
        leading_number(rest.strip_prefix('$').unwrap_or(rest))
    }) && rest.trim_start().starts_with("USD")
    {
        facts.push(("Estimated overage cost".to_owned(), format!("${cost:.2}")));
    }

    Ok(Report::new(
        Provider(&Kiro),
        Account {
            email,
            plan: Some(display_plan(&plan.name)),
        },
        windows,
    )
    .with_balances(balances)
    .with_sections((!facts.is_empty()).then(|| Section::Facts {
        title: "Overages".into(),
        facts,
    })))
}

struct Plan {
    name: String,
    /// `Plan: …` lines, which kiro-cli 1.24 and later print.
    new_format: bool,
    /// `Plan: KIRO PRO MAX | 1 usage breakdowns`, which states no metrics.
    summary: bool,
}

fn plan(text: &str) -> Plan {
    for raw in text.lines() {
        let Some(rest) = raw.trim().strip_prefix("Plan:") else {
            continue;
        };
        if let Some((name, tail)) = rest.split_once('|') {
            let tail = tail.trim();
            let count = tail.trim_start_matches(|c: char| c.is_ascii_digit());
            let summary = count.len() < tail.len()
                && matches!(count.trim(), "usage breakdown" | "usage breakdowns");
            if summary && !name.trim().is_empty() {
                return Plan {
                    name: name.trim().to_owned(),
                    new_format: true,
                    summary: true,
                };
            }
        }
    }

    let mut name = "Kiro".to_owned();
    let mut new_format = false;
    // The legacy box puts `| KIRO FREE` in its header.
    for (at, _) in text.match_indices('|') {
        let rest = text[at + 1..].trim_start_matches([' ', '\t']);
        if let Some(tier) = rest.strip_prefix("KIRO")
            && tier.starts_with([' ', '\t'])
        {
            let word: String = tier
                .trim_start_matches([' ', '\t'])
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !word.is_empty() {
                name = format!("KIRO {word}");
                break;
            }
        }
    }
    // kiro-cli 2.x: `Estimated Usage | resets on 2026-06-01 | KIRO FREE`.
    if let Some(line) = text.lines().find(|line| line.contains("Estimated Usage"))
        && line.matches('|').count() >= 2
        && let Some(last) = line.rsplit('|').next().map(str::trim)
        && last.starts_with(|c: char| c.is_ascii_uppercase())
    {
        name = last.to_owned();
    }
    if let Some(rest) = after(text, "Plan:") {
        let first = line(rest).trim();
        if !first.is_empty() {
            name = first.to_owned();
            new_format = true;
        }
    }
    Plan {
        name,
        new_format,
        summary: false,
    }
}

/// `KIRO PRO MAX` reads as `Kiro Pro Max`; other names stay as printed.
fn display_plan(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    if !words.iter().any(|word| word.eq_ignore_ascii_case("kiro")) {
        return words.join(" ");
    }
    words
        .iter()
        .map(|word| {
            let lower = word.to_lowercase();
            let mut chars = lower.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `████ 25%`: the percentage after the meter.
fn bar_percent(text: &str) -> Option<f64> {
    text.match_indices('█').find_map(|(at, _)| {
        let rest = text[at..].trim_start_matches('█').trim_start();
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        (!digits.is_empty() && rest[digits.len()..].starts_with('%'))
            .then(|| digits.parse().ok())
            .flatten()
    })
}

/// `(12.50 of 50 covered in plan)`: credits used and the plan's credits.
fn covered(text: &str) -> Option<(f64, f64)> {
    text.match_indices('(').find_map(|(at, _)| {
        let (used, rest) = leading_number(&text[at + 1..])?;
        let rest = rest.trim_start().strip_prefix("of")?;
        let (total, rest) = leading_number(rest.trim_start())?;
        rest.trim_start()
            .starts_with("covered")
            .then_some((used, total))
    })
}

/// `Bonus credits: 0.00/100 credits used`.
fn bonus(text: &str) -> Option<(f64, f64)> {
    let rest = after(text, "Bonus credits:")?.trim_start();
    let (used, rest) = leading_number(rest)?;
    let (total, _) = leading_number(rest.strip_prefix('/')?)?;
    Some((used, total))
}

/// `resets on 2026-06-01`, or `resets on 01/01` in the current or next year.
fn reset_date(text: &str, now: SystemTime) -> Option<SystemTime> {
    let rest = after(text, "resets on ")?;
    let date = rest
        .get(..10)
        .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
        .or_else(|| {
            let (month, rest) = rest.get(..5)?.split_once('/')?;
            let (month, day) = (month.parse().ok()?, rest.parse().ok()?);
            let today = chrono::DateTime::<chrono::Local>::from(now).date_naive();
            NaiveDate::from_ymd_opt(today.year(), month, day)
                .filter(|date| *date > today)
                .or_else(|| NaiveDate::from_ymd_opt(today.year() + 1, month, day))
        })?;
    let midnight = chrono::Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()?;
    Some(midnight.into())
}

fn whoami_email(output: &str) -> Option<String> {
    let text = strip_ansi(output);
    text.lines().map(str::trim).find_map(|line| {
        let lower = line.to_lowercase();
        match lower.find("email:") {
            Some(at) => line
                .get(at + "email:".len()..)
                .map(|rest| rest.trim().to_owned()),
            None => (!line.contains(' ') && line.contains('@')).then(|| line.to_owned()),
        }
        .filter(|email| !email.is_empty())
    })
}

fn after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    text.find(marker).map(|at| &text[at + marker.len()..])
}

fn line(text: &str) -> &str {
    text.split(['\n', '\r']).next().unwrap_or_default()
}

/// A leading `12` or `12.50`, and what follows it.
fn leading_number(text: &str) -> Option<(f64, &str)> {
    let whole = text.bytes().take_while(u8::is_ascii_digit).count();
    if whole == 0 {
        return None;
    }
    let mut end = whole;
    if text[end..].starts_with('.') {
        end += 1 + text[end + 1..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
    }
    Some((
        text[..end].trim_end_matches('.').parse().ok()?,
        &text[end..],
    ))
}

/// The CLI decorates its report; escape sequences go before parsing.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\x07' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn now() -> SystemTime {
        // 2026-05-15T12:00:00Z
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_778_846_400)
    }

    #[test]
    fn reads_the_kiro_cli_2_report() {
        let output = "\x1b[1mEstimated Usage | resets on 2026-06-01 | KIRO FREE\x1b[0m\n\
                      Credits (12.50 of 50 covered in plan)\n\
                      ████████████████████ 25%\n";
        let report = parse(output, Some("person@example.com".into()), now()).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Kiro Free"));
        assert_eq!(report.account.email.as_deref(), Some("person@example.com"));
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert_eq!(window.percent(), 25);
        assert!(window.resets_at.is_some());
        assert_eq!(
            report.balances,
            vec![Balance::new("Credits left", 37.5, Unit::Count("credits".into())).out_of(50.)]
        );
    }

    #[test]
    fn reads_bonus_credits_and_overage_status() {
        // CodexBar's kiro-cli 2 fixture.
        let output = concat!(
            "\x1b[1mEstimated Usage\x1b[0m | resets on 2026-06-01 | \x1b[mKIRO FREE\x1b[0m\n\n",
            "🎁 Bonus credits: 45.53/2000 credits used, expires in 19 days\n\n",
            "\x1b[1mCredits\x1b[0m (0.17 of 50 covered in plan)\n",
            "████████████████████████████████████████ 0%\n\n",
            "Overages: \x1b[1mDisabled\x1b[0m\n\n",
            "To manage your plan or configure overages navigate to ",
            "https://app.kiro.dev/account/usage\n",
        );
        let report = parse(output, None, now()).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Kiro Free"));
        assert_eq!(report.windows[0].percent(), 0);
        let bonus = &report.windows[1];
        assert_eq!(bonus.kind, Kind::Named("Bonus credits".into()));
        assert_eq!(bonus.percent(), 2);
        assert_eq!(
            bonus.resets_at,
            Some(now() + Duration::from_secs(19 * 86_400))
        );
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Overages".into(),
                facts: vec![("Overages".into(), "Disabled".into())],
            }]
        );
    }

    #[test]
    fn a_month_and_day_reset_is_the_next_one() {
        let reset = reset_date("100% (resets on 01/01)", now()).unwrap();
        let date = chrono::DateTime::<chrono::Local>::from(reset).date_naive();
        assert_eq!(date, NaiveDate::from_ymd_opt(2027, 1, 1).unwrap());
    }

    #[test]
    fn keeps_a_plan_only_summary() {
        let report = parse("Plan: KIRO PRO MAX | 1 usage breakdowns\n", None, now()).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Kiro Pro Max"));
        assert!(report.windows.is_empty());
        assert!(report.balances.is_empty());
    }

    #[test]
    fn reads_overage_details_and_new_plan_names() {
        let output = "Plan: Q Developer Pro\n\
                      ██████ 40%\n\
                      Overages: Enabled\n\
                      Credits used: 12.5\n\
                      Est. cost: $0.50 USD\n";
        let report = parse(output, None, now()).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Q Developer Pro"));
        assert_eq!(report.windows[0].percent(), 40);
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Overages".into(),
                facts: vec![
                    ("Overages".into(), "Enabled".into()),
                    ("Overage credits used".into(), "12.50".into()),
                    ("Estimated overage cost".into(), "$0.50".into()),
                ],
            }]
        );
    }

    #[test]
    fn maps_sign_in_and_format_failures() {
        assert!(matches!(
            parse("Not logged in. Run kiro-cli login", None, now()),
            Err(Error::UsageRejected)
        ));
        assert!(matches!(
            parse("Welcome to Kiro", None, now()),
            Err(Error::UsageCommand(_))
        ));
    }

    #[test]
    fn reads_the_whoami_email() {
        assert_eq!(
            whoami_email("Logged in with Google\nEmail: person@example.com\n").as_deref(),
            Some("person@example.com")
        );
        assert_eq!(whoami_email("Logged in with Builder ID\n"), None);
    }
}
