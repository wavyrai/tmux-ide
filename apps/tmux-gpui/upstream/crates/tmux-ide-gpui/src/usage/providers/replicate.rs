//! Replicate spend this month and prepaid credit, read from the website's
//! billing endpoints with a replicate.com session: the `cookie` setting, or
//! Chrome and Safari when Replicate is listed in `show_providers`. The
//! billing page names the signed-in user or organization, whose current
//! monthly-usage invoice gives the spend. A Replicate API token is not a
//! website session and cannot read billing, so none is read, as in CodexBar.
//! CodexBar's cookie cache and retrying of several browser sessions are not
//! ported: the first matching session is used.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{encode, invalid},
    },
};
use serde::Deserialize;
use std::{collections::VecDeque, time::SystemTime};

const SITE: &str = "https://replicate.com";

pub(crate) struct Replicate;

static META: Meta = Meta::new("replicate", "Replicate")
    .dashboard("https://replicate.com/account/billing")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Sign in at https://replicate.com/account/billing, open Developer Tools > \
         Application > Cookies > https://replicate.com, and copy sessionid (and csrftoken \
         when present) as one \"sessionid=value; csrftoken=value\" header. An API token \
         does not work here.",
    )]);

impl Service for Replicate {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["replicate.com"], &["sessionid"])?;
        Some(read(probe, &cookie))
    }
}

fn read(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let page = probe.body(
        Request::get(format!("{SITE}/account/billing"))
            .cookie(cookie)
            .header("Accept", "text/html"),
    )?;
    let owner = owner(&page)?;
    let base = owner.base();
    let invoices = probe.body(Request::get(format!("{base}/invoices")).cookie(cookie))?;
    // The credit balance only enriches the spend, so its failure is dropped.
    let credit = probe
        .body(Request::get(format!("{base}/unused-credit")).cookie(cookie))
        .ok();
    parse(&owner, &invoices, credit.as_deref(), SystemTime::now())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Owner {
    pub organization: bool,
    pub username: String,
}

impl Owner {
    fn base(&self) -> String {
        let collection = if self.organization {
            "organizations"
        } else {
            "users"
        };
        format!("{SITE}/api/{collection}/{}", encode(&self.username))
    }
}

/// The billing page's React props name the account it bills; a signed-out
/// page is the sign-in page instead.
pub(crate) fn owner(html: &str) -> Result<Owner> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(offset) = lower[from..].find("<script") {
        let start = from + offset;
        let Some(open_end) = lower[start..].find('>').map(|end| start + end) else {
            break;
        };
        let Some(close) = lower[open_end..].find("</script").map(|end| open_end + end) else {
            break;
        };
        from = close;
        let attributes = &lower[start..open_end];
        if !attributes.contains("react-component-props") || !attributes.contains("application/json")
        {
            continue;
        }
        let Ok(props) = serde_json::from_str::<serde_json::Value>(&html[open_end + 1..close])
        else {
            continue;
        };
        if let Some(owner) = find_owner(props) {
            return Ok(owner);
        }
    }
    if lower.contains("<title>sign in | replicate</title>") || lower.contains("/login/github/") {
        return Err(Error::UsageRejected);
    }
    Err(invalid())
}

/// Breadth first and bounded, as the props can be large.
fn find_owner(props: serde_json::Value) -> Option<Owner> {
    const LIMIT: usize = 4000;
    let mut queue = VecDeque::from([props]);
    let mut visited = 0;
    while let Some(value) = queue.pop_front() {
        visited += 1;
        if visited > LIMIT {
            return None;
        }
        if let Some(account) = value.get("account") {
            let kind = account.get("kind").and_then(serde_json::Value::as_str);
            let username = account
                .get("username")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if let (Some(kind @ ("user" | "organization")), Some(username)) = (kind, username) {
                return Some(Owner {
                    organization: kind == "organization",
                    username: username.to_owned(),
                });
            }
        }
        let children: Vec<serde_json::Value> = match value {
            serde_json::Value::Array(items) => items,
            serde_json::Value::Object(map) => map.into_values().collect(),
            _ => continue,
        };
        queue.extend(
            children
                .into_iter()
                .filter(|child| child.is_object() || child.is_array())
                .take(LIMIT.saturating_sub(queue.len())),
        );
    }
    None
}

pub(crate) fn parse(
    owner: &Owner,
    invoices: &str,
    credit: Option<&str>,
    now: SystemTime,
) -> Result<Report> {
    let invoices: Invoices = json(invoices)?;
    let current = invoices
        .invoices
        .into_iter()
        .find(|invoice| {
            invoice.kind.as_deref() == Some("monthly-usage")
                && invoice
                    .ended_before
                    .as_deref()
                    .is_none_or(|end| ended(end).is_some_and(|end| end > now))
        })
        .ok_or_else(invalid)?;
    let spent = current
        .total_cost_before_adjustments
        .as_deref()
        .and_then(money)
        .ok_or_else(invalid)?;
    let balance = credit
        .and_then(|body| json::<Credit>(body).ok())
        .and_then(|credit| credit.unused_credit)
        .as_deref()
        .and_then(money);
    let usd = || Unit::Currency("USD".into());
    let mut balances = vec![Balance::new("Spent this month", spent, usd())];
    if let Some(balance) = balance {
        balances.push(Balance::new("Credit balance", balance, usd()));
    }
    let account = Section::Facts {
        title: "Account".into(),
        facts: vec![(
            if owner.organization {
                "Organization"
            } else {
                "User"
            }
            .into(),
            owner.username.clone(),
        )],
    };
    Ok(
        Report::new(Provider(&Replicate), Account::default(), Vec::new())
            .with_balances(balances)
            .with_sections([account]),
    )
}

/// RFC 3339, or a bare date as the invoices sometimes send.
fn ended(text: &str) -> Option<SystemTime> {
    Timestamp::Text(text.to_owned()).time().or_else(|| {
        let date = chrono::NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()?;
        let at = date.and_hms_opt(0, 0, 0)?.and_utc();
        SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(
            u64::try_from(at.timestamp()).ok()?,
        ))
    })
}

/// An unsigned decimal string; anything else is not a usable amount.
fn money(text: &str) -> Option<f64> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, "0"));
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    (digits(whole) && digits(fraction))
        .then(|| text.parse::<f64>().ok())
        .flatten()
        .filter(|value| value.is_finite())
}

#[derive(Deserialize)]
struct Invoices {
    invoices: Vec<Invoice>,
}

#[derive(Deserialize)]
struct Invoice {
    #[serde(rename = "type")]
    kind: Option<String>,
    ended_before: Option<String>,
    total_cost_before_adjustments: Option<String>,
}

#[derive(Deserialize)]
struct Credit {
    unused_credit: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PAGE: &str = r#"<html><script type="application/json" id="react-component-props-billing-page">
    {"page":{"account":{"kind":"user","username":"demo-user"}}}
    </script></html>"#;
    const INVOICES: &str = r#"{"invoices":[{"type":"monthly-usage",
    "ended_before":null,
    "total_cost_before_adjustments":"12.40",
    "total_cost":"0"}]}"#;

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_755_000_000)
    }

    #[test]
    fn billing_page_names_the_account() {
        let user = owner(PAGE).unwrap();
        assert_eq!(
            user,
            Owner {
                organization: false,
                username: "demo-user".into()
            }
        );
        assert_eq!(user.base(), "https://replicate.com/api/users/demo-user");
        let nested = r#"<script id='react-component-props-layout' type='application/json'>
        {"layout":{"nested":{"account":{"kind":"organization","username":"demo-org"}}}}
        </script>"#;
        let organization = owner(nested).unwrap();
        assert!(organization.organization);
        assert_eq!(
            organization.base(),
            "https://replicate.com/api/organizations/demo-org"
        );
    }

    #[test]
    fn props_outside_the_component_script_are_ignored() {
        let page = r#"<script>{"account":{"kind":"user","username":"wrong"}}</script>"#;
        assert!(matches!(owner(page), Err(Error::UsageJson(_))));
        let signed_out = r#"<title>Sign in | Replicate</title><a href="/login/github/">GitHub</a>"#;
        assert!(matches!(owner(signed_out), Err(Error::UsageRejected)));
    }

    #[test]
    fn current_invoice_is_the_spend_and_credit_the_balance() {
        let owner = owner(PAGE).unwrap();
        let report = parse(&owner, INVOICES, Some(r#"{"unused_credit":"80.0"}"#), now()).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Spent this month");
        assert!((report.balances[0].amount - 12.4).abs() < 1e-9);
        assert_eq!(report.balances[1].amount, 80.);
        let without = parse(&owner, INVOICES, Some(r#"{"unused_credit":"NaN"}"#), now()).unwrap();
        assert_eq!(without.balances.len(), 1);
    }

    #[test]
    fn expired_invoices_are_skipped() {
        let owner = owner(PAGE).unwrap();
        let invoices = r#"{"invoices":[{"type":"monthly-usage",
        "ended_before":"2020-01-01",
        "total_cost_before_adjustments":"900"},{"type":"monthly-usage",
        "ended_before":"2090-01-01",
        "total_cost_before_adjustments":"12.40"}]}"#;
        let report = parse(&owner, invoices, None, now()).unwrap();
        assert!((report.balances[0].amount - 12.4).abs() < 1e-9);
        assert!(parse(&owner, r#"{"invoices":[]}"#, None, now()).is_err());
        assert!(
            parse(
                &owner,
                &INVOICES.replace("\"12.40\"", "\"-3\""),
                None,
                now()
            )
            .is_err()
        );
    }
}
