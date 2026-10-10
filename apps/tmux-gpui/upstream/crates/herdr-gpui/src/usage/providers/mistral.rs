//! Mistral API spend, included API and Vibe allowances, and credits, read
//! from Mistral Admin with the web session: the `cookie` setting, else (when
//! listed) the mistral.ai cookies from Chrome or Safari.
//!
//! Not ported: the console Vibe fallback
//! (`console.mistral.ai/api-ui/trpc/billing.vibeUsage`) and the
//! `X-CSRFTOKEN` header, both of which need the `csrftoken` cookie's value
//! on its own, which the probe cannot take out of a cookie header; the Vibe
//! allowance still shows when the subscription page reports it. Daily usage
//! buckets for CodexBar's cost chart are left out.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
    },
};
use chrono::Datelike;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};

const ADMIN: &str = "https://admin.mistral.ai";
const FLIGHT: &str = "self.__next_f.push(";

pub(crate) struct Mistral;

static META: Meta = Meta::new("mistral", "Mistral")
    .dashboard("https://admin.mistral.ai/organization/usage")
    .status_page("https://status.mistral.ai")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Sign in to https://admin.mistral.ai/organization/usage, open Developer Tools > \
         Application > Cookies for https://admin.mistral.ai, and copy the ory_session_… \
         cookie (its name ends in a per-project suffix) and csrftoken. Paste them as \
         \"name=value; name2=value2\"; the Cookie header of any admin.mistral.ai request \
         also works.",
    )]);

impl Service for Mistral {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["mistral.ai"], &[])?;
        Some(read(probe, &cookie))
    }
}

fn read(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let now = chrono::Utc::now();
    let usage = Request::get(format!(
        "{ADMIN}/api/billing/v2/usage?month={}&year={}",
        now.month(),
        now.year()
    ))
    .cookie(cookie)
    .header("Accept", "*/*")
    .header("Referer", format!("{ADMIN}/organization/usage"))
    .header("Origin", ADMIN);
    let usage = probe.body(usage)?;
    // Credits and allowances are optional; spend stands without them.
    let credits = Request::get(format!("{ADMIN}/api/billing/credits"))
        .cookie(cookie)
        .header("Accept", "*/*")
        .header("Referer", format!("{ADMIN}/organization/billing"))
        .header("Origin", ADMIN)
        .timeout(Duration::from_secs(5));
    let credits = probe.body(credits).ok();
    let subscription = Request::get(format!("{ADMIN}/subscription"))
        .cookie(cookie)
        .header("Accept", "text/html")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", format!("{ADMIN}/subscription"))
        .timeout(Duration::from_secs(5));
    let subscription = probe.body(subscription).ok();
    parse(&usage, credits.as_deref(), subscription.as_deref())
}

pub(crate) fn parse(
    usage: &str,
    credits: Option<&str>,
    subscription: Option<&str>,
) -> Result<Report> {
    let billing: Billing = json(usage)?;
    let prices: BTreeMap<(String, String), f64> = billing
        .prices
        .iter()
        .filter_map(|price| {
            let value = price
                .price
                .as_deref()?
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())?;
            Some((
                (price.billing_metric.clone()?, price.billing_group.clone()?),
                value,
            ))
        })
        .collect();
    let mut totals = Totals::default();
    let counted = [
        billing.completion.as_ref(),
        billing.chat.as_ref(),
        billing
            .vibe_code
            .as_ref()
            .and_then(|vibe| vibe.completion.as_ref()),
    ];
    for lanes in counted.into_iter().flatten() {
        for (name, model) in &lanes.models {
            totals.add(name, model, &prices, true);
        }
    }
    let libraries = billing.libraries_api.as_ref();
    let spent_only = [
        billing.ocr.as_ref(),
        billing.connectors.as_ref(),
        billing.audio.as_ref(),
        libraries.and_then(|libraries| libraries.pages.as_ref()),
        libraries.and_then(|libraries| libraries.tokens.as_ref()),
    ];
    for lanes in spent_only.into_iter().flatten() {
        for (name, model) in &lanes.models {
            totals.add(name, model, &prices, false);
        }
    }
    if let Some(tuning) = &billing.fine_tuning {
        for (name, model) in tuning.training.iter().chain(&tuning.storage) {
            totals.add(name, model, &prices, false);
        }
    }

    let currency = billing
        .currency
        .as_deref()
        .map(|currency| currency.trim().to_uppercase())
        .filter(|currency| !currency.is_empty())
        // Mistral Admin bills in euros unless the account says otherwise.
        .unwrap_or_else(|| "EUR".into());
    // A negative total is a refund adjustment, shown as nothing spent.
    let mut balances = vec![Balance::new(
        "API spend this month",
        totals.cost.max(0.),
        Unit::Currency(currency),
    )];
    let credits: Option<Credits> = credits.and_then(|body| json(body).ok());
    if let Some(credits) = credits {
        let available = credits.wallet_amount + credits.credit_notes_amount.unwrap_or(0.)
            - credits.ongoing_usage_balance.unwrap_or(0.);
        if available.is_finite() {
            let unit = Unit::Currency(credits.currency.trim().to_uppercase());
            balances.push(Balance::new("Credits", available.max(0.), unit));
        }
    }

    let budgets = subscription.map(budgets).unwrap_or_default();
    let mut windows = Vec::new();
    let mut allowances = Vec::new();
    for (title, budget) in [("Included API", budgets.api), ("Vibe", budgets.vibe)] {
        let Some(budget) = budget else { continue };
        windows.push(Window::new(
            Kind::Named(title.into()),
            budget.usage_percentage,
            budget.resets_at,
            Some(MONTH),
        ));
        let used = budget.limit * budget.usage_percentage / 100.;
        let text = Balance::new(title, used, Unit::Currency(budget.currency))
            .out_of(budget.limit)
            .text();
        allowances.push((title.to_owned(), format!("{text} used")));
    }

    let mut sections = Vec::new();
    if !allowances.is_empty() {
        sections.push(Section::Facts {
            title: "Allowances".into(),
            facts: allowances,
        });
    }
    let tokens = |value: f64| group(value.round() as i64);
    sections.push(Section::Facts {
        title: "Tokens this month".into(),
        facts: vec![
            ("Input".into(), tokens(totals.input)),
            ("Output".into(), tokens(totals.output)),
            ("Cached".into(), tokens(totals.cached)),
            ("Models".into(), totals.models.to_string()),
        ],
    });
    if totals.cost > 0. {
        let mut shares: Vec<(String, f32)> = totals
            .by_model
            .into_iter()
            .filter(|(_, cost)| *cost > 0.)
            .map(|(name, cost)| (name, (cost / totals.cost * 100.) as f32))
            .collect();
        shares.sort_by(|a, b| b.1.total_cmp(&a.1));
        shares.truncate(5);
        if !shares.is_empty() {
            sections.push(Section::Shares {
                title: "Spend by model".into(),
                shares,
            });
        }
    }
    Ok(Report::new(Provider(&Mistral), Account::default(), windows)
        .with_balances(balances)
        .with_sections(sections))
}

#[derive(Default)]
struct Totals {
    cost: f64,
    input: f64,
    output: f64,
    cached: f64,
    models: usize,
    by_model: BTreeMap<String, f64>,
}

impl Totals {
    /// Spend is priced from billed units (`value_paid`, else `value`);
    /// tokens count consumed units (`value`, else `value_paid`), so
    /// plan-covered use still counts.
    fn add(
        &mut self,
        key: &str,
        model: &ModelUsage,
        prices: &BTreeMap<(String, String), f64>,
        counts_tokens: bool,
    ) {
        if counts_tokens {
            self.models += 1;
        }
        let lanes = [
            (&model.input, &mut self.input),
            (&model.output, &mut self.output),
            (&model.cached, &mut self.cached),
        ];
        let mut cost = 0.;
        let mut name = None;
        for (entries, tokens) in lanes {
            for entry in entries {
                if counts_tokens {
                    *tokens += entry.value.or(entry.value_paid).unwrap_or(0.);
                }
                let units = entry.value_paid.or(entry.value).unwrap_or(0.);
                let price = entry
                    .billing_metric
                    .clone()
                    .zip(entry.billing_group.clone())
                    .and_then(|key| prices.get(&key))
                    .copied()
                    .unwrap_or(0.);
                let spent = units * price;
                if spent.is_finite() {
                    cost += spent;
                }
                if name.is_none() {
                    name = entry
                        .billing_display_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned);
                }
            }
        }
        if !(self.cost + cost).is_finite() {
            return;
        }
        self.cost += cost;
        let name = name.unwrap_or_else(|| key.split("::").next().unwrap_or(key).to_owned());
        *self.by_model.entry(name).or_default() += cost;
    }
}

#[derive(Default)]
struct Budgets {
    api: Option<Budget>,
    vibe: Option<Budget>,
}

struct Budget {
    usage_percentage: f64,
    limit: f64,
    currency: String,
    resets_at: Option<std::time::SystemTime>,
}

/// The subscription page is a Next.js page whose server data arrives as
/// `self.__next_f.push([1, "…"])` chunks. Joined, they form rows like
/// `7:["$",…,{"budget":{"api_budget":{…},"vibe_budget":{…}}}]`.
fn budgets(html: &str) -> Budgets {
    let mut stream = String::new();
    let mut rest = html;
    while let Some(at) = rest.find(FLIGHT) {
        rest = rest[at + FLIGHT.len()..].trim_start();
        let mut values = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
        let Some(Ok(Value::Array(push))) = values.next() else {
            continue;
        };
        rest = &rest[values.byte_offset()..];
        if push.first().and_then(Value::as_i64) == Some(1)
            && let Some(Value::String(chunk)) = push.get(1)
        {
            stream.push_str(chunk);
        }
    }
    for line in stream.lines() {
        let Some((id, row)) = line.split_once(':') else {
            continue;
        };
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        if !row.starts_with(['[', '{']) {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(row) else {
            continue;
        };
        if let Some(found) = find_budgets(&row) {
            return found;
        }
    }
    Budgets::default()
}

fn find_budgets(value: &Value) -> Option<Budgets> {
    match value {
        Value::Object(map) => {
            if let Some(budget) = map.get("budget") {
                let found = Budgets {
                    api: budget.get("api_budget").and_then(budget_of),
                    vibe: budget.get("vibe_budget").and_then(budget_of),
                };
                if found.api.is_some() || found.vibe.is_some() {
                    return Some(found);
                }
            }
            map.values().find_map(find_budgets)
        }
        Value::Array(items) => items.iter().find_map(find_budgets),
        _ => None,
    }
}

fn budget_of(value: &Value) -> Option<Budget> {
    let usage_percentage = value
        .get("usage_percentage")?
        .as_f64()
        .filter(|percent| percent.is_finite() && *percent >= 0.)?;
    let limit = value
        .get("initial_budget")?
        .as_f64()
        .filter(|limit| limit.is_finite() && *limit > 0.)?;
    let currency = value.get("currency")?.as_str()?.trim().to_uppercase();
    if currency.is_empty() {
        return None;
    }
    let resets_at = value
        .get("reset_at")
        .and_then(Value::as_str)
        .and_then(|text| Timestamp::Text(text.to_owned()).time());
    Some(Budget {
        usage_percentage,
        limit,
        currency,
        resets_at,
    })
}

#[derive(Deserialize)]
struct Billing {
    completion: Option<Lanes>,
    chat: Option<Lanes>,
    vibe_code: Option<VibeCode>,
    ocr: Option<Lanes>,
    connectors: Option<Lanes>,
    audio: Option<Lanes>,
    libraries_api: Option<Libraries>,
    fine_tuning: Option<FineTuning>,
    currency: Option<String>,
    #[serde(default)]
    prices: Vec<Price>,
}

#[derive(Deserialize)]
struct Lanes {
    #[serde(default)]
    models: BTreeMap<String, ModelUsage>,
}

#[derive(Deserialize)]
struct VibeCode {
    completion: Option<Lanes>,
}

#[derive(Deserialize)]
struct Libraries {
    pages: Option<Lanes>,
    tokens: Option<Lanes>,
}

#[derive(Deserialize)]
struct FineTuning {
    #[serde(default)]
    training: BTreeMap<String, ModelUsage>,
    #[serde(default)]
    storage: BTreeMap<String, ModelUsage>,
}

#[derive(Deserialize)]
struct ModelUsage {
    #[serde(default)]
    input: Vec<Entry>,
    #[serde(default)]
    output: Vec<Entry>,
    #[serde(default)]
    cached: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    billing_metric: Option<String>,
    billing_group: Option<String>,
    billing_display_name: Option<String>,
    #[serde(default, deserialize_with = "number")]
    value: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    value_paid: Option<f64>,
}

#[derive(Deserialize)]
struct Price {
    billing_metric: Option<String>,
    billing_group: Option<String>,
    price: Option<String>,
}

#[derive(Deserialize)]
struct Credits {
    wallet_amount: f64,
    credit_notes_amount: Option<f64>,
    ongoing_usage_balance: Option<f64>,
    currency: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const NOVEMBER: &str = r#"{"completion":{"models":{"mistral-large-latest::mistral-large-2411":{"input":[{"usage_type":"usage","event_type":"api_tokens","billing_metric":"mistral-large-2411","billing_display_name":"mistral-large-latest","billing_group":"input","timestamp":"2025-11-14","value":11121,"value_paid":11121}],"output":[{"usage_type":"usage","event_type":"api_tokens","billing_metric":"mistral-large-2411","billing_display_name":"mistral-large-latest","billing_group":"output","timestamp":"2025-11-14","value":1115,"value_paid":1115}]},"mistral-small-latest::mistral-small-2506":{"input":[{"usage_type":"usage","event_type":"api_tokens","billing_metric":"mistral-small-2506","billing_display_name":"mistral-small-latest","billing_group":"input","timestamp":"2025-11-14","value":20,"value_paid":20},{"usage_type":"usage","event_type":"api_tokens","billing_metric":"mistral-small-2506","billing_display_name":"mistral-small-latest","billing_group":"input","timestamp":"2025-11-24","value":100,"value_paid":100}],"output":[{"usage_type":"usage","event_type":"api_tokens","billing_metric":"mistral-small-2506","billing_display_name":"mistral-small-latest","billing_group":"output","timestamp":"2025-11-14","value":500,"value_paid":500},{"usage_type":"usage","event_type":"api_tokens","billing_metric":"mistral-small-2506","billing_display_name":"mistral-small-latest","billing_group":"output","timestamp":"2025-11-24","value":2482,"value_paid":2482}]}}},"ocr":{"models":{}},"connectors":{"models":{}},"libraries_api":{"pages":{"models":{}},"tokens":{"models":{}}},"fine_tuning":{"training":{},"storage":{}},"audio":{"models":{}},"vibe_usage":0.0,"date":"2025-11-01T00:00:00Z","previous_month":"2025-10","next_month":"2025-12","start_date":"2025-11-01T00:00:00Z","end_date":"2025-11-30T23:59:59.999Z","currency":"EUR","currency_symbol":"€","prices":[{"event_type":"api_tokens","billing_metric":"mistral-large-2411","billing_group":"input","price":"0.0000017000"},{"event_type":"api_tokens","billing_metric":"mistral-large-2411","billing_group":"output","price":"0.0000051000"},{"event_type":"api_tokens","billing_metric":"mistral-small-2506","billing_group":"input","price":"8.50E-8"},{"event_type":"api_tokens","billing_metric":"mistral-small-2506","billing_group":"output","price":"2.550E-7"}]}"#;

    fn flight(chunk: &str) -> String {
        let push = serde_json::to_string(&serde_json::json!([1, chunk])).unwrap();
        format!("<script>self.__next_f.push({push})</script>")
    }

    const RECORD: &str = concat!(
        r#"7:["$","$L1",null,{"budget":{"api_budget":{"usage_percentage":2.0,"initial_budget":25.5,"currency":"eur","reset_at":"2026-10-01T00:00:00.000Z","payg_enabled":false},"vibe_budget":{"usage_percentage":0.0,"initial_budget":255.0,"currency":"eur","reset_at":"2026-10-01T00:00:00.000Z","payg_enabled":false}}}]"#,
        "\n"
    );

    #[test]
    fn billing_usage_prices_tokens() {
        let report = parse(NOVEMBER, None, None).unwrap();
        let expected = 0.0189057 + 0.0056865 + 0.0000102 + 0.00076041;
        assert_eq!(report.balances[0].label, "API spend this month");
        assert!((report.balances[0].amount - expected).abs() < 1e-9);
        assert_eq!(report.balances[0].unit, Unit::Currency("EUR".into()));
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected token facts");
        };
        assert_eq!(facts[0], ("Input".to_owned(), "11,241".to_owned()));
        assert_eq!(facts[1], ("Output".to_owned(), "4,097".to_owned()));
        assert_eq!(facts[2], ("Cached".to_owned(), "0".to_owned()));
        assert_eq!(facts[3], ("Models".to_owned(), "2".to_owned()));
        let Some(Section::Shares { shares, .. }) = report.sections.get(1) else {
            panic!("expected model shares");
        };
        assert_eq!(shares[0].0, "mistral-large-latest");
        assert!(report.windows.is_empty());
    }

    #[test]
    fn subscription_allowances_and_credits() {
        let split = RECORD.len() / 2;
        let html = flight(&RECORD[..split]) + &flight(&RECORD[split..]);
        let credits = r#"{"wallet_amount": 10.0, "credit_notes_amount": 5.0,
            "ongoing_usage_balance": 2.5, "currency": "eur"}"#;
        let report = parse(NOVEMBER, Some(credits), Some(&html)).unwrap();
        let api = &report.windows[0];
        assert_eq!(api.kind, Kind::Named("Included API".into()));
        assert!((api.used - 2.).abs() < 1e-4);
        assert!(api.resets_at.is_some());
        assert_eq!(api.length, Some(MONTH));
        assert_eq!(report.windows[1].kind, Kind::Named("Vibe".into()));
        assert_eq!(
            report.balances[1],
            Balance::new("Credits", 12.5, Unit::Currency("EUR".into()))
        );
        let Some(Section::Facts { title, facts }) = report.sections.first() else {
            panic!("expected allowance facts");
        };
        assert_eq!(title, "Allowances");
        assert_eq!(facts[0].1, "0.51 EUR of 25.50 EUR used");
    }

    #[test]
    fn page_without_budget_has_no_allowances() {
        let report = parse(NOVEMBER, Some("not json"), Some("<html></html>")).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances.len(), 1);
        assert!(matches!(
            parse("[]", None, None),
            Err(crate::Error::UsageJson(_))
        ));
    }
}
