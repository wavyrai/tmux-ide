//! OpenAI API Platform spend, read with an organization Admin API key from
//! the config, `OPENAI_ADMIN_KEY`, or `OPENAI_API_KEY`, as CodexBar's bundled
//! `openai.js` plugin does. Daily cost buckets (grouped by line item) and
//! completion usage (grouped by model) come from the Admin API, optionally
//! scoped to one project. This is organization billing, not ChatGPT or Codex
//! plan limits, so there are no quota windows.
//!
//! When `balance_fallback` is `1` and no project is set, a key the Admin API
//! refuses falls back to the legacy, undocumented credit-grants balance, as
//! CodexBar's opt-in fallback does. There is no local sign-in: the Codex CLI's
//! ChatGPT sign-in is the separate Codex provider.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        ui::Ui,
        values::usd,
    },
};
use gpui::{AnyElement, App, div, prelude::*, px};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    time::SystemTime,
};

const BASE: &str = "https://api.openai.com";
const COSTS: &str = "/v1/organization/costs";
const COMPLETIONS: &str = "/v1/organization/usage/completions";
const GRANTS: &str = "https://api.openai.com/v1/dashboard/billing/credit_grants";
const DAY_SECONDS: i64 = 86_400;
/// The Admin API returns at most 31 daily buckets per request.
const RANGE_DAYS: i64 = 31;
const PAGES: usize = 20;
const DEFAULT_DAYS: i64 = 30;
/// Days drawn in the panel's daily spend chart.
const CHART_DAYS: usize = 14;
const TOP: usize = 5;

pub(crate) struct Openai;

/// Daily spend for the panel's chart, oldest first.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Daily {
    pub days: Vec<(String, f64)>,
}

static META: Meta = Meta::new("openai", "OpenAI")
    .icon("icons/agent-codex.svg")
    .dashboard("https://platform.openai.com/usage")
    .status_page("https://status.openai.com")
    .settings(&[
        Setting::new(
            "api_key",
            &["OPENAI_ADMIN_KEY", "OPENAI_API_KEY"],
            "An organization Admin API key (sk-admin-...), created by an organization owner \
             at https://platform.openai.com/settings/organization/admin-keys. Project and \
             service-account keys cannot read organization usage.",
        ),
        Setting::new(
            "project_id",
            &["OPENAI_PROJECT_ID"],
            "Optional. A project ID (proj_...) from \
             https://platform.openai.com/settings/organization/projects to limit spend and \
             usage to that project.",
        ),
        Setting::new(
            "history_days",
            &["OPENAI_HISTORY_DAYS"],
            "Optional. How many days of spend to total, 1 to 365. Defaults to 30.",
        ),
        Setting::new(
            "balance_fallback",
            &["OPENAI_ALLOW_BALANCE_FALLBACK"],
            "Optional. Set to 1 to show the legacy prepaid credit balance when the key \
             cannot read organization usage (older user API keys). Ignored with project_id.",
        ),
    ]);

impl Service for Openai {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        let project = probe
            .text_setting("project_id")
            .filter(|project| !project.is_empty());
        let days = probe
            .text_setting("history_days")
            .and_then(|days| days.parse::<i64>().ok())
            .map_or(DEFAULT_DAYS, |days| days.clamp(1, 365));
        let fallback = probe
            .text_setting("balance_fallback")
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        let now = unix_now();
        let usage = admin_usage(probe, &key, project.as_deref(), days, now);
        Some(match usage {
            Err(error) if fallback && project.is_none() => {
                let balance = probe
                    .body(Request::get(GRANTS).bearer(&key))
                    .and_then(|body| parse_grants(&body, now));
                // A rejected Admin key says less than the balance endpoint's
                // own answer; any other Admin failure is the one to show.
                balance.map_err(|balance_error| {
                    if matches!(error, Error::UsageRejected) {
                        balance_error
                    } else {
                        error
                    }
                })
            }
            usage => usage,
        })
    }

    fn render(&self, report: &Report, ui: &Ui, _cx: &App) -> AnyElement {
        let standard = ui.standard(report);
        let Some(daily) = report
            .detail::<Daily>()
            .filter(|daily| !daily.days.is_empty())
        else {
            return standard;
        };
        let max = daily.days.iter().map(|(_, cost)| *cost).fold(0., f64::max);
        div()
            .flex()
            .flex_col()
            .child(standard)
            .child(ui.rule())
            .child(
                ui.block()
                    .child(ui.heading("Daily spend"))
                    .children(daily.days.iter().map(|(label, cost)| {
                        let fill = if max > 0. {
                            (cost / max * 100.) as f32
                        } else {
                            0.
                        };
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(ui.small())
                            .child(
                                div()
                                    .w(px(52.))
                                    .flex_none()
                                    .text_color(ui.muted())
                                    .child(label.clone()),
                            )
                            .child(div().flex_1().child(ui.bar(fill, 0., None)))
                            .child(
                                div()
                                    .w(px(64.))
                                    .flex_none()
                                    .flex()
                                    .justify_end()
                                    .child(format!("${cost:.2}")),
                            )
                    })),
            )
            .into_any_element()
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

fn admin_usage(
    probe: &mut Probe,
    key: &Secret,
    project: Option<&str>,
    days: i64,
    now: i64,
) -> Result<Report> {
    let mut tally = Tally::default();
    for (path, group_by) in [(COSTS, "line_item"), (COMPLETIONS, "model")] {
        for range in ranges(days, now) {
            let mut page: Option<String> = None;
            for _ in 0..PAGES {
                let url = query_url(path, range, group_by, project, page.as_deref());
                let body = probe.body(Request::get(url).bearer(key))?;
                let next = if path == COSTS {
                    tally.add_costs(&body)?
                } else {
                    tally.add_completions(&body)?
                };
                match next {
                    Some(next) if page.as_ref() != Some(&next) => page = Some(next),
                    _ => break,
                }
            }
        }
    }
    Ok(tally.report(now, days, project))
}

/// `(start, end, buckets)` spans covering `days` whole UTC days to today.
fn ranges(days: i64, now: i64) -> Vec<(i64, i64, i64)> {
    let today = now - now.rem_euclid(DAY_SECONDS);
    let mut cursor = today - (days - 1) * DAY_SECONDS;
    let mut remaining = days;
    let mut ranges = Vec::new();
    while remaining > 0 {
        let limit = remaining.min(RANGE_DAYS);
        ranges.push((cursor, cursor + limit * DAY_SECONDS, limit));
        cursor += limit * DAY_SECONDS;
        remaining -= limit;
    }
    ranges
}

fn query_url(
    path: &str,
    (start, end, limit): (i64, i64, i64),
    group_by: &str,
    project: Option<&str>,
    page: Option<&str>,
) -> String {
    let mut url = format!(
        "{BASE}{path}?start_time={start}&end_time={end}&bucket_width=1d&limit={limit}&group_by={group_by}"
    );
    if let Some(project) = project {
        url.push_str("&project_ids=");
        url.push_str(&encode(project));
    }
    if let Some(page) = page {
        url.push_str("&page=");
        url.push_str(&encode(page));
    }
    url
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Debug, Default)]
struct Day {
    cost: f64,
    requests: u64,
    input: u64,
    cached: u64,
    output: u64,
    lines: HashMap<String, f64>,
    models: HashMap<String, u64>,
}

/// Admin API buckets gathered by UTC day start.
#[derive(Debug, Default)]
pub(crate) struct Tally {
    days: BTreeMap<i64, Day>,
}

impl Tally {
    /// Adds one page of cost buckets; returns the next page cursor.
    pub(crate) fn add_costs(&mut self, body: &str) -> Result<Option<String>> {
        let page: Page<CostResult> = json(body)?;
        let next = page.next();
        for bucket in page.data {
            let day = self.days.entry(bucket.start_time).or_default();
            for result in bucket.results {
                let amount = result
                    .amount
                    .and_then(|amount| amount.value)
                    .filter(|value| value.is_finite())
                    .unwrap_or(0.);
                day.cost += amount;
                *day.lines.entry(name(result.line_item, "API")).or_default() += amount;
            }
        }
        Ok(next)
    }

    /// Adds one page of completion usage buckets; returns the next page cursor.
    pub(crate) fn add_completions(&mut self, body: &str) -> Result<Option<String>> {
        let page: Page<CompletionResult> = json(body)?;
        let next = page.next();
        for bucket in page.data {
            let day = self.days.entry(bucket.start_time).or_default();
            for result in bucket.results {
                let input = result.input_tokens + result.input_audio_tokens;
                let output = result.output_tokens + result.output_audio_tokens;
                day.requests += result.num_model_requests;
                day.input += input;
                day.cached += result.input_cached_tokens;
                day.output += output;
                *day.models
                    .entry(name(result.model, "Responses and Chat Completions"))
                    .or_default() += input + output;
            }
        }
        Ok(next)
    }

    pub(crate) fn report(self, now: i64, days: i64, project: Option<&str>) -> Report {
        let today = now - now.rem_euclid(DAY_SECONDS);
        let since = |count: i64| today - (count - 1) * DAY_SECONDS;
        let window: Vec<(&i64, &Day)> = self.days.range(since(days)..=now).collect();
        let spend = |from: i64| {
            window
                .iter()
                .filter(|(start, _)| **start >= from)
                .map(|(_, day)| day.cost)
                .sum::<f64>()
        };
        let total = spend(since(days));
        let label = if days == 1 {
            "Spend today".to_owned()
        } else {
            format!("Spend, last {days} days")
        };
        let mut lines: HashMap<&str, f64> = HashMap::new();
        let mut models: HashMap<&str, u64> = HashMap::new();
        let (mut requests, mut input, mut cached, mut output) = (0, 0, 0, 0);
        for (_, day) in &window {
            requests += day.requests;
            input += day.input;
            cached += day.cached;
            output += day.output;
            for (line, cost) in &day.lines {
                *lines.entry(line.as_str()).or_default() += *cost;
            }
            for (model, tokens) in &day.models {
                *models.entry(model.as_str()).or_default() += *tokens;
            }
        }
        let mut sections = vec![Section::Facts {
            title: "Spend".into(),
            facts: vec![
                ("Today".into(), usd(spend(today))),
                ("Last 7 days".into(), usd(spend(since(7)))),
            ],
        }];
        if requests > 0 || input + output > 0 {
            sections.push(Section::Facts {
                title: "Completions".into(),
                facts: vec![
                    ("Requests".into(), count(requests)),
                    ("Input tokens".into(), count(input)),
                    ("Cached input tokens".into(), count(cached)),
                    ("Output tokens".into(), count(output)),
                ],
            });
        }
        sections.extend(shares("Spend by line item", lines.into_iter()));
        sections.extend(shares(
            "Tokens by model",
            models
                .into_iter()
                .map(|(model, tokens)| (model, tokens as f64)),
        ));
        let chart = window
            .iter()
            .rev()
            .take(CHART_DAYS)
            .rev()
            .map(|(start, day)| (day_label(**start), day.cost.max(0.)))
            .collect();
        let account = Account {
            email: None,
            plan: Some(match project {
                Some(project) => format!("Admin API: {project}"),
                None => "Admin API".into(),
            }),
        };
        Report::new(Provider(&Openai), account, Vec::new())
            .with_balances([Balance::new(
                label,
                total.max(0.),
                Unit::Currency("USD".into()),
            )])
            .with_sections(sections)
            .with_detail(Daily { days: chart })
    }
}

/// The largest parts of a whole, as percentages of it.
fn shares<'a>(title: &str, parts: impl Iterator<Item = (&'a str, f64)>) -> Option<Section> {
    let mut parts: Vec<(&str, f64)> = parts.filter(|(_, value)| *value > 0.).collect();
    let whole: f64 = parts.iter().map(|(_, value)| value).sum();
    if whole <= 0. {
        return None;
    }
    parts.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    Some(Section::Shares {
        title: title.into(),
        shares: parts
            .into_iter()
            .take(TOP)
            .map(|(label, value)| (label.to_owned(), (value / whole * 100.) as f32))
            .collect(),
    })
}

fn name(value: Option<String>, fallback: &str) -> String {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn count(value: u64) -> String {
    group(i64::try_from(value).unwrap_or(i64::MAX))
}

fn day_label(start: i64) -> String {
    chrono::DateTime::from_timestamp(start, 0)
        .map(|at| at.format("%b %-d").to_string())
        .unwrap_or_default()
}

/// The legacy prepaid balance for keys without Admin API access.
pub(crate) fn parse_grants(body: &str, now: i64) -> Result<Report> {
    let grants: Grants = json(body)?;
    let expiry = grants
        .grants
        .map(|grants| grants.data)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|grant| grant.expires_at.as_ref().and_then(Timestamp::time))
        .filter(|at| {
            at.duration_since(SystemTime::UNIX_EPOCH)
                .is_ok_and(|since| since.as_secs() as i64 > now)
        })
        .min();
    let available = grants.total_available.max(0.);
    let mut balance = Balance::new("API credits left", available, Unit::Currency("USD".into()));
    if grants.total_granted > 0. {
        balance = balance.out_of(grants.total_granted);
    }
    let mut facts = vec![("Used".to_owned(), usd(grants.total_used))];
    if let Some(expiry) = expiry
        .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
        .and_then(|since| i64::try_from(since.as_secs()).ok())
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
    {
        facts.push(("Next expiry".into(), expiry.format("%Y-%m-%d").to_string()));
    }
    let account = Account {
        email: None,
        plan: Some("API balance".into()),
    };
    Ok(Report::new(Provider(&Openai), account, Vec::new())
        .with_balances([balance])
        .with_sections([Section::Facts {
            title: "Credit grants".into(),
            facts,
        }]))
}

#[derive(Deserialize)]
struct Page<T> {
    data: Vec<Bucket<T>>,
    #[serde(default)]
    has_more: bool,
    next_page: Option<String>,
}

impl<T> Page<T> {
    fn next(&self) -> Option<String> {
        self.has_more
            .then(|| self.next_page.as_deref().map(str::trim))
            .flatten()
            .filter(|page| !page.is_empty())
            .map(str::to_owned)
    }
}

#[derive(Deserialize)]
struct Bucket<T> {
    start_time: i64,
    #[serde(default = "Vec::new")]
    results: Vec<T>,
}

#[derive(Deserialize)]
struct CostResult {
    amount: Option<Amount>,
    line_item: Option<String>,
}

#[derive(Deserialize)]
struct Amount {
    #[serde(default, deserialize_with = "number")]
    value: Option<f64>,
}

#[derive(Deserialize)]
struct CompletionResult {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    input_cached_tokens: u64,
    #[serde(default)]
    input_audio_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    output_audio_tokens: u64,
    #[serde(default)]
    num_model_requests: u64,
    model: Option<String>,
}

#[derive(Deserialize)]
struct Grants {
    total_granted: f64,
    total_used: f64,
    total_available: f64,
    grants: Option<GrantList>,
}

#[derive(Deserialize)]
struct GrantList {
    #[serde(default)]
    data: Vec<Grant>,
}

#[derive(Deserialize)]
struct Grant {
    expires_at: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// 2026-09-24T12:00:00Z.
    const NOW: i64 = 1_790_251_200;
    const TODAY: i64 = NOW - NOW % DAY_SECONDS;
    const YESTERDAY: i64 = TODAY - DAY_SECONDS;

    fn costs() -> String {
        format!(
            r#"{{
              "object": "page",
              "data": [
                {{"object": "bucket", "start_time": {YESTERDAY}, "end_time": {TODAY}, "results": [
                  {{"object": "organization.costs.result", "amount": {{"value": 1.5, "currency": "usd"}}, "line_item": "gpt-4o, input"}},
                  {{"object": "organization.costs.result", "amount": {{"value": "0.5", "currency": "usd"}}, "line_item": "gpt-4o, output"}}
                ]}},
                {{"object": "bucket", "start_time": {TODAY}, "end_time": {}, "results": [
                  {{"object": "organization.costs.result", "amount": {{"value": 3.0, "currency": "usd"}}, "line_item": null}}
                ]}}
              ],
              "has_more": true,
              "next_page": "page_AAA"
            }}"#,
            TODAY + DAY_SECONDS
        )
    }

    fn completions() -> String {
        format!(
            r#"{{
              "object": "page",
              "data": [
                {{"object": "bucket", "start_time": {TODAY}, "end_time": {}, "results": [
                  {{"object": "organization.usage.completions.result", "input_tokens": 1000,
                    "input_cached_tokens": 200, "output_tokens": 500, "num_model_requests": 7,
                    "model": "gpt-4o-2024-08-06"}}
                ]}}
              ],
              "has_more": false,
              "next_page": null
            }}"#,
            TODAY + DAY_SECONDS
        )
    }

    #[test]
    fn totals_admin_costs_and_usage() {
        let mut tally = Tally::default();
        assert_eq!(
            tally.add_costs(&costs()).unwrap().as_deref(),
            Some("page_AAA")
        );
        assert_eq!(tally.add_completions(&completions()).unwrap(), None);
        let report = tally.report(NOW, 30, None);
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Spend, last 30 days");
        assert!((report.balances[0].amount - 5.0).abs() < 1e-9);
        assert_eq!(report.account.plan.as_deref(), Some("Admin API"));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected spend facts");
        };
        assert_eq!(facts[0], ("Today".into(), "$3.00".into()));
        assert_eq!(facts[1], ("Last 7 days".into(), "$5.00".into()));
        let Section::Facts { facts, .. } = &report.sections[1] else {
            panic!("expected completion facts");
        };
        assert_eq!(facts[0], ("Requests".into(), "7".into()));
        assert_eq!(facts[1], ("Input tokens".into(), "1,000".into()));
        let Section::Shares { shares, .. } = &report.sections[2] else {
            panic!("expected line item shares");
        };
        assert_eq!(shares[0].0, "API");
        assert_eq!(shares[0].1.round(), 60.);
        let daily = report.detail::<Daily>().unwrap();
        assert_eq!(daily.days.len(), 2);
        assert_eq!(daily.days[1].1, 3.0);
    }

    #[test]
    fn one_day_counts_only_today() {
        let mut tally = Tally::default();
        tally.add_costs(&costs()).unwrap();
        let report = tally.report(NOW, 1, Some("proj_abc"));
        assert_eq!(report.balances[0].label, "Spend today");
        assert!((report.balances[0].amount - 3.0).abs() < 1e-9);
        assert_eq!(report.account.plan.as_deref(), Some("Admin API: proj_abc"));
    }

    #[test]
    fn ranges_split_long_histories() {
        let spans = ranges(40, NOW);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].2, 31);
        assert_eq!(spans[1].2, 9);
        assert_eq!(spans[1].1, TODAY + DAY_SECONDS);
        let url = query_url(COSTS, spans[1], "line_item", Some("proj a"), Some("p/1"));
        assert!(url.ends_with("&group_by=line_item&project_ids=proj+a&page=p%2F1"));
    }

    #[test]
    fn parses_legacy_credit_grants() {
        let report = parse_grants(
            &format!(
                r#"{{"object": "credit_summary", "total_granted": 18.0, "total_used": 4.5,
                    "total_available": 13.5, "grants": {{"object": "list", "data": [
                    {{"grant_amount": 18.0, "used_amount": 4.5, "expires_at": {}}}]}}}}"#,
                NOW + 30 * DAY_SECONDS
            ),
            NOW,
        )
        .unwrap();
        let balance = &report.balances[0];
        assert_eq!(balance.amount, 13.5);
        assert_eq!(balance.total, Some(18.0));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected grant facts");
        };
        assert_eq!(facts[0], ("Used".into(), "$4.50".into()));
        assert_eq!(facts.len(), 2);
    }
}
