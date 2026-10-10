//! ai& spend, summed from the request-log API with an API key from the config
//! or `AIAND_API_KEY`. The public API has no quota windows and no credit
//! balance, and `/analytics/summary` omits the documented cost, so like
//! CodexBar this sums each log row's decimal `cost` over the 30 days ai&
//! retains, following the cursors for at most 10 pages. There is no local
//! sign-in, and CodexBar reads no cookies for ai&.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Provider, Report, Unit},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
    },
};
use serde::Deserialize;

const URL: &str = "https://api.aiand.com/logs?range=30days&limit=100";
const PAGES: usize = 10;
/// Costs are summed as integers of this many decimal places, so a thousand
/// rows add up exactly.
const SCALE: u32 = 12;

pub(crate) struct Aiand;

static META: Meta = Meta::new("aiand", "ai&")
    .dashboard("https://console.aiand.com")
    .settings(&[Setting::new(
        "api_key",
        &["AIAND_API_KEY"],
        "An ai& API key (starts with sk-), created at https://console.aiand.com under \
         Settings > API Keys > Create. Keys are shown only once.",
    )]);

impl Service for Aiand {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        let mut tally = Tally::default();
        let mut cursor: Option<(String, String)> = None;
        for _ in 0..PAGES {
            let url = match &cursor {
                Some((after, id)) => {
                    format!("{URL}&after={}&after_id={}", encode(after), encode(id))
                }
                None => URL.to_owned(),
            };
            let page = probe
                .body(Request::get(url).bearer(&key))
                .and_then(|body| tally.add(&body));
            match page {
                Ok(Some(next)) => cursor = Some(next),
                Ok(None) => break,
                Err(error) => return Some(Err(error)),
            }
        }
        Some(Ok(tally.report()))
    }
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// The spend summed so far, in the currency of the newest row.
#[derive(Debug, Default)]
pub(crate) struct Tally {
    currency: Option<String>,
    total: i128,
    complete: bool,
}

impl Tally {
    /// Adds one page of logs; returns the cursor of the next page when there
    /// is one to follow.
    pub(crate) fn add(&mut self, body: &str) -> Result<Option<(String, String)>> {
        let page: Page = json(body)?;
        for row in page.data {
            let (Some(cost), Some(code)) = (
                row.cost.as_deref().and_then(decimal),
                row.currency
                    .as_deref()
                    .map(|code| code.trim().to_ascii_uppercase())
                    .filter(|code| !code.is_empty()),
            ) else {
                continue;
            };
            // Rows in another currency cannot be added to the newest one's.
            if *self.currency.get_or_insert_with(|| code.clone()) != code {
                continue;
            }
            self.total = self.total.saturating_add(cost);
        }
        if !page.has_more.unwrap_or(false) {
            self.complete = true;
            return Ok(None);
        }
        // Both cursors are required; a missing one leaves the total partial.
        Ok(page.next_after.zip(page.next_after_id))
    }

    pub(crate) fn report(self) -> Report {
        let balance = self.currency.map(|currency| {
            let label = if self.complete {
                "Spend, last 30 days"
            } else {
                "Spend, last 30 days (partial)"
            };
            Balance::new(
                label,
                self.total as f64 / 10_f64.powi(SCALE as i32),
                Unit::Currency(currency),
            )
        });
        Report::new(Provider(&Aiand), Account::default(), Vec::new()).with_balances(balance)
    }
}

/// A decimal string such as `0.000123` or `1.5e-3` as an integer of
/// [`SCALE`] places. Digits past that scale are dropped.
fn decimal(raw: &str) -> Option<i128> {
    let raw = raw.trim();
    let (mantissa, exponent) = match raw.find(['e', 'E']) {
        Some(at) => (&raw[..at], raw[at + 1..].parse::<i32>().ok()?),
        None => (raw, 0),
    };
    if !(-64..=64).contains(&exponent) {
        return None;
    }
    let (negative, digits) = match mantissa.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, mantissa.strip_prefix('+').unwrap_or(mantissa)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    // The decimal point moves by the exponent, then the number is read at
    // SCALE places.
    let point = whole.len() as i32 + exponent + SCALE as i32;
    let mut value: i128 = 0;
    for (index, byte) in whole.bytes().chain(fraction.bytes()).enumerate() {
        if index as i32 >= point {
            break;
        }
        value = value
            .checked_mul(10)?
            .checked_add(i128::from(byte - b'0'))?;
    }
    let digits = (whole.len() + fraction.len()) as i32;
    for _ in digits..point {
        value = value.checked_mul(10)?;
    }
    Some(if negative { -value } else { value })
}

#[derive(Deserialize)]
struct Page {
    data: Vec<Row>,
    has_more: Option<bool>,
    next_after: Option<String>,
    next_after_id: Option<String>,
}

#[derive(Deserialize)]
struct Row {
    cost: Option<String>,
    currency: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const FIRST: &str = r#"{
      "data": [
        {"id": "log_3", "model": "claude-sonnet-4-5", "cost": "0.012500", "currency": "USD"},
        {"id": "log_2", "model": "gpt-5", "cost": "1.1", "currency": "usd"},
        {"id": "log_1", "model": "gpt-5", "cost": "300", "currency": "JPY"}
      ],
      "has_more": true,
      "next_after": "2026-07-17T10:00:00Z",
      "next_after_id": "log_1"
    }"#;

    const LAST: &str = r#"{
      "data": [{"id": "log_0", "cost": "2.5e-1", "currency": "USD"}, {"id": "x", "cost": null}],
      "has_more": false,
      "next_after": null,
      "next_after_id": null
    }"#;

    #[test]
    fn sums_pages_in_the_newest_currency() {
        let mut tally = Tally::default();
        let next = tally.add(FIRST).unwrap();
        assert_eq!(next, Some(("2026-07-17T10:00:00Z".into(), "log_1".into())));
        assert_eq!(tally.add(LAST).unwrap(), None);
        let report = tally.report();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances.len(), 1);
        let balance = &report.balances[0];
        assert_eq!(balance.label, "Spend, last 30 days");
        assert_eq!(balance.unit, Unit::Currency("USD".into()));
        assert!((balance.amount - 1.3625).abs() < 1e-9);
    }

    #[test]
    fn marks_a_truncated_window_partial() {
        let mut tally = Tally::default();
        tally.add(FIRST).unwrap();
        assert_eq!(
            tally.report().balances[0].label,
            "Spend, last 30 days (partial)"
        );
    }

    #[test]
    fn shows_nothing_without_rows() {
        let mut tally = Tally::default();
        tally.add(r#"{"data": [], "has_more": false}"#).unwrap();
        assert!(tally.report().balances.is_empty());
    }

    #[test]
    fn reads_decimals_exactly() {
        assert_eq!(decimal("0.000000000001"), Some(1));
        assert_eq!(decimal("-1.5"), Some(-1_500_000_000_000));
        assert_eq!(decimal("15E-1"), Some(1_500_000_000_000));
        assert_eq!(decimal(".5"), Some(500_000_000_000));
        assert_eq!(decimal("abc"), None);
        assert_eq!(decimal(""), None);
    }
}
