//! TypeSafe billing spend and credit balance, read through the console's
//! Next.js server action with a console.typesafe.ai session: the `cookie`
//! setting, or Chrome and Safari when TypeSafe is listed in
//! `show_providers`. The action's id is found in the billing page's script
//! chunks and kept for twelve hours, then found again when the server no
//! longer knows it. An inference API key is not a console session, so none
//! is read, as in CodexBar. TypeSafe reports no quota or reset, so there
//! are only balances.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit, title_case},
        probe::{Probe, Request, Response, Secret},
        service::{Meta, Service, Setting, Timestamp},
        values::{invalid, trimmed},
    },
};
use serde::Deserialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

const ORIGIN: &str = "https://console.typesafe.ai";
const BILLING: &str = "https://console.typesafe.ai/settings/billing";
const ACTION_TTL: Duration = Duration::from_secs(12 * 3600);
const MAX_CHUNKS: usize = 60;
const MAX_CREDIT_ROWS: usize = 22;

/// The discovered server-action id, which is public page code, not a secret.
static ACTION: Mutex<Option<(String, Instant)>> = Mutex::new(None);

pub(crate) struct Typesafe;

static META: Meta = Meta::new("typesafe", "TypeSafe")
    .dashboard(BILLING)
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Sign in at https://console.typesafe.ai/settings/billing, open Developer Tools > \
         Application > Cookies > https://console.typesafe.ai, and copy every cookie there \
         as one \"name=value; name2=value2\" header. An inference API key does not work \
         here.",
    )]);

impl Service for Typesafe {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["console.typesafe.ai", "typesafe.ai"], &[])?;
        Some(read(probe, &cookie))
    }
}

fn read(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let cached = ACTION
        .lock()
        .ok()
        .and_then(|action| action.clone())
        .filter(|(_, found)| found.elapsed() < ACTION_TTL)
        .map(|(id, _)| id);
    let (id, fresh) = match cached {
        Some(id) => (id, false),
        None => (discover(probe, cookie)?, true),
    };
    let mut response = post(probe, cookie, &id)?;
    // A stale id is answered with 404 once the console redeploys.
    if response.status == 404 && !fresh {
        let id = discover(probe, cookie)?;
        response = post(probe, cookie, &id)?;
    }
    parse(&checked(response.status, response.body)?)
}

fn post(probe: &mut Probe, cookie: &Secret, id: &str) -> Result<Response> {
    probe.http(
        Request::post(BILLING)
            .cookie(cookie)
            .header("Origin", ORIGIN)
            .header("Next-Action", id)
            .header("Accept", "text/x-component")
            .json("[]")
            .timeout(Duration::from_secs(6)),
    )
}

/// Redirects and the login page, which can arrive with HTTP 200, mean the
/// session has ended.
fn checked(status: u16, body: String) -> Result<String> {
    if (300..400).contains(&status) || login_landing(&body) {
        return Err(Error::UsageRejected);
    }
    Response { status, body }.ok()
}

fn login_landing(body: &str) -> bool {
    body.replace('\\', "")
        .contains(r#""(auth)",{"children":["login""#)
}

fn discover(probe: &mut Probe, cookie: &Secret) -> Result<String> {
    let page = probe.http(
        Request::get(BILLING)
            .cookie(cookie)
            .header("Accept", "text/html")
            .timeout(Duration::from_secs(6)),
    )?;
    let page = checked(page.status, page.body)?;
    let mut failure = None;
    let remember = |id: &str| {
        if let Ok(mut action) = ACTION.lock() {
            *action = Some((id.to_owned(), Instant::now()));
        }
    };
    for url in chunks(&page) {
        // Chunks are public, so they carry no cookie.
        match probe.http(Request::get(url).timeout(Duration::from_secs(4))) {
            Ok(chunk) if chunk.status == 408 || chunk.status == 429 || chunk.status >= 500 => {
                return Err(chunk.ok().err().unwrap_or(Error::UsageStatus(0)));
            }
            Ok(chunk) if (200..300).contains(&chunk.status) => {
                if let Some(id) = action_id(&chunk.body) {
                    remember(&id);
                    return Ok(id);
                }
            }
            Ok(_) => {}
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    Err(failure.unwrap_or_else(invalid))
}

/// Same-origin script chunks the billing page loads, in page order.
pub(crate) fn chunks(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut urls: Vec<String> = Vec::new();
    let mut from = 0;
    while urls.len() < MAX_CHUNKS {
        let Some(offset) = lower[from..].find("<script") else {
            break;
        };
        let start = from + offset;
        let end = lower[start..]
            .find('>')
            .map_or(lower.len(), |end| start + end);
        from = end;
        let tag = &lower[start..end];
        let Some(at) = tag.find(" src=") else {
            continue;
        };
        let value = &html[start + at + 5..end];
        let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        let Some(source) = value[1..].split(quote).next() else {
            continue;
        };
        let url = if source.starts_with('/') && !source.starts_with("//") {
            format!("{ORIGIN}{source}")
        } else {
            source.to_owned()
        };
        let path = url.split('?').next().unwrap_or_default();
        if url.starts_with(&format!("{ORIGIN}/"))
            && path.to_ascii_lowercase().ends_with(".js")
            && !urls.contains(&url)
        {
            urls.push(url);
        }
    }
    urls
}

/// The 40-or-more hex digit id quoted shortly before the
/// `"getBillingOverviewResult"` name, with no `)` between them.
pub(crate) fn action_id(chunk: &str) -> Option<String> {
    const MARKER: &str = "\"getBillingOverviewResult\"";
    let bytes = chunk.as_bytes();
    let mut from = 0;
    while let Some(offset) = chunk[from..].find('"') {
        let open = from + offset;
        let digits = bytes[open + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_hexdigit())
            .count();
        let close = open + 1 + digits;
        if digits >= 40 && bytes.get(close) == Some(&b'"') {
            let rest = &chunk[close + 1..];
            let mut window = rest.len().min(150 + MARKER.len());
            while !rest.is_char_boundary(window) {
                window -= 1;
            }
            if let Some(gap) = rest[..window].find(MARKER)
                && gap <= 150
                && !rest[..gap].contains(')')
            {
                return Some(chunk[open + 1..close].to_owned());
            }
            from = close;
        } else {
            from = open + 1;
        }
    }
    None
}

/// The React Server Components answer: numbered lines of JSON, one of them
/// the action's `{ok, data}` result.
pub(crate) fn parse(body: &str) -> Result<Report> {
    let result = body
        .lines()
        .filter_map(|line| {
            let (index, json) = line.split_once(':')?;
            (!index.is_empty())
                .then(|| serde_json::from_str::<serde_json::Value>(json).ok())
                .flatten()
        })
        .find(|value| value.get("ok").is_some())
        .ok_or_else(invalid)?;
    if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(invalid());
    }
    let billing = result
        .get("data")
        .and_then(|data| data.get("billing"))
        .cloned()
        .ok_or_else(invalid)?;
    let billing: Billing =
        serde_json::from_value(billing).map_err(|error| Error::UsageJson(error.classify()))?;
    let spent = billing
        .spent
        .filter(|value| value.is_finite())
        .ok_or_else(invalid)?;
    let balance = billing
        .balance
        .filter(|value| value.is_finite())
        .ok_or_else(invalid)?;
    let cycle = billing
        .cycle_label
        .map(|label| label.trim().to_owned())
        .filter(|label| !label.is_empty());
    let plan = billing
        .plan
        .map(|plan| plan.trim().to_owned())
        .filter(|plan| !plan.is_empty())
        .map(|plan| {
            if plan == "free_plan" {
                "Free".to_owned()
            } else {
                plan.split(['_', '-'])
                    .filter(|part| !part.is_empty())
                    .map(|part| title_case(&part.to_lowercase()))
                    .collect::<Vec<_>>()
                    .join(" ")
            }
        });
    let usd = || Unit::Currency("USD".into());
    let spent_label = match &cycle {
        Some(cycle) => format!("Spent ({cycle})"),
        None => "Spent".into(),
    };
    let active: Vec<(String, String)> = billing
        .credits
        .unwrap_or_default()
        .into_iter()
        .filter_map(|credit| {
            let (amount, remaining) = (credit.amount?, credit.remaining?);
            if !amount.is_finite() || !remaining.is_finite() || remaining <= 0. {
                return None;
            }
            let expires = Timestamp::Text(credit.expires_at?).time()?;
            let expires = chrono::DateTime::<chrono::Utc>::from(expires).format("%b %-d");
            Some((
                "Credit".to_owned(),
                format!(
                    "{} of {}, expires {expires}",
                    trimmed(remaining),
                    trimmed(amount)
                ),
            ))
        })
        .collect();
    let credits = if active.len() > MAX_CREDIT_ROWS {
        let shown = MAX_CREDIT_ROWS - 1;
        let mut credits = active[..shown].to_vec();
        credits.push((
            "Additional credits".to_owned(),
            (active.len() - shown).to_string(),
        ));
        credits
    } else {
        active
    };
    let sections = (!credits.is_empty()).then(|| Section::Facts {
        title: "Credits".into(),
        facts: credits,
    });
    let account = Account { email: None, plan };
    Ok(Report::new(Provider(&Typesafe), account, Vec::new())
        .with_balances([
            Balance::new("Balance", balance, usd()),
            Balance::new(spent_label, spent, usd()),
        ])
        .with_sections(sections))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Billing {
    plan: Option<String>,
    spent: Option<f64>,
    balance: Option<f64>,
    cycle_label: Option<String>,
    credits: Option<Vec<Credit>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credit {
    amount: Option<f64>,
    remaining: Option<f64>,
    expires_at: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const BODY: &str = r#"0:{"a":"$@1"}
1:{"ok":true,"data":{"billing":{"plan":"free_plan","spent":0.01,"freeCreditsRemaining":4.98,"balance":4.98,"purchased":0,"resetsInDays":12,"cycleLabel":"September 2026","credits":[{"id":"00000000-0000-4000-8000-000000000001","amount":5,"remaining":4.98,"expiresAt":"2026-10-19T00:00:00Z"},{"id":"00000000-0000-4000-8000-000000000002","amount":2,"remaining":0,"expiresAt":"2026-10-19T00:00:00Z"}]}}}"#;

    #[test]
    fn billing_maps_balance_spend_plan_and_active_credits() {
        let report = parse(BODY).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Balance");
        assert_eq!(report.balances[0].amount, 4.98);
        assert_eq!(report.balances[1].label, "Spent (September 2026)");
        assert_eq!(report.balances[1].amount, 0.01);
        assert_eq!(report.account.plan.as_deref(), Some("Free"));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].1, "4.98 of 5, expires Oct 19");
    }

    #[test]
    fn failed_or_missing_result_is_an_error() {
        assert!(parse(r#"1:{"ok":false}"#).is_err());
        assert!(parse(r#"0:{"a":"$@1"}"#).is_err());
        assert!(parse(r#"1:{"ok":true,"data":{"billing":{"spent":1}}}"#).is_err());
    }

    #[test]
    fn plan_ids_read_as_names() {
        let body = BODY.replace("free_plan", "pro_monthly-PLAN");
        let report = parse(&body).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro Monthly Plan"));
    }

    #[test]
    fn discovers_same_origin_chunks_and_the_action_id() {
        let html = r#"<script src="/_next/static/chunks/app.js"></script>
            <script async src='https://cdn.example.com/x.js'></script>
            <script src="/_next/static/chunks/app.js"></script>
            <script src="/_next/static/chunks/page.js?v=2"></script>"#;
        assert_eq!(
            chunks(html),
            [
                "https://console.typesafe.ai/_next/static/chunks/app.js",
                "https://console.typesafe.ai/_next/static/chunks/page.js?v=2",
            ]
        );
        let id = "b".repeat(40);
        let chunk =
            format!(r#""{id}",c.callServer,void 0,c.findSourceMapURL,"getBillingOverviewResult""#);
        assert_eq!(action_id(&chunk), Some(id));
        let far = format!(r#""{}",f(),"getBillingOverviewResult""#, "a".repeat(40));
        assert_eq!(action_id(&far), None);
    }

    #[test]
    fn login_page_rejects_the_session() {
        let page = r#"<script>self.__next_f.push([1,"0:{\"f\":[[[\"\",{\"children\":[\"(auth)\",{\"children\":[\"login\",{\"children\":[\"__PAGE__\",{}]}]}]}]]}"])</script>"#;
        assert!(matches!(
            checked(200, page.into()),
            Err(Error::UsageRejected)
        ));
        assert!(matches!(
            checked(307, String::new()),
            Err(Error::UsageRejected)
        ));
    }
}
