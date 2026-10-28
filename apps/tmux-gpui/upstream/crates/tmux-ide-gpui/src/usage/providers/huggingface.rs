//! Hugging Face usage: month-to-date Inference Providers charges, ZeroGPU
//! quota, and the account from `whoami-v2`, read with an access token. The
//! token is the host's `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN`, else the file
//! `hf auth login` saves (`$HF_TOKEN_PATH`, `$HF_HOME/token`,
//! `$XDG_CACHE_HOME/huggingface/token`, `~/.cache/huggingface/token`), else
//! the `api_key` setting. Fine-grained tokens need the Billing read
//! permission. The prepaid credit wallet is read from the billing page with
//! a huggingface.co session (the `cookie` setting, or Chrome and Safari when
//! Hugging Face is listed in `show_providers`), and only shown when that
//! session belongs to the same user as the token, as in CodexBar. CodexBar's
//! twelve-hour identity cache is not ported: `whoami-v2` is asked each
//! refresh, and its failure only leaves the account out.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window},
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use chrono::Datelike;
use serde::Deserialize;
use std::time::Duration;

const SITE: &str = "https://huggingface.co";
const AGENT: &str = "herdr-gpui";

pub(crate) struct Huggingface;

static META: Meta = Meta::new("huggingface", "Hugging Face")
    .dashboard("https://huggingface.co/settings/billing")
    .status_page("https://status.huggingface.co")
    .settings(&[
        Setting::new(
            "api_key",
            &[
                "CODEXBAR_HUGGINGFACE_API_KEY",
                "HF_TOKEN",
                "HUGGING_FACE_HUB_TOKEN",
            ],
            "A Hugging Face access token from https://huggingface.co/settings/tokens. A \
             classic read token works; a fine-grained token needs the Billing read \
             permission. Not needed when `hf auth login` has saved a token on the host.",
        ),
        Setting::new(
            "cookie",
            &[],
            "Optional, for the prepaid credit balance. Sign in at \
             https://huggingface.co/settings/billing with the token's account, open \
             Developer Tools > Application > Cookies > https://huggingface.co, and copy \
             the token cookie as \"token=value\" (or every cookie there as \
             \"name=value; name2=value2\").",
        ),
    ]);

impl Service for Huggingface {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let token = find_token(probe)?;
        Some(read(probe, &token))
    }
}

fn find_token(probe: &mut Probe) -> Option<Secret> {
    if let Some(token) = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]
        .into_iter()
        .find_map(|name| probe.env(name))
    {
        return Some(token);
    }
    // huggingface_hub derives its home from these in this order, and saves
    // the token without a trailing newline.
    let files = [
        HostPath::env_or("HF_TOKEN_PATH", ".cache/huggingface/token", ""),
        HostPath::env_or("HF_HOME", ".cache/huggingface", "token"),
        HostPath::env_or("XDG_CACHE_HOME", ".cache", "huggingface/token"),
    ];
    files
        .iter()
        .find_map(|path| probe.file(path))
        .or_else(|| probe.setting("api_key"))
}

fn read(probe: &mut Probe, token: &Secret) -> Result<Report> {
    let api = |path: &str| {
        Request::get(format!("{SITE}{path}"))
            .bearer(token)
            .header("User-Agent", AGENT)
    };
    let now = chrono::Utc::now();
    let end = now.timestamp();
    let start = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .map_or(end, |start| start.and_utc().timestamp());
    let billing = probe.body(api(&format!(
        "/api/settings/billing/usage-v2?startDate={start}&endDate={end}"
    )))?;
    let gpu = optional(probe, api("/api/spaces/zero-gpu/quota"));
    let whoami = optional(probe, api("/api/whoami-v2"));
    let profile = whoami
        .as_deref()
        .and_then(|body| json::<Profile>(body).ok());
    let prepaid = profile
        .as_ref()
        .and_then(Profile::user_id)
        .and_then(|user| wallet(probe, user));
    parse(&billing, gpu.as_deref(), profile, prepaid)
}

/// Quota and identity only enrich the charges, so their failures are dropped.
fn optional(probe: &mut Probe, request: Request) -> Option<String> {
    probe.body(request.timeout(Duration::from_secs(5))).ok()
}

/// The prepaid balance, when a browser session for the token's own user
/// is available. The billing page's display names are not proof of
/// ownership, so the same cookie asks `whoami-v2` without the token.
fn wallet(probe: &mut Probe, user: &str) -> Option<f64> {
    let cookie = probe.cookies(&["huggingface.co"], &[])?;
    let mut web = |path: &str, accept: &str| {
        probe
            .http(
                Request::get(format!("{SITE}{path}"))
                    .cookie(&cookie)
                    .header("Accept", accept)
                    .timeout(Duration::from_secs(5)),
            )
            .ok()
            .filter(|response| response.status == 200)
            .map(|response| response.body)
    };
    let balance = wallet_balance(&web("/settings/billing", "text/html")?)?;
    let profile = json::<Profile>(&web("/api/whoami-v2", "application/json")?).ok()?;
    (profile.user_id() == Some(user)).then_some(balance)
}

pub(crate) fn parse(
    billing: &str,
    gpu: Option<&str>,
    profile: Option<Profile>,
    wallet: Option<f64>,
) -> Result<Report> {
    let inference = json::<Billing>(billing)?
        .usage
        .and_then(|usage| usage.inference_providers)
        .ok_or_else(invalid)?;
    let amount = |value: Option<f64>| {
        value
            .filter(|value| value.is_finite() && *value >= 0.)
            .map(|value| value / 1e9)
    };
    let gross = amount(inference.used_nano_usd).ok_or_else(invalid)?;
    let included = amount(inference.included_nano_usd).ok_or_else(invalid)?;
    let limit = match inference.limit_nano_usd {
        Some(_) => amount(inference.limit_nano_usd).ok_or_else(invalid)?,
        None => 0.,
    };
    // Hugging Face's own billing page deducts the included amount.
    let billable = (gross - included).max(0.);
    let usd = |label: &str, value: f64| Balance::new(label, value, Unit::Currency("USD".into()));
    let mut facts = vec![("Billable usage".to_owned(), usd("", billable).amount_text())];
    if included > 0. {
        facts.push(("Gross inference usage".into(), usd("", gross).amount_text()));
        facts.push((
            "Included inference amount".into(),
            usd("", included).amount_text(),
        ));
    }
    if limit > 0. {
        facts.push(("Spending limit".into(), usd("", limit).amount_text()));
    }
    if let Some(requests) = inference.num_requests {
        facts.push(("Requests".into(), requests.to_string()));
    }
    let mut sections = vec![Section::Facts {
        title: "Inference Providers".into(),
        facts,
    }];
    let mut windows = Vec::new();
    if let Some(quota) = gpu.and_then(|body| json::<GpuQuota>(body).ok()) {
        let valid = |value: Option<f64>| value.filter(|value| value.is_finite() && *value >= 0.);
        if let (Some(total), Some(left)) = (valid(quota.base), valid(quota.current))
            && total > 0.
        {
            let consumed = (total - left).max(0.);
            windows.push(Window::new(
                Kind::Named("ZeroGPU".into()),
                consumed / total * 100.,
                quota.resets_at.as_ref().and_then(Timestamp::time),
                None,
            ));
            sections.push(Section::Facts {
                title: "ZeroGPU".into(),
                facts: vec![
                    ("GPU time used".into(), minutes(consumed)),
                    ("GPU time remaining".into(), minutes(left)),
                ],
            });
        }
    }
    let mut spend = usd("Inference this month", billable);
    if limit > 0. {
        spend = spend.out_of(limit);
    }
    let mut balances = vec![spend];
    if let Some(wallet) = wallet {
        balances.push(usd("Prepaid credits", wallet));
    }
    let account = profile.map_or_else(Account::default, |profile| {
        if let Some(name) = profile
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            sections.push(Section::Facts {
                title: "Account".into(),
                facts: vec![("User".into(), name.to_owned())],
            });
        }
        Account {
            email: profile
                .email
                .map(|email| email.trim().to_owned())
                .filter(|email| !email.is_empty()),
            plan: profile
                .is_pro
                .map(|pro| if pro { "PRO" } else { "Free" }.to_owned()),
        }
    });
    Ok(Report::new(Provider(&Huggingface), account, windows)
        .with_balances(balances)
        .with_sections(sections))
}

/// `10 min`, with a decimal under ten minutes.
fn minutes(seconds: f64) -> String {
    if seconds >= 600. {
        format!("{:.0} min", seconds / 60.)
    } else {
        format!("{:.1} min", seconds / 60.)
    }
}

/// The balance in the billing page's server-rendered `data-props`: the
/// current `entity.currentBalanceUsd`, else the legacy
/// `invoiceCreditsCents`. None when either is missing or ambiguous.
pub(crate) fn wallet_balance(html: &str) -> Option<f64> {
    let lower = html.to_ascii_lowercase();
    let (mut current, mut legacy) = (Vec::new(), Vec::new());
    let mut from = 0;
    while let Some(offset) = lower[from..].find("<div") {
        let start = from + offset;
        let end = lower[start..]
            .find('>')
            .map_or(lower.len(), |end| start + end);
        from = end;
        let Some(raw) = attribute(&html[start..end], &lower[start..end], "data-props") else {
            continue;
        };
        let Ok(serde_json::Value::Object(props)) =
            serde_json::from_str::<serde_json::Value>(&decode(raw)?)
        else {
            continue;
        };
        if let Some(entity) = props.get("entity")
            && let Some(balance) = entity.get("currentBalanceUsd")
        {
            if entity.get("type").and_then(serde_json::Value::as_str) != Some("user") {
                return None;
            }
            current.push(balance.as_f64());
        }
        if let Some(cents) = props.get("invoiceCreditsCents") {
            legacy.push(cents.as_f64());
        }
    }
    let valid = |value: f64| value.is_finite() && value >= 0.;
    match (current.as_slice(), legacy.as_slice()) {
        ([balance], _) => balance.filter(|balance| valid(*balance)),
        ([], [cents]) => cents
            .filter(|cents| valid(*cents) && cents.fract() == 0.)
            .map(|cents| cents / 100.),
        _ => None,
    }
}

/// An attribute's raw value in one tag; `lower` is the same tag lowercased.
fn attribute<'a>(tag: &'a str, lower: &str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(offset) = lower[from..].find(name) {
        let at = from + offset;
        from = at + name.len();
        let before = lower[..at].chars().next_back();
        if !before.is_some_and(char::is_whitespace) {
            continue;
        }
        let rest = lower[from..].trim_start();
        let Some(value) = rest.strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        let start = tag.len() - value.len();
        let quote = value.chars().next()?;
        return if quote == '"' || quote == '\'' {
            let inner = &tag[start + 1..];
            inner.find(quote).map(|end| &inner[..end])
        } else {
            let end = value
                .find(|c: char| c.is_whitespace() || c == '>')
                .unwrap_or(value.len());
            Some(&tag[start..start + end])
        };
    }
    None
}

/// HTML character references; None for one that names no character.
fn decode(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let Some(end) = after.find(';') else {
            out.push_str(&rest[at..]);
            return Some(out);
        };
        let entity = &after[..end];
        let character = match entity {
            "amp" => '&',
            "apos" => '\'',
            "gt" => '>',
            "lt" => '<',
            "nbsp" => '\u{a0}',
            "quot" => '"',
            _ => {
                let code = if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16).ok()?
                } else {
                    entity.strip_prefix('#')?.parse().ok()?
                };
                char::from_u32(code)?
            }
        };
        out.push(character);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[derive(Deserialize)]
struct Billing {
    usage: Option<Usage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    inference_providers: Option<Inference>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inference {
    used_nano_usd: Option<f64>,
    included_nano_usd: Option<f64>,
    limit_nano_usd: Option<f64>,
    num_requests: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuQuota {
    base: Option<f64>,
    current: Option<f64>,
    resets_at: Option<Timestamp>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
    email: Option<String>,
    is_pro: Option<bool>,
}

impl Profile {
    /// Only a user's opaque id identifies the owner of a wallet.
    fn user_id(&self) -> Option<&str> {
        (self.kind.as_deref() == Some("user"))
            .then_some(self.id.as_deref())
            .flatten()
            .filter(|id| !id.trim().is_empty())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const BILLING: &str = r#"{"usage":{"inferenceProviders":{"usedNanoUsd":2450000000,
        "includedNanoUsd":2000000000,"limitNanoUsd":0,"numRequests":128,
        "periodEnd":"2025-09-01T00:00:00Z"}}}"#;
    const GPU: &str = r#"{"base":1500,"current":900,"resetsAt":"2025-08-31T18:00:00Z"}"#;
    const PROFILE: &str = r#"{"type":"user","id":"opaque-a","name":"fixture-a","email":"a@example.com","isPro":true}"#;

    #[test]
    fn billing_quota_and_identity() {
        let profile = json::<Profile>(PROFILE).unwrap();
        let report = parse(BILLING, Some(GPU), Some(profile), Some(12.345)).unwrap();
        assert!((report.balances[0].amount - 0.45).abs() < 1e-9);
        assert_eq!(report.balances[0].total, None);
        assert_eq!(report.balances[1].label, "Prepaid credits");
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Named("ZeroGPU".into()));
        assert!((report.windows[0].used - 40.).abs() < 0.01);
        assert!(report.windows[0].resets_at.is_some());
        assert_eq!(report.account.plan.as_deref(), Some("PRO"));
        assert_eq!(report.account.email.as_deref(), Some("a@example.com"));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        let labels: Vec<_> = facts.iter().map(|(label, _)| label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Billable usage",
                "Gross inference usage",
                "Included inference amount",
                "Requests"
            ]
        );
        let Section::Facts { facts, .. } = &report.sections[1] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0].1, "10 min");
        assert_eq!(facts[1].1, "15 min");
    }

    #[test]
    fn spend_without_quota_or_identity() {
        let billing = r#"{"usage":{"inferenceProviders":{"usedNanoUsd":100000000,
            "includedNanoUsd":2000000000,"limitNanoUsd":4000000000}}}"#;
        let report = parse(billing, None, None, None).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].amount, 0.);
        assert_eq!(report.balances[0].total, Some(4.));
        assert_eq!(report.account, Account::default());
    }

    #[test]
    fn missing_deduction_fails() {
        let billing = r#"{"usage":{"inferenceProviders":{"usedNanoUsd":100000000}}}"#;
        assert!(parse(billing, None, None, None).is_err());
    }

    #[test]
    fn wallet_reads_current_then_legacy_props() {
        let current = r#"<div class="x" data-props="{&quot;entity&quot;:{&quot;type&quot;:&quot;user&quot;,&quot;currentBalanceUsd&quot;:12.345}}"></div>"#;
        assert_eq!(wallet_balance(current), Some(12.345));
        let legacy = r#"<div data-props='{"invoiceCreditsCents":1250}'></div>"#;
        assert_eq!(wallet_balance(legacy), Some(12.5));
        let organization = r#"<div data-props='{"entity":{"type":"org","currentBalanceUsd":3}}'>"#;
        assert_eq!(wallet_balance(organization), None);
        let twice = format!("{legacy}{legacy}");
        assert_eq!(wallet_balance(&twice), None);
    }

    #[test]
    fn only_a_user_id_owns_a_wallet() {
        let org = json::<Profile>(r#"{"type":"org","id":"opaque-a"}"#).unwrap();
        assert_eq!(org.user_id(), None);
        let user = json::<Profile>(PROFILE).unwrap();
        assert_eq!(user.user_id(), Some("opaque-a"));
    }
}
