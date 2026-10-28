//! OpenRouter credits and API key spend, read with an API key: the `api_key`
//! setting (or `OPENROUTER_API_KEY` here), else `OPENROUTER_API_KEY` on the
//! probed host. The key's own spending cap is the headline window, the
//! account's prepaid credits the balance, and daily, weekly, and monthly key
//! spend are facts. With a Management API key (the `management_api_key`
//! setting, or the main key when OpenRouter says it is one) the last 30 days
//! of account activity are summed as well.
//!
//! Everything CodexBar reads is ported. CodexBar also fetches the latest
//! completed day's activity separately to fill a history chart; only the
//! 30-day totals are shown here.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
        values::{https_base, invalid, usd},
    },
};
use serde::Deserialize;
use std::collections::BTreeSet;

const BASE: &str = "https://openrouter.ai/api/v1";
/// Activity is only ever asked of OpenRouter itself: a management key must
/// never follow a configurable base URL to a proxy.
const ACTIVITY: &str = "https://openrouter.ai/api/v1/activity";

pub(crate) struct Openrouter;

static META: Meta = Meta::new("openrouter", "OpenRouter")
    .dashboard("https://openrouter.ai/activity")
    .status_page("https://status.openrouter.ai")
    .settings(&[
        Setting::new(
            "api_key",
            &["OPENROUTER_API_KEY"],
            "An OpenRouter API key (sk-or-v1-…) from https://openrouter.ai/settings/keys. \
             A Management API key also works and adds the last 30 days of activity.",
        ),
        Setting::new(
            "management_api_key",
            &["OPENROUTER_MANAGEMENT_API_KEY"],
            "Optional Management API key from https://openrouter.ai/settings/management-keys, \
             used only for the last 30 days of account activity.",
        ),
        Setting::new(
            "base_url",
            &["OPENROUTER_API_URL"],
            "Optional HTTPS API URL for a proxy. Defaults to https://openrouter.ai/api/v1.",
        ),
        Setting::new(
            "http_referer",
            &["OPENROUTER_HTTP_REFERER"],
            "Optional client URL sent as the HTTP-Referer header.",
        ),
        Setting::new(
            "x_title",
            &["OPENROUTER_X_TITLE"],
            "Optional client title sent as the X-Title header. Defaults to Herdr.",
        ),
    ]);

impl Service for Openrouter {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("OPENROUTER_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    // An override must stay on HTTPS: the key is attached to it.
    let base = https_base(probe.text_setting("base_url"), BASE)?;
    let title = probe
        .text_setting("x_title")
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Herdr".into());
    let referer = probe
        .text_setting("http_referer")
        .filter(|referer| !referer.is_empty());
    let request = |url: String| {
        let request = Request::get(url)
            .bearer(key)
            .header("Accept", "application/json")
            .header("X-Title", title.as_str());
        match &referer {
            Some(referer) => request.header("HTTP-Referer", referer.as_str()),
            None => request,
        }
    };
    // Either answer alone is worth showing, as CodexBar keeps whichever
    // arrived; only when both fail is the key's failure reported.
    let credits = probe.body(request(format!("{base}/credits")));
    let key_info = probe.body(request(format!("{base}/key")));
    let key_info = match (key_info, &credits) {
        (Err(error), Err(_)) => return Err(error),
        (key_info, _) => key_info.ok(),
    };
    let management = probe.setting("management_api_key").or_else(|| {
        (base == BASE
            && key_info
                .as_deref()
                .and_then(|body| parse_key(body).ok())
                .is_some_and(|data| data.is_management_key == Some(true)))
        .then(|| key.clone())
    });
    let activity = management.and_then(|management| {
        probe
            .body(
                Request::get(ACTIVITY)
                    .bearer(&management)
                    .header("Accept", "application/json"),
            )
            .ok()
    });
    parse(
        key_info.as_deref(),
        credits.ok().as_deref(),
        activity.as_deref(),
    )
}

/// Builds the report from whichever of the three answers arrived. Optional
/// answers that do not parse are left out rather than failing the rest.
pub(crate) fn parse(
    key: Option<&str>,
    credits: Option<&str>,
    activity: Option<&str>,
) -> Result<Report> {
    let key = key.map(parse_key).transpose();
    let credits = credits
        .map(|body| json::<Envelope<Credits>>(body).map(|envelope| envelope.data))
        .transpose();
    let (key, credits) = match (key, credits) {
        (Err(error), Err(_) | Ok(None)) | (Ok(None), Err(error)) => return Err(error),
        (key, credits) => (key.ok().flatten(), credits.ok().flatten()),
    };
    if key.is_none() && credits.is_none() {
        return Err(invalid());
    }
    let balance = credits.as_ref().map(|credits| {
        Balance::new(
            "Credits",
            (credits.total_credits - credits.total_usage).max(0.),
            Unit::Currency("USD".into()),
        )
        .out_of(credits.total_credits)
    });
    let mut windows = Vec::new();
    let mut sections = Vec::new();
    if let Some(key) = &key {
        windows.extend(key.window());
        sections.push(key.facts());
    }
    if let Some(activity) = activity.and_then(|body| json::<Envelope<Vec<Activity>>>(body).ok()) {
        sections.push(activity_facts(&activity.data));
    }
    let plan = key
        .as_ref()
        .and_then(|key| key.is_free_tier)
        .and_then(|free| free.then(|| "Free tier".to_owned()));
    Ok(Report::new(
        Provider(&Openrouter),
        Account { email: None, plan },
        windows,
    )
    .with_balances(balance)
    .with_sections(sections))
}

fn parse_key(body: &str) -> Result<KeyData> {
    Ok(json::<Envelope<KeyData>>(body)?.data)
}

fn activity_facts(rows: &[Activity]) -> Section {
    let spend: f64 = rows
        .iter()
        .map(|row| row.usage.unwrap_or(0.) + row.byok_usage_inference.unwrap_or(0.))
        .sum();
    let requests: f64 = rows.iter().filter_map(|row| row.requests).sum();
    let tokens: f64 = rows
        .iter()
        .map(|row| row.prompt_tokens.unwrap_or(0.) + row.completion_tokens.unwrap_or(0.))
        .sum();
    let models: BTreeSet<&str> = rows
        .iter()
        .filter_map(|row| row.model.as_deref())
        .filter(|model| !model.is_empty())
        .collect();
    Section::Facts {
        title: "Last 30 days".into(),
        facts: vec![
            ("Spend".into(), usd(spend)),
            ("Requests".into(), group(requests.round() as i64)),
            ("Tokens".into(), group(tokens.round() as i64)),
            ("Models".into(), models.len().to_string()),
        ],
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct Credits {
    total_credits: f64,
    total_usage: f64,
}

#[derive(Deserialize)]
struct KeyData {
    limit: Option<f64>,
    limit_remaining: Option<f64>,
    limit_reset: Option<String>,
    usage: Option<f64>,
    usage_daily: Option<f64>,
    usage_weekly: Option<f64>,
    usage_monthly: Option<f64>,
    is_free_tier: Option<bool>,
    is_management_key: Option<bool>,
}

impl KeyData {
    fn limit(&self) -> Option<f64> {
        self.limit.filter(|limit| *limit > 0.)
    }

    fn reset(&self) -> Option<&str> {
        self.limit_reset
            .as_deref()
            .map(str::trim)
            .filter(|reset| !reset.is_empty())
    }

    /// Spent against the cap: the reported remainder first, then the spend
    /// of the cap's own reset window, then all spend on the key.
    fn spent(&self, limit: f64) -> Option<f64> {
        if let Some(remaining) = self.limit_remaining {
            return Some(limit - remaining.clamp(0., limit));
        }
        let window = match self.reset() {
            Some("daily") => self.usage_daily,
            Some("weekly") => self.usage_weekly,
            Some("monthly") => self.usage_monthly,
            _ => None,
        };
        window.or(self.usage).filter(|spent| *spent >= 0.)
    }

    /// The cap is a spending limit, not the prepaid balance, so it only
    /// shows when the key has one.
    fn window(&self) -> Option<Window> {
        let limit = self.limit()?;
        let spent = self.spent(limit)?;
        let kind = match self.reset() {
            Some("daily") => Kind::Daily,
            Some("weekly") => Kind::Weekly,
            Some("monthly") => Kind::Monthly,
            _ => Kind::Named("API key limit".into()),
        };
        let length = kind.length();
        Some(Window::new(kind, spent / limit * 100., None, length))
    }

    fn facts(&self) -> Section {
        let mut facts = Vec::new();
        match self.limit() {
            Some(limit) => {
                facts.push(("Spending cap".into(), usd(limit)));
                if let Some(spent) = self.spent(limit) {
                    facts.push(("Cap remaining".into(), usd(limit - spent)));
                }
                if let Some(usage) = self.usage {
                    facts.push(("Key used".into(), usd(usage)));
                }
            }
            None => facts.push(("Spending cap".into(), "No limit configured".into())),
        }
        if let Some(reset) = self.reset() {
            facts.push(("Reset window".into(), reset.to_owned()));
        }
        for (label, value) in [
            ("Today", self.usage_daily),
            ("This week", self.usage_weekly),
            ("This month", self.usage_monthly),
        ] {
            if let Some(value) = value {
                facts.push((label.into(), usd(value)));
            }
        }
        Section::Facts {
            title: "API key".into(),
            facts,
        }
    }
}

#[derive(Deserialize)]
struct Activity {
    model: Option<String>,
    usage: Option<f64>,
    byok_usage_inference: Option<f64>,
    requests: Option<f64>,
    prompt_tokens: Option<f64>,
    completion_tokens: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// CodexBar's detail parity fixtures.
    const CREDITS: &str = r#"{"data":{"total_credits":100,"total_usage":40}}"#;
    const KEY: &str = r#"{"data":{"limit":20,"limit_remaining":15,"limit_reset":"monthly","usage":5,
        "usage_daily":1,"usage_weekly":2,"usage_monthly":4,
        "rate_limit":{"requests":120,"interval":"10s"}}}"#;
    const ACTIVITY_BODY: &str = r#"{"data":[
        {"date":"2026-08-17","model":"example-model","prompt_tokens":100,
         "completion_tokens":50,"reasoning_tokens":80,"requests":2,"usage":1},
        {"date":"2026-08-16","model":"other-model","prompt_tokens":1000,
         "completion_tokens":500,"requests":3,"usage":0.5}]}"#;

    #[test]
    fn reads_the_key_cap_credits_and_spend() {
        let report = parse(Some(KEY), Some(CREDITS), None).unwrap();
        assert_eq!(report.provider.id(), "openrouter");
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Monthly);
        assert_eq!(report.windows[0].percent(), 25);
        assert_eq!(report.balances[0].amount, 60.);
        assert_eq!(report.balances[0].total, Some(100.));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert!(facts.contains(&("Spending cap".into(), "$20.00".into())));
        assert!(facts.contains(&("Cap remaining".into(), "$15.00".into())));
        assert!(facts.contains(&("This month".into(), "$4.00".into())));
    }

    #[test]
    fn an_uncapped_key_has_no_window() {
        let report = parse(
            Some(r#"{"data":{"limit":null,"usage":3.5,"usage_monthly":1.25,"is_free_tier":true}}"#),
            None,
            None,
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert!(report.balances.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("Free tier"));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Spending cap".to_owned(), "No limit configured".to_owned())
        );
    }

    #[test]
    fn credits_alone_are_enough() {
        let report = parse(None, Some(CREDITS), None).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].text(), "$60.00 of $100.00");
    }

    #[test]
    fn sums_the_activity_rows() {
        let report = parse(Some(KEY), None, Some(ACTIVITY_BODY)).unwrap();
        let Some(Section::Facts { title, facts }) = report.sections.last() else {
            panic!("expected facts");
        };
        assert_eq!(title, "Last 30 days");
        assert_eq!(
            facts,
            &vec![
                ("Spend".to_owned(), "$1.50".to_owned()),
                ("Requests".to_owned(), "5".to_owned()),
                ("Tokens".to_owned(), "1,650".to_owned()),
                ("Models".to_owned(), "2".to_owned()),
            ]
        );
    }

    #[test]
    fn nothing_parsed_is_an_error() {
        assert!(parse(Some("{}"), Some("[]"), None).is_err());
        assert!(parse(None, None, None).is_err());
    }
}
