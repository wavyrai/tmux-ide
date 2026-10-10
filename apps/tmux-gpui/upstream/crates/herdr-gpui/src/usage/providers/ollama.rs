//! Ollama Cloud usage. Two sign-ins are read, in CodexBar's order:
//!
//! - An ollama.com browser session (the `cookie` setting, or Chrome/Safari
//!   when Ollama is listed in `show_providers`). The Plan & Billing page at
//!   `ollama.com/settings` is the only place Ollama shows quota, so its HTML
//!   is read for the plan, the account email, the monthly included-credit
//!   usage, and the session/hourly and weekly windows older pages showed.
//! - An API key (the `api_key` setting, or `OLLAMA_API_KEY` / `OLLAMA_KEY`),
//!   used when no session is found or the session fails. Ollama's API has no
//!   quota, so the key is only verified and the cloud model catalog counted.
//!
//! Everything CodexBar reads is ported; the page is read by plain text
//! search where CodexBar uses regular expressions.

use crate::{
    Error, Result,
    usage::{
        model::{
            Account, Kind, MONTH, Provider, Report, SESSION, Section, WEEK, Window, title_case,
        },
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const SETTINGS_URL: &str = "https://ollama.com/settings";
const SEARCH_URL: &str = "https://ollama.com/api/web_search";
const TAGS_URL: &str = "https://ollama.com/api/tags";
const BROWSER: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                       (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
/// Current WorkOS, legacy Ollama, and NextAuth session cookies, with the
/// first chunks NextAuth splits a long session into.
const SESSION_COOKIES: &[&str] = &[
    "wos-session",
    "session",
    "__Secure-session",
    "ollama_session",
    "__Host-ollama_session",
    "__Secure-next-auth.session-token",
    "__Secure-next-auth.session-token.0",
    "__Secure-next-auth.session-token.1",
    "next-auth.session-token",
    "next-auth.session-token.0",
    "next-auth.session-token.1",
];
const MONTHLY: &str = "Monthly usage";
const SESSION_LABEL: &str = "Session usage";
const HOURLY_LABEL: &str = "Hourly usage";
const WEEKLY: &str = "Weekly usage";
const LABELS: &[&str] = &[MONTHLY, SESSION_LABEL, HOURLY_LABEL, WEEKLY];
/// How far past its label a usage block is read when no other label ends it.
const BLOCK: usize = 4000;

pub(crate) struct Ollama;

static META: Meta = Meta::new("ollama", "Ollama")
    .dashboard("https://ollama.com/settings")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "The ollama.com browser session, needed for quota. Sign in at \
             https://ollama.com/signin, open Developer Tools → Application → Cookies → \
             https://ollama.com, copy the session cookie (wos-session, or __Secure-session \
             on older sign-ins), and paste it as \"name=value\".",
        ),
        Setting::new(
            "api_key",
            &["OLLAMA_API_KEY", "OLLAMA_KEY"],
            "An Ollama API key from https://ollama.com/settings/keys. It only verifies \
             access: Ollama shows quota on its website, not through the API.",
        ),
    ]);

impl Service for Ollama {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let session = probe
            .cookies(&["ollama.com", "www.ollama.com"], SESSION_COOKIES)
            .map(|cookie| web(probe, &cookie));
        if let Some(Ok(_)) = &session {
            return session;
        }
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("OLLAMA_API_KEY"))
            .or_else(|| probe.env("OLLAMA_KEY"));
        match key {
            Some(key) => Some(api(probe, &key)),
            None => session,
        }
    }
}

fn web(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let request = Request::get(SETTINGS_URL)
        .cookie(cookie)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Origin", "https://ollama.com")
        .header("Referer", SETTINGS_URL)
        .header("User-Agent", BROWSER);
    let response = probe.http(request)?;
    // An expired session is redirected to the sign-in page.
    if (300..400).contains(&response.status) {
        return Err(Error::UsageRejected);
    }
    parse(&response.ok()?)
}

fn api(probe: &mut Probe, key: &Secret) -> Result<Report> {
    // An empty search is refused with 400 without searching, which still
    // proves the key; the catalog alone is public and proves nothing.
    let check = Request::post(SEARCH_URL)
        .bearer(key)
        .header("Accept", "application/json")
        .json(r#"{"query":""}"#);
    let response = probe.http(check)?;
    if response.status != 400 {
        response.ok()?;
    }
    let tags = Request::get(TAGS_URL)
        .bearer(key)
        .header("Accept", "application/json");
    parse_tags(&probe.body(tags)?)
}

pub(crate) fn parse_tags(body: &str) -> Result<Report> {
    let tags: Tags = json(body)?;
    Ok(Report::new(
        Provider(&Ollama),
        Account {
            email: None,
            plan: Some("API key".into()),
        },
        Vec::new(),
    )
    .with_sections([Section::Facts {
        title: "Ollama Cloud".into(),
        facts: vec![("Models".into(), tags.models.len().to_string())],
    }]))
}

#[derive(Deserialize)]
struct Tags {
    models: Vec<serde::de::IgnoredAny>,
}

/// The Plan & Billing page. Monthly usage is included dollar credits turned
/// into a share of the plan, not spend.
pub(crate) fn parse(html: &str) -> Result<Report> {
    let monthly = block(html, MONTHLY);
    let session = block(html, SESSION_LABEL)
        .map(|block| (block, Kind::Session, SESSION))
        .or_else(|| {
            block(html, HOURLY_LABEL).map(|block| {
                (
                    block,
                    Kind::Named("Hourly".into()),
                    Duration::from_secs(3600),
                )
            })
        });
    let weekly = block(html, WEEKLY);
    if monthly.is_none() && session.is_none() && weekly.is_none() {
        return Err(if signed_out(html) {
            Error::UsageRejected
        } else {
            invalid()
        });
    }
    let windows = [
        monthly.map(|block| (block, Kind::Monthly, MONTH)),
        session,
        weekly.map(|block| (block, Kind::Weekly, WEEK)),
    ]
    .into_iter()
    .flatten()
    .map(|((used, resets_at), kind, length)| Window::new(kind, used, resets_at, Some(length)))
    .collect();
    let account = Account {
        email: email(html),
        plan: plan(html).map(|plan| title_case(&plan)),
    };
    Ok(Report::new(Provider(&Ollama), account, windows))
}

/// The share used and reset time of the block after `label`, which ends at
/// the next usage label or after [`BLOCK`] bytes.
fn block(html: &str, label: &str) -> Option<(f64, Option<SystemTime>)> {
    let start = html.find(label)? + label.len();
    let tail = &html[start..];
    let end = LABELS
        .iter()
        .filter(|other| **other != label)
        .filter_map(|other| tail.find(other))
        .min()
        .unwrap_or(tail.len())
        .min(floor(tail, BLOCK));
    let text = &tail[..end];
    let used = percent_used(text)
        .or_else(|| dollars_used(text))
        .or_else(|| meter_width(text))?;
    Some((used, data_time(text)))
}

/// The largest char boundary of `text` at or below `at`.
fn floor(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The number ending just before `end`: digits with an optional fraction.
fn number_before(text: &str, end: usize) -> Option<f64> {
    let head = text[..end].trim_end();
    let start = head
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map_or(0, |index| index + 1);
    let digits = &head[start..];
    if digits.starts_with('.') || digits.ends_with('.') {
        return None;
    }
    digits.parse().ok()
}

/// The length of the number at the start of `text`: digits with an
/// optional fraction.
fn number_len(text: &str) -> usize {
    let whole = text.bytes().take_while(u8::is_ascii_digit).count();
    let rest = &text.as_bytes()[whole..];
    match rest {
        [b'.', next, ..] if whole > 0 && next.is_ascii_digit() => {
            whole + 1 + rest[1..].iter().take_while(|b| b.is_ascii_digit()).count()
        }
        _ => whole,
    }
}

/// `12.5% used`, in any case.
fn percent_used(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    lower.match_indices('%').find_map(|(index, _)| {
        lower[index + 1..]
            .trim_start()
            .starts_with("used")
            .then(|| number_before(&lower, index))
            .flatten()
    })
}

/// `$7.50 of $60 used` as the share of the included credits used.
fn dollars_used(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    lower.match_indices('$').find_map(|(index, _)| {
        let (used, rest) = amount(&lower[index + 1..])?;
        let rest = spaced(rest)?.strip_prefix("of")?;
        let (limit, rest) = amount(spaced(rest)?.strip_prefix('$')?)?;
        spaced(rest)?.starts_with("used").then_some(())?;
        (limit > 0.).then(|| used / limit * 100.)
    })
}

/// At least one whitespace character, skipped.
fn spaced(text: &str) -> Option<&str> {
    let rest = text.trim_start();
    (rest.len() < text.len()).then_some(rest)
}

/// `1,250.50` or `60` at the start of `text`, and what follows it. Commas
/// must group thousands exactly.
fn amount(text: &str) -> Option<(f64, &str)> {
    let bytes = text.as_bytes();
    let lead = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if lead == 0 {
        return None;
    }
    let mut end = lead;
    if lead <= 3 {
        let mut grouped = lead;
        while bytes.get(grouped) == Some(&b',')
            && bytes.len() >= grouped + 4
            && bytes[grouped + 1..grouped + 4]
                .iter()
                .all(u8::is_ascii_digit)
            && !bytes.get(grouped + 4).is_some_and(u8::is_ascii_digit)
        {
            grouped += 4;
        }
        end = grouped;
    }
    if bytes.get(end) == Some(&b'.') {
        let fraction = bytes[end + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    let value: f64 = text[..end].replace(',', "").parse().ok()?;
    value.is_finite().then_some((value, &text[end..]))
}

/// `width: 12.5%` of the usage meter.
fn meter_width(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("width:").find_map(|(index, key)| {
        let rest = lower[index + key.len()..].trim_start();
        let len = number_len(rest);
        (len > 0 && rest[len..].starts_with('%'))
            .then(|| rest[..len].parse().ok())
            .flatten()
    })
}

/// The reset time a `local-time` element carries in `data-time`.
fn data_time(text: &str) -> Option<SystemTime> {
    let start = text.find("data-time=\"")? + "data-time=\"".len();
    let raw = &text[start..];
    Timestamp::Text(raw[..raw.find('"')?].to_owned()).time()
}

/// The plan badge after the Included usage (or older Cloud Usage) heading.
fn plan(html: &str) -> Option<String> {
    ["Included usage", "Cloud Usage"].iter().find_map(|label| {
        html.match_indices(label).find_map(|(index, _)| {
            let rest = html[index + label.len()..].trim_start();
            let rest = rest.strip_prefix("</span>")?.trim_start();
            let rest = rest.strip_prefix("<span")?;
            let rest = &rest[rest.find('>')? + 1..];
            let end = rest.find('<')?;
            rest[end..].starts_with("</span").then_some(())?;
            let plan = rest[..end].trim();
            (!plan.is_empty()).then(|| plan.to_owned())
        })
    })
}

fn email(html: &str) -> Option<String> {
    let start = html.find("id=\"header-email\"")?;
    let rest = &html[start..];
    let rest = &rest[rest.find('>')? + 1..];
    let email = rest[..rest.find('<')?].trim();
    email.contains('@').then(|| email.to_owned())
}

/// A sign-in form rather than the settings page, as CodexBar judges it.
fn signed_out(html: &str) -> bool {
    let lower = html.to_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    let heading = any(&["sign in to ollama", "log in to ollama"]);
    let auth_route = any(&["/api/auth/signin", "/auth/signin"]);
    let login_route = any(&[
        "action=\"/login\"",
        "action='/login'",
        "href=\"/login\"",
        "href='/login'",
        "action=\"/signin\"",
        "action='/signin'",
        "href=\"/signin\"",
        "href='/signin'",
    ]);
    let password = any(&[
        "type=\"password\"",
        "type='password'",
        "name=\"password\"",
        "name='password'",
    ]);
    let email = any(&[
        "type=\"email\"",
        "type='email'",
        "name=\"email\"",
        "name='email'",
    ]);
    let form = lower.contains("<form");
    let endpoint = auth_route || login_route;
    form && (endpoint || (heading && (email || password))) || (form && password && email)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(rfc3339: &str) -> Option<SystemTime> {
        Timestamp::Text(rfc3339.into()).time()
    }

    /// CodexBar's current Plan & Billing fixture.
    const MONTHLY_PAGE: &str = r#"<div>
      <h2 class="text-xl font-medium flex items-center space-x-2">
        <span>Included usage</span>
        <span
          class="text-xs font-normal px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 capitalize"
          >pro</span
        >
      </h2>
      <h2 id="header-email">user@example.com</h2>
      <div>
        <div class="flex justify-between mb-2">
          <span class="text-sm">Monthly usage</span>
          <span class="text-sm "
            >$7.50 of $60 used</span
          >
        </div>
        <div class="relative group" data-usage-meter>
          <div
            class="relative h-3 overflow-hidden rounded-full bg-neutral-200"
            data-usage-track
            aria-label="Monthly usage $7.50 of $60 used"
          >
            <div class="flex h-full overflow-hidden bg-neutral-950" style="width: 12.5%; ">
            </div>
          </div>
        </div>
        <div
          class="text-xs text-neutral-500 mt-1 local-time"
          data-time="2026-09-30T15:14:29Z"
        >
          Resets in 4 weeks.
        </div>
      </div>
    </div>"#;

    /// CodexBar's legacy Cloud Usage fixture.
    const LEGACY_PAGE: &str = r#"<div>
      <h2 class="text-xl">
        <span>Cloud Usage</span>
        <span class="text-xs">free</span>
      </h2>
      <h2 id="header-email">user@example.com</h2>
      <div>
        <span>Session usage</span>
        <span>0.1% used</span>
        <div class="local-time" data-time="2026-01-30T18:00:00Z">Resets in 3 hours</div>
      </div>
      <div>
        <span>Weekly usage</span>
        <span>0.7% used</span>
        <div class="local-time" data-time="2026-02-02T00:00:00Z">Resets in 2 days</div>
      </div>
    </div>"#;

    #[test]
    fn reads_monthly_included_credits() {
        let report = parse(MONTHLY_PAGE).unwrap();
        assert_eq!(report.provider.id(), "ollama");
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.account.email.as_deref(), Some("user@example.com"));
        assert_eq!(report.windows.len(), 1);
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 12.5).abs() < 1e-4);
        assert_eq!(window.resets_at, at("2026-09-30T15:14:29Z"));
    }

    #[test]
    fn reads_legacy_session_and_weekly_windows() {
        let report = parse(LEGACY_PAGE).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Free"));
        let session = &report.windows[0];
        assert_eq!(session.kind, Kind::Session);
        assert!((session.used - 0.1).abs() < 1e-4);
        assert_eq!(session.resets_at, at("2026-01-30T18:00:00Z"));
        let weekly = &report.windows[1];
        assert_eq!(weekly.kind, Kind::Weekly);
        assert!((weekly.used - 0.7).abs() < 1e-4);
        assert_eq!(weekly.resets_at, at("2026-02-02T00:00:00Z"));
    }

    #[test]
    fn grouped_dollars_and_meter_fallback() {
        let grouped =
            parse("<span>Monthly usage</span><span>$1,250 of $5,000 used</span>").unwrap();
        assert!((grouped.windows[0].used - 25.).abs() < 1e-4);
        let zero = parse(
            r#"<span>Monthly usage</span><span>$0 of $0 used</span><div style="width: 25%; "></div>"#,
        )
        .unwrap();
        assert!((zero.windows[0].used - 25.).abs() < 1e-4);
        assert_eq!(amount("1,25 of"), Some((1., ",25 of")));
        assert_eq!(amount("7.50 of"), Some((7.5, " of")));
    }

    #[test]
    fn a_sign_in_form_is_a_rejection() {
        let html = r#"<html><body><h1>Sign in to Ollama</h1>
            <form action="/auth/signin" method="post">
              <input type="email" name="email" /><input type="password" name="password" />
            </form></body></html>"#;
        assert!(matches!(parse(html), Err(Error::UsageRejected)));
        assert!(matches!(
            parse("<html><body>No usage here.</body></html>"),
            Err(Error::UsageJson(_))
        ));
    }

    #[test]
    fn counts_the_api_catalog() {
        let report =
            parse_tags(r#"{"models":[{"name":"gpt-oss:120b"},{"name":"qwen3"}]}"#).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("API key"));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Models".to_owned(), "2".to_owned()));
    }
}
