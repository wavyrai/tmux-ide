//! Fireworks API spend over the last 30 days, read with an API key (`api_key`,
//! or `FIREWORKS_API_KEY`/`FIREWORKS_KEY` here or on the probed host) from
//! the account billing summary. Fireworks has no public balance or quota
//! endpoint, so, as in CodexBar, the spend is the only figure shown.
//!
//! The account slug comes from `account_slug` when set, else from the
//! accounts the key can see when there is exactly one. CodexBar saves a
//! discovered slug back to its config; this port rediscovers it each time
//! instead, since it never writes the config.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const ACCOUNTS_URL: &str = "https://api.fireworks.ai/v1/accounts";
/// Pages of accounts read before giving up on a key that sees very many.
const MAX_PAGES: usize = 20;
const PERIOD: Duration = Duration::from_secs(30 * 86_400);

pub(crate) struct Fireworks;

static META: Meta = Meta::new("fireworks", "Fireworks")
    .dashboard("https://app.fireworks.ai/billing")
    .settings(&[
        Setting::new(
            "api_key",
            &["FIREWORKS_API_KEY", "FIREWORKS_KEY"],
            "A Fireworks API key from https://app.fireworks.ai/settings/users/api-keys. \
             It reads the account's billing summary.",
        ),
        Setting::new(
            "account_slug",
            &["FIREWORKS_ACCOUNT_SLUG"],
            "The Fireworks account id, needed only when the API key can see several \
             accounts. Find it in the account switcher on https://app.fireworks.ai or \
             with `firectl whoami`.",
        ),
    ]);

impl Service for Fireworks {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("FIREWORKS_API_KEY"))
            .or_else(|| probe.env("FIREWORKS_KEY"))?;
        let configured = probe
            .text_setting("account_slug")
            .filter(|slug| !slug.is_empty());
        Some(spend(probe, &key, configured.as_deref()))
    }
}

fn spend(probe: &mut Probe, key: &Secret, configured: Option<&str>) -> Result<Report> {
    let now = SystemTime::now();
    if let Some(slug) = configured {
        if !valid_slug(slug) {
            return Err(Error::UsageNotSignedIn);
        }
        // A stale slug answers 404; the key's own account is then looked up.
        if let Some(body) = summary(probe, key, slug, now)? {
            return parse(&body, slug);
        }
    }
    let slug = only_account(probe, key)?;
    let body = summary(probe, key, &slug, now)?.ok_or(Error::UsageStatus(404))?;
    parse(&body, &slug)
}

/// The billing summary of the last 30 days, or None when the account is unknown.
fn summary(probe: &mut Probe, key: &Secret, slug: &str, now: SystemTime) -> Result<Option<String>> {
    let end = chrono::DateTime::<chrono::Utc>::from(now);
    let start = chrono::DateTime::<chrono::Utc>::from(now.checked_sub(PERIOD).unwrap_or(now));
    let stamp = |at: chrono::DateTime<chrono::Utc>| {
        let text = at.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>()
    };
    let url = format!(
        "{ACCOUNTS_URL}/{slug}/billing/summary?startTime={}&endTime={}",
        stamp(start),
        stamp(end),
    );
    let response = probe.http(request(&url, key))?;
    if response.status == 404 {
        return Ok(None);
    }
    response.ok().map(Some)
}

/// The one account the key can see; several or none need `account_slug`.
fn only_account(probe: &mut Probe, key: &Secret) -> Result<String> {
    let mut slugs: Vec<String> = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let url = match &token {
            Some(token) => format!(
                "{ACCOUNTS_URL}?pageToken={}",
                url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>()
            ),
            None => ACCOUNTS_URL.to_owned(),
        };
        let page: AccountsPage = probe.http(request(&url, key))?.json()?;
        for account in page.accounts.unwrap_or_default() {
            if let Some(slug) = account.slug().filter(|slug| !slugs.contains(slug)) {
                slugs.push(slug);
            }
        }
        token = page
            .next_page_token
            .map(|next| next.trim().to_owned())
            .filter(|next| !next.is_empty() && Some(next) != token.as_ref());
        if token.is_none() {
            break;
        }
    }
    match <[String; 1]>::try_from(slugs) {
        Ok([slug]) => Ok(slug),
        Err(_) => Err(Error::UsageNotSignedIn),
    }
}

fn request(url: &str, key: &Secret) -> Request {
    Request::get(url)
        .bearer(key)
        .header("Accept", "application/json")
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 256
        && slug != "."
        && slug != ".."
        && slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Sums the rated line items in the first currency seen, as CodexBar does.
pub(crate) fn parse(body: &str, slug: &str) -> Result<Report> {
    let summary: Summary = json(body)?;
    let mut currency: Option<String> = None;
    let mut total = 0.;
    for cost in summary
        .line_items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.total_cost)
    {
        let (Some(units), Some(nanos), Some(code)) = (cost.units, cost.nanos, cost.currency_code)
        else {
            continue;
        };
        let Ok(units) = units.trim().parse::<f64>() else {
            continue;
        };
        let code = code.trim().to_owned();
        if code.is_empty() || !units.is_finite() {
            continue;
        }
        let currency = currency.get_or_insert_with(|| code.clone());
        if *currency == code {
            total += units + nanos as f64 / 1e9;
        }
    }
    let account = Section::Facts {
        title: "Account".into(),
        facts: vec![("Slug".into(), slug.to_owned())],
    };
    let report = Report::new(Provider(&Fireworks), Account::default(), Vec::new());
    Ok(match currency {
        Some(code) => report
            .with_balances([Balance::new(
                "Spend, last 30 days",
                total,
                Unit::Currency(code),
            )])
            .with_sections([account]),
        None => report.with_sections([
            Section::Facts {
                title: "Spend, last 30 days".into(),
                facts: vec![("Rated spend".into(), "None".into())],
            },
            account,
        ]),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsPage {
    accounts: Option<Vec<AccountEntry>>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountEntry {
    account_id: Option<String>,
    id: Option<String>,
    name: Option<String>,
}

impl AccountEntry {
    /// `accounts/acme` names the account `acme`.
    fn slug(self) -> Option<String> {
        [self.account_id, self.id, self.name]
            .into_iter()
            .flatten()
            .find(|value| !value.trim().is_empty())
            .and_then(|name| {
                name.trim()
                    .split('/')
                    .rfind(|part| !part.is_empty())
                    .map(str::to_owned)
            })
            .filter(|slug| valid_slug(slug))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    line_items: Option<Vec<LineItem>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineItem {
    total_cost: Option<Cost>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cost {
    currency_code: Option<String>,
    units: Option<String>,
    nanos: Option<i64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn sums_rated_spend_in_the_first_currency() {
        let body = r#"{
            "lineItems": [
                {"description": "llama-v3p1-8b", "totalCost": {"currencyCode": "USD", "units": "0", "nanos": 530000000}},
                {"description": "deepseek-r1", "totalCost": {"currencyCode": "USD", "units": "2", "nanos": 250000000}},
                {"description": "other currency", "totalCost": {"currencyCode": "EUR", "units": "9", "nanos": 0}},
                {"description": "unrated"}
            ]
        }"#;
        let report = parse(body, "acme").unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances.len(), 1);
        let balance = &report.balances[0];
        assert_eq!(balance.unit, Unit::Currency("USD".into()));
        assert!((balance.amount - 2.78).abs() < 1e-9);
        assert_eq!(balance.total, None);
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Account".into(),
                facts: vec![("Slug".into(), "acme".into())],
            }]
        );
    }

    #[test]
    fn empty_summary_invents_no_spend() {
        let report = parse(r#"{"lineItems": []}"#, "acme").unwrap();
        assert!(report.balances.is_empty());
        assert_eq!(report.sections.len(), 2);
    }

    #[test]
    fn account_slug_is_the_last_name_segment() {
        let page: AccountsPage = serde_json::from_str(
            r#"{"accounts": [{"name": "accounts/acme-inc", "displayName": "Acme"}], "nextPageToken": ""}"#,
        )
        .unwrap();
        let slugs: Vec<_> = page
            .accounts
            .unwrap()
            .into_iter()
            .filter_map(AccountEntry::slug)
            .collect();
        assert_eq!(slugs, ["acme-inc"]);
        assert!(!valid_slug(".."));
        assert!(!valid_slug("a/b"));
    }
}
