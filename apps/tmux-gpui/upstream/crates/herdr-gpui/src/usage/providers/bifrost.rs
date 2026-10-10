//! Bifrost gateway budgets and rate limits from the self-service virtual-key
//! quota endpoint, read with the virtual key (the `api_key` setting or
//! `BIFROST_API_KEY`, here or on the probed host) at the configured
//! `base_url`. No admin credential is used. Everything CodexBar reads is
//! ported; the per-budget list and model rows are shown as facts.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values,
    },
};
use serde::Deserialize;
use std::{
    cmp::Ordering,
    time::{Duration, SystemTime},
};

const QUOTA_PATH: &str = "/api/governance/virtual-keys/quota";
/// Model rows shown before the rest fold into "Other models".
const TOP_MODELS: usize = 5;

pub(crate) struct Bifrost;

static META: Meta = Meta::new("bifrost", "Bifrost").settings(&[
    Setting::new(
        "api_key",
        &["BIFROST_API_KEY"],
        "Your Bifrost virtual key (vk-…), from the gateway's Virtual Keys page. It is \
             sent as the x-bf-vk header to base_url only.",
    ),
    Setting::new(
        "base_url",
        &["BIFROST_BASE_URL"],
        "Your Bifrost gateway's URL, e.g. https://bifrost.example.com. Bifrost has no \
             public host. It must be HTTPS unless it is on localhost, a private network, \
             or a .local host.",
    ),
]);

impl Service for Bifrost {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("BIFROST_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = probe
        .text_setting("base_url")
        .filter(|base| !base.is_empty())
        .ok_or(Error::UsageNotSignedIn)?;
    let request = Request::get(quota_url(&base)?)
        .secret_header("x-bf-vk", "", key)
        .header("Accept", "application/json");
    let body = probe.body(request)?;
    parse(&body, SystemTime::now())
}

fn quota_url(raw: &str) -> Result<String> {
    let mut url = values::gateway(raw)?;
    let path = format!("{}{QUOTA_PATH}", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn text(value: Option<&String>) -> Option<&str> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let root: Root = json(body)?;
    let mut scopes: Vec<(Option<String>, &Limits)> = vec![(None, &root.limits)];
    for (index, config) in root.provider_configs.iter().enumerate() {
        let name =
            text(config.provider.as_ref()).map_or_else(|| (index + 1).to_string(), str::to_owned);
        scopes.push((Some(format!("Provider {name}")), &config.limits));
    }
    for (index, config) in root.model_configs.iter().enumerate() {
        let model =
            text(config.model_name.as_ref()).map_or_else(|| (index + 1).to_string(), str::to_owned);
        let name = match text(config.provider.as_ref()) {
            Some(provider) => format!("{provider} · {model}"),
            None => model,
        };
        scopes.push((Some(format!("Model {name}")), &config.limits));
    }

    let mut budgets: Vec<Budget> = Vec::new();
    for (scope, limits) in &scopes {
        for row in &limits.budgets {
            let Some(id) = text(row.id.as_ref()) else {
                continue;
            };
            let amount = row.override_amount.unwrap_or(0.);
            let cycles = row.override_cycles_remaining.unwrap_or(0.);
            let active = amount > 0.
                && match text(row.override_mode.as_ref()) {
                    Some("forever") => true,
                    Some("cycles") => cycles > 0.,
                    _ => false,
                };
            let limit = row.max_limit.unwrap_or(0.) + if active { amount } else { 0. };
            if !limit.is_finite() {
                return Err(values::invalid());
            }
            budgets.push(Budget {
                id: id.to_owned(),
                scope: scope.clone(),
                source: text(row.source_name.as_ref()).map(str::to_owned),
                limit,
                used: row.current_usage.unwrap_or(0.),
                timing: Timing::new(
                    text(row.reset_duration.as_ref()),
                    text(row.last_reset.as_ref()),
                    now,
                ),
                models: &row.per_model_usage,
            });
        }
    }
    budgets.sort_by(|a, b| {
        let seconds = |budget: &Budget| budget.timing.seconds.unwrap_or(f64::INFINITY);
        seconds(a)
            .partial_cmp(&seconds(b))
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut rate_limits = Vec::new();
    let mut unknown_limits = Vec::new();
    for (scope, limits) in &scopes {
        // `rate_limit` merges the components; it is no separate pool.
        let selected: Vec<&RateLimit> = if limits.rate_limits.is_empty() {
            limits.rate_limit.iter().collect()
        } else {
            limits.rate_limits.iter().collect()
        };
        for limit in selected {
            for (dimension, max, used, reset, last) in [
                (
                    "Tokens",
                    limit.token_max_limit,
                    limit.token_current_usage,
                    &limit.token_reset_duration,
                    &limit.token_last_reset,
                ),
                (
                    "Requests",
                    limit.request_max_limit,
                    limit.request_current_usage,
                    &limit.request_reset_duration,
                    &limit.request_last_reset,
                ),
            ] {
                let known = max.is_some_and(|max| max > 0.);
                let reset = text(reset.as_ref());
                // Last-reset times come even for dimensions nobody configured.
                if !known && reset.is_none() {
                    continue;
                }
                let title = [
                    scope.as_deref(),
                    text(limit.source_name.as_ref()),
                    Some(dimension),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
                let timing = Timing::new(reset, text(last.as_ref()), now);
                match max.filter(|_| known) {
                    Some(max) => rate_limits.push(Section::Limit(Window::new(
                        Kind::Named(title),
                        used.unwrap_or(0.) / max * 100.,
                        timing.resets_at,
                        timing.length,
                    ))),
                    None => unknown_limits.push((title, "Unavailable".to_owned())),
                }
            }
        }
    }
    let inactive = root.is_active == Some(false);
    if inactive && budgets.is_empty() && rate_limits.is_empty() && unknown_limits.is_empty() {
        return Err(Error::UsageRejected);
    }

    let mut windows = Vec::new();
    let mut scoped = Vec::new();
    for budget in budgets.iter().filter(|budget| budget.limit > 0.) {
        let window = budget.window();
        if budget.scope.is_some() {
            scoped.push(Section::Limit(window));
        } else {
            windows.push(window);
        }
    }
    let first = budgets.iter().find(|budget| budget.scope.is_none());
    let balance = first.map(|budget| {
        let label = budget.timing.label.map_or_else(
            || if budget.limit > 0. { "Budget" } else { "Spend" }.to_owned(),
            str::to_owned,
        );
        let balance = Balance::new(label, budget.used, Unit::Currency("USD".into()));
        if budget.limit > 0. {
            balance.out_of(budget.limit)
        } else {
            balance
        }
    });

    let mut sections = scoped;
    sections.extend(rate_limits);
    if !unknown_limits.is_empty() {
        sections.push(Section::Facts {
            title: "Rate limits".into(),
            facts: unknown_limits,
        });
    }
    if inactive {
        sections.insert(
            0,
            Section::Facts {
                title: "Virtual key".into(),
                facts: vec![("Status".into(), "Inactive".into())],
            },
        );
    }
    if let Some(models) = first.and_then(|budget| models(budget.models)) {
        sections.push(models);
    }
    if budgets.len() > 1 || budgets.iter().any(|budget| budget.scope.is_some()) {
        sections.push(Section::Facts {
            title: "Budgets".into(),
            facts: budgets.iter().take(24).map(Budget::fact).collect(),
        });
    }
    let account = Account {
        email: text(root.virtual_key_name.as_ref()).map(str::to_owned),
        plan: first.and_then(|budget| budget.source.clone()),
    };
    Ok(Report::new(Provider(&Bifrost), account, windows)
        .with_balances(balance)
        .with_sections(sections))
}

struct Budget<'a> {
    id: String,
    scope: Option<String>,
    source: Option<String>,
    limit: f64,
    used: f64,
    timing: Timing,
    models: &'a [ModelUsage],
}

impl Budget<'_> {
    fn title(&self) -> String {
        [
            self.scope.as_deref(),
            Some(self.source.as_deref().unwrap_or("Budget")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
    }

    fn window(&self) -> Window {
        let kind = match (self.timing.label, &self.source, &self.scope) {
            (Some("Daily"), None, None) => Kind::Daily,
            (Some("Weekly"), None, None) => Kind::Weekly,
            (Some("Monthly"), None, None) => Kind::Monthly,
            (label, _, _) => Kind::Named(
                [Some(self.title()), label.map(str::to_owned)]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
            ),
        };
        let length = self.timing.length.or_else(|| kind.length());
        Window::new(
            kind,
            self.used / self.limit * 100.,
            self.timing.resets_at,
            length,
        )
    }

    fn fact(&self) -> (String, String) {
        let label = match self.source {
            Some(_) => self.title(),
            None => format!("{} {}", self.title(), self.id),
        };
        let mut value = if self.limit > 0. {
            format!("${:.2} / ${:.2}", self.used, self.limit)
        } else {
            format!("${:.2}", self.used)
        };
        if let Some(period) = self.timing.label {
            value.push_str(" · ");
            value.push_str(period);
        }
        (label, value)
    }
}

/// When a budget or limit resets. Calendar periods (`1d`, `1M`, …) depend on
/// an alignment policy the answer omits, so only fixed durations such as
/// `1h30m` get a reset time and a length.
struct Timing {
    seconds: Option<f64>,
    resets_at: Option<SystemTime>,
    length: Option<Duration>,
    label: Option<&'static str>,
}

impl Timing {
    fn new(raw: Option<&str>, last: Option<&str>, now: SystemTime) -> Self {
        let seconds = raw.and_then(duration);
        let fixed = raw.is_some_and(|raw| !raw.ends_with(['d', 'w', 'M', 'Q', 'Y']));
        let length = seconds
            .filter(|seconds| fixed && *seconds >= 60.)
            .map(|seconds| Duration::from_secs((seconds / 60.).floor() as u64 * 60));
        let resets_at = seconds.filter(|_| fixed).and_then(|seconds| {
            let start = Timestamp::Text(last?.to_owned()).time()?;
            let elapsed = now.duration_since(start).unwrap_or_default().as_secs_f64();
            let cycles = (elapsed / seconds).floor() + 1.;
            start.checked_add(Duration::try_from_secs_f64(cycles * seconds).ok()?)
        });
        let label = match raw {
            Some("1h") => Some("Hourly"),
            Some("1d") => Some("Daily"),
            Some("1w") => Some("Weekly"),
            Some("1M") => Some("Monthly"),
            Some("1Q") => Some("Quarterly"),
            Some("1Y") => Some("Yearly"),
            _ => None,
        };
        Self {
            seconds,
            resets_at,
            length,
            label,
        }
    }
}

/// Bifrost's durations: a calendar count such as `1M`, or a Go duration
/// such as `1h30m`.
fn duration(raw: &str) -> Option<f64> {
    const CALENDAR: [(char, f64); 5] = [
        ('d', 86_400.),
        ('w', 604_800.),
        ('M', 2_592_000.),
        ('Q', 7_776_000.),
        ('Y', 31_536_000.),
    ];
    const GO: [(&str, f64); 8] = [
        ("ns", 1e-9),
        ("us", 1e-6),
        ("µs", 1e-6),
        ("μs", 1e-6),
        ("ms", 1e-3),
        ("s", 1.),
        ("m", 60.),
        ("h", 3600.),
    ];
    let number_end = |text: &str| {
        text.find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(text.len())
    };
    let seconds = if let Some((unit, scale)) = CALENDAR
        .iter()
        .find(|(unit, _)| raw.ends_with(*unit))
        .copied()
    {
        let count = &raw[..raw.len() - unit.len_utf8()];
        if count.is_empty() || number_end(count) != count.len() {
            return None;
        }
        count.parse::<f64>().ok()? * scale
    } else {
        let mut rest = raw;
        let mut total = 0.;
        while !rest.is_empty() {
            let end = number_end(rest);
            let value: f64 = rest[..end].parse().ok()?;
            rest = &rest[end..];
            // Longest unit first, so "ms" is not read as "m".
            let (unit, scale) = GO
                .iter()
                .filter(|(unit, _)| rest.starts_with(unit))
                .max_by_key(|(unit, _)| unit.len())?;
            rest = &rest[unit.len()..];
            total += value * scale;
        }
        total
    };
    (seconds.is_finite() && seconds > 0.).then_some(seconds)
}

/// The key-wide budget's model spend, costliest first.
fn models(rows: &[ModelUsage]) -> Option<Section> {
    let mut rows: Vec<(&str, f64, f64)> = rows
        .iter()
        .map(|row| {
            (
                text(row.model.as_ref()).unwrap_or("Model"),
                row.total_cost.unwrap_or(0.),
                row.total_tokens.unwrap_or(0.),
            )
        })
        .filter(|(_, cost, tokens)| *cost != 0. || *tokens != 0.)
        .collect();
    if rows.is_empty() {
        return None;
    }
    rows.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then(b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal))
            .then(a.0.cmp(b.0))
    });
    let mut facts: Vec<(String, String)> = rows
        .iter()
        .take(TOP_MODELS)
        .map(|(model, cost, tokens)| {
            (
                model_name(model),
                format!("${cost:.2} · {} tokens", token_count(*tokens)),
            )
        })
        .collect();
    if rows.len() > TOP_MODELS {
        facts.push(("Other models".into(), (rows.len() - TOP_MODELS).to_string()));
    }
    Some(Section::Facts {
        title: "Models".into(),
        facts,
    })
}

/// Strips Bedrock region and vendor prefixes and revision suffixes, which
/// Bifrost reports verbatim, e.g. `us.anthropic.claude-sonnet-4-v1:0`.
fn model_name(raw: &str) -> String {
    const REGIONS: [&str; 5] = ["us-gov.", "us.", "eu.", "apac.", "global."];
    const VENDORS: [&str; 13] = [
        "ai21.",
        "amazon.",
        "anthropic.",
        "cohere.",
        "deepseek.",
        "luma.",
        "meta.",
        "mistral.",
        "openai.",
        "qwen.",
        "stability.",
        "twelvelabs.",
        "writer.",
    ];
    let strip = |name: &str, prefixes: &[&str]| -> String {
        prefixes
            .iter()
            .find(|prefix| {
                name.get(..prefix.len())
                    .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
            })
            .map_or_else(|| name.to_owned(), |prefix| name[prefix.len()..].to_owned())
    };
    let mut name = strip(&strip(raw, &REGIONS[..]), &VENDORS[..]);
    if let Some(index) = name.rfind("-v")
        && name[index + 2..]
            .split_once(':')
            .is_some_and(|(major, minor)| {
                !major.is_empty()
                    && !minor.is_empty()
                    && major.chars().all(|c| c.is_ascii_digit())
                    && minor.chars().all(|c| c.is_ascii_digit())
            })
    {
        name.truncate(index);
    }
    if name.is_empty() {
        raw.to_owned()
    } else {
        name
    }
}

fn token_count(value: f64) -> String {
    let magnitude = value.abs();
    for (threshold, divisor, unit) in [
        (999_500_000., 1e9, "B"),
        (999_500., 1e6, "M"),
        (1000., 1e3, "K"),
    ] {
        if magnitude >= threshold {
            let scaled = value / divisor;
            let digits = if scaled.abs() >= 10. { 0 } else { 1 };
            let text = format!("{scaled:.digits$}");
            let text = text.strip_suffix(".0").unwrap_or(&text);
            return format!("{text}{unit}");
        }
    }
    format!("{}", value.trunc())
}

#[derive(Deserialize)]
struct Root {
    is_active: Option<bool>,
    virtual_key_name: Option<String>,
    #[serde(flatten)]
    limits: Limits,
    #[serde(default, deserialize_with = "list")]
    provider_configs: Vec<ScopeConfig>,
    #[serde(default, deserialize_with = "list")]
    model_configs: Vec<ScopeConfig>,
}

#[derive(Deserialize)]
struct ScopeConfig {
    provider: Option<String>,
    model_name: Option<String>,
    #[serde(flatten)]
    limits: Limits,
}

#[derive(Deserialize)]
struct Limits {
    #[serde(default, deserialize_with = "list")]
    budgets: Vec<BudgetRow>,
    rate_limit: Option<RateLimit>,
    #[serde(default, deserialize_with = "list")]
    rate_limits: Vec<RateLimit>,
}

#[derive(Deserialize)]
struct BudgetRow {
    id: Option<String>,
    max_limit: Option<f64>,
    current_usage: Option<f64>,
    reset_duration: Option<String>,
    last_reset: Option<String>,
    source_name: Option<String>,
    override_amount: Option<f64>,
    override_mode: Option<String>,
    override_cycles_remaining: Option<f64>,
    #[serde(default, deserialize_with = "list")]
    per_model_usage: Vec<ModelUsage>,
}

#[derive(Deserialize)]
struct RateLimit {
    source_name: Option<String>,
    token_max_limit: Option<f64>,
    token_current_usage: Option<f64>,
    token_reset_duration: Option<String>,
    token_last_reset: Option<String>,
    request_max_limit: Option<f64>,
    request_current_usage: Option<f64>,
    request_reset_duration: Option<String>,
    request_last_reset: Option<String>,
}

#[derive(Deserialize)]
struct ModelUsage {
    model: Option<String>,
    total_cost: Option<f64>,
    total_tokens: Option<f64>,
}

/// A list that Bifrost may send as `null`.
fn list<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
