//! Kilo credits and Kilo Pass usage from the `app.kilo.ai` tRPC batch
//! CodexBar calls. The bearer token is an API key from the config or
//! `KILO_API_KEY`, else the Kilo CLI's own sign-in in
//! `~/.local/share/kilo/auth.json` (`kilo.access`), in CodexBar's order.
//!
//! Not ported: organization scopes (CodexBar can add one card per
//! organization with `X-KILOCODE-ORGANIZATIONID`; this shows the personal
//! scope), and the long list of guessed money keys CodexBar tries when the
//! pass state has no `subscription` object: only the plan name is read from
//! such answers.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{HostPath, Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{invalid, number, plain, usd},
    },
};
use serde_json::{Map, Value};

/// `user.getCreditBlocks`, `kiloPass.getState`, and
/// `user.getAutoTopUpPaymentMethod`, each with a null input, as one batch.
const URL: &str = "https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState,user.getAutoTopUpPaymentMethod?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%2C%221%22%3A%7B%22json%22%3Anull%7D%2C%222%22%3A%7B%22json%22%3Anull%7D%7D";
const PROCEDURES: usize = 3;

pub(crate) struct Kilo;

static META: Meta = Meta::new("kilo", "Kilo")
    .dashboard("https://app.kilo.ai/usage")
    .settings(&[Setting::new(
        "api_key",
        &["KILO_API_KEY"],
        "A Kilo API key from https://app.kilo.ai (Profile → API keys). Without one, the \
         Kilo CLI's sign-in in ~/.local/share/kilo/auth.json is used; run `kilo auth \
         login` to create it.",
    )]);

impl Service for Kilo {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let token = probe.setting("api_key").or_else(|| {
            let auth = probe.file(&HostPath::home(".local/share/kilo/auth.json"))?;
            probe.field(&auth, &["kilo", "access"])
        })?;
        let request = Request::get(URL)
            .bearer(&token)
            .header("Accept", "application/json");
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let root: Value = json(body)?;
    let entries = entries(&root)?;
    let mut payloads: [Option<&Value>; PROCEDURES] = [None; PROCEDURES];
    for (index, entry) in entries.into_iter().enumerate() {
        let Some(entry) = entry else { continue };
        if let Some(error) = entry.get("error") {
            // The auto top-up method is optional; the others carry the usage.
            if index == 2 {
                continue;
            }
            return Err(trpc_error(error));
        }
        payloads[index] = payload(entry);
    }

    let credits = credits(payloads[0]);
    let subscription = payloads[1].and_then(subscription);
    let pass = subscription.map(pass);
    let plan = match subscription {
        Some(subscription) => Some(
            text(subscription.get("tier"))
                .map(|tier| tier_name(&tier))
                .unwrap_or_else(|| "Kilo Pass".into()),
        ),
        None => fallback_plan(payloads[1]),
    };
    let top_up = top_up(payloads[0], payloads[2]);

    let mut windows = Vec::new();
    let mut facts = Vec::new();
    if let Some(pass) = &pass
        && let Some(total) = pass.total
    {
        let used = pass.used.unwrap_or(0.);
        let percent = if total > 0. {
            used / total * 100.
        } else {
            100.
        };
        windows.push(Window::new(
            Kind::Monthly,
            percent,
            pass.resets_at,
            Some(MONTH),
        ));
        let base = (total - pass.bonus).max(0.);
        let mut text = format!("{} of {}", usd(used), usd(base));
        if pass.bonus > 0. {
            text.push_str(&format!(" (+ {} bonus)", usd(pass.bonus)));
        }
        facts.push(("Kilo Pass".to_owned(), text));
    }
    if let Some((enabled, method)) = top_up {
        facts.push((
            "Auto top-up".to_owned(),
            match (enabled, method) {
                (false, _) => "Off".to_owned(),
                (true, Some(method)) => method,
                (true, None) => "On".to_owned(),
            },
        ));
    }

    let balances = credits.and_then(|credits| {
        let total = credits.total?;
        let remaining = credits.remaining.unwrap_or((total - credits.used).max(0.));
        Some(Balance::new("Credits left", remaining, credits.unit).out_of(total))
    });

    if windows.is_empty() && balances.is_none() && plan.is_none() {
        return Err(invalid());
    }
    Ok(
        Report::new(Provider(&Kilo), Account { email: None, plan }, windows)
            .with_balances(balances)
            .with_sections((!facts.is_empty()).then(|| Section::Facts {
                title: "Plan".into(),
                facts,
            })),
    )
}

/// The batch answer is an array, an object keyed by index, or, for one
/// procedure, the entry itself.
fn entries(root: &Value) -> Result<Vec<Option<&Map<String, Value>>>> {
    match root {
        Value::Array(items) => Ok(items
            .iter()
            .take(PROCEDURES)
            .map(Value::as_object)
            .collect()),
        Value::Object(object) if object.contains_key("result") || object.contains_key("error") => {
            Ok(vec![Some(object)])
        }
        Value::Object(object) => {
            let entries: Vec<_> = (0..PROCEDURES)
                .map(|index| object.get(&index.to_string()).and_then(Value::as_object))
                .collect();
            if entries.iter().all(Option::is_none) {
                return Err(invalid());
            }
            Ok(entries)
        }
        _ => Err(invalid()),
    }
}

fn trpc_error(error: &Value) -> Error {
    const PATHS: &[&[&str]] = &[
        &["json", "data", "code"],
        &["data", "code"],
        &["code"],
        &["json", "message"],
        &["message"],
    ];
    let code = PATHS
        .iter()
        .filter_map(|path| text(dig(error, path)))
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    if code.contains("unauthorized") || code.contains("forbidden") {
        Error::UsageRejected
    } else if code.contains("not_found") || code.contains("not found") {
        Error::UsageStatus(404)
    } else {
        invalid()
    }
}

fn payload(entry: &Map<String, Value>) -> Option<&Value> {
    let result = entry.get("result")?.as_object()?;
    let found = match result.get("data") {
        Some(data @ Value::Object(object)) => object.get("json").unwrap_or(data),
        _ => result.get("json")?,
    };
    (!found.is_null()).then_some(found)
}

struct Credits {
    used: f64,
    total: Option<f64>,
    remaining: Option<f64>,
    unit: Unit,
}

impl Credits {
    /// Fills whichever of used, total, and remaining the other two imply.
    fn new(used: Option<f64>, total: Option<f64>, remaining: Option<f64>, unit: Unit) -> Self {
        let total = total
            .map(|total| total.max(0.))
            .or_else(|| Some((used? + remaining?).max(0.)));
        let used = used
            .map(|used| used.max(0.))
            .or_else(|| Some((total? - remaining?).max(0.)))
            .unwrap_or(0.);
        Self {
            used,
            total,
            remaining,
            unit,
        }
    }
}

fn credits(payload: Option<&Value>) -> Option<Credits> {
    let contexts = contexts(payload?);
    let dollars = || Unit::Currency("USD".into());
    if let Some(blocks) = first(&contexts, &["creditBlocks"]).and_then(Value::as_array) {
        let (mut total, mut remaining) = (None::<f64>, None::<f64>);
        for block in blocks.iter().filter_map(Value::as_object) {
            if let Some(amount) = block.get("amount_mUsd").and_then(number) {
                *total.get_or_insert(0.) += amount / 1_000_000.;
            }
            if let Some(balance) = block.get("balance_mUsd").and_then(number) {
                *remaining.get_or_insert(0.) += balance / 1_000_000.;
            }
        }
        if total.is_some() || remaining.is_some() {
            let total = total.map(|total| total.max(0.));
            let remaining = remaining.map(|remaining| remaining.max(0.));
            let used = total
                .zip(remaining)
                .map(|(total, remaining)| (total - remaining).max(0.));
            return Some(Credits::new(used, total, remaining, dollars()));
        }
    }

    let blocks: Vec<&Map<String, Value>> = first(&contexts, &["blocks"])
        .and_then(Value::as_array)
        .map(|blocks| blocks.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    const USED: &[&str] = &["used", "usedCredits", "consumed", "spent", "creditsUsed"];
    const TOTAL: &[&str] = &["total", "totalCredits", "creditsTotal", "limit"];
    const REMAINING: &[&str] = &["remaining", "remainingCredits", "creditsRemaining"];
    let find = |keys: &[&str]| {
        first(&blocks, keys)
            .and_then(number)
            .or_else(|| first(&contexts, keys).and_then(number))
    };
    let (used, total, remaining) = (find(USED), find(TOTAL), find(REMAINING));
    if used.is_some() || total.is_some() || remaining.is_some() {
        return Some(Credits::new(
            used,
            total,
            remaining,
            Unit::Count("credits".into()),
        ));
    }

    // An account with no credit blocks still reports its balance.
    let balance = first(&contexts, &["totalBalance_mUsd"]).and_then(number)?;
    let balance = (balance / 1_000_000.).max(0.);
    Some(Credits::new(
        Some(0.),
        Some(balance),
        Some(balance),
        dollars(),
    ))
}

struct Pass {
    used: Option<f64>,
    total: Option<f64>,
    bonus: f64,
    resets_at: Option<std::time::SystemTime>,
}

fn subscription(payload: &Value) -> Option<&Map<String, Value>> {
    let object = payload.as_object()?;
    match object.get("subscription") {
        Some(Value::Object(subscription)) => Some(subscription),
        Some(_) => None,
        None => [
            "currentPeriodUsageUsd",
            "currentPeriodBaseCreditsUsd",
            "currentPeriodBonusCreditsUsd",
            "tier",
        ]
        .iter()
        .any(|key| object.contains_key(*key))
        .then_some(object),
    }
}

fn pass(subscription: &Map<String, Value>) -> Pass {
    let used = subscription
        .get("currentPeriodUsageUsd")
        .and_then(number)
        .map(|used| used.max(0.));
    let base = subscription
        .get("currentPeriodBaseCreditsUsd")
        .and_then(number)
        .map(|base| base.max(0.));
    let bonus = subscription
        .get("currentPeriodBonusCreditsUsd")
        .and_then(number)
        .unwrap_or(0.)
        .max(0.);
    let resets_at = ["nextBillingAt", "nextRenewalAt", "renewsAt", "renewAt"]
        .iter()
        .find_map(|key| time(subscription.get(*key)));
    Pass {
        used,
        total: base.map(|base| base + bonus),
        bonus,
        resets_at,
    }
}

fn tier_name(tier: &str) -> String {
    match tier {
        "tier_19" => "Starter".into(),
        "tier_49" => "Pro".into(),
        "tier_199" => "Expert".into(),
        other => other.into(),
    }
}

fn fallback_plan(payload: Option<&Value>) -> Option<String> {
    let contexts = contexts(payload?);
    text(first(
        &contexts,
        &[
            "planName",
            "tier",
            "tierName",
            "passName",
            "subscriptionName",
        ],
    ))
    .or_else(|| {
        const PATHS: &[&[&str]] = &[
            &["plan", "name"],
            &["subscription", "plan", "name"],
            &["subscription", "name"],
            &["pass", "name"],
            &["state", "name"],
            &["state"],
        ];
        PATHS.iter().find_map(|path| {
            contexts
                .iter()
                .find_map(|context| text(dig_map(context, path)))
        })
    })
    .or_else(|| {
        text(first(&contexts, &["name"])).filter(|name| name.to_lowercase().contains("pass"))
    })
}

/// Whether auto top-up is on, and the payment method or amount it uses.
fn top_up(credits: Option<&Value>, method: Option<&Value>) -> Option<(bool, Option<String>)> {
    let method = method.map(contexts).unwrap_or_default();
    let credits = credits.map(contexts).unwrap_or_default();
    let enabled = boolean(first(&method, &["enabled", "isEnabled", "active"]))
        .or_else(
            || match text(first(&method, &["status"]))?.to_lowercase().as_str() {
                "enabled" | "active" | "on" => Some(true),
                "disabled" | "inactive" | "off" | "none" => Some(false),
                _ => None,
            },
        )
        .or_else(|| boolean(first(&credits, &["autoTopUpEnabled"])))?;
    let name = text(first(
        &method,
        &["paymentMethod", "paymentMethodType", "method", "cardBrand"],
    ));
    let amount = first(&method, &["amountCents"])
        .and_then(number)
        .map(|cents| cents / 100.)
        .or_else(|| first(&method, &["amount", "topUpAmount", "amountUsd"]).and_then(number))
        .filter(|amount| *amount > 0.)
        .map(|amount| format!("${}", plain(amount)));
    Some((enabled, name.or(amount)))
}

/// The payload and the objects nested up to two levels below it, breadth
/// first, where the fields CodexBar looks for may sit.
fn contexts(payload: &Value) -> Vec<&Map<String, Value>> {
    let Some(root) = payload.as_object() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root, 0)]);
    while let Some((object, depth)) = queue.pop_front() {
        found.push(object);
        if depth >= 2 {
            continue;
        }
        for value in object.values() {
            match value {
                Value::Object(nested) => queue.push_back((nested, depth + 1)),
                Value::Array(items) => queue.extend(
                    items
                        .iter()
                        .filter_map(Value::as_object)
                        .map(|nested| (nested, depth + 1)),
                ),
                _ => {}
            }
        }
    }
    found
}

fn first<'a>(contexts: &[&'a Map<String, Value>], keys: &[&str]) -> Option<&'a Value> {
    contexts.iter().find_map(|context| {
        keys.iter()
            .find_map(|key| context.get(*key).filter(|value| !value.is_null()))
    })
}

fn dig<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(*key))
}

fn dig_map<'a>(map: &'a Map<String, Value>, path: &[&str]) -> Option<&'a Value> {
    let (head, rest) = path.split_first()?;
    dig(map.get(*head)?, rest)
}

fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn boolean(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::Number(number) => number.as_f64().map(|number| number != 0.),
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "true" | "1" | "yes" | "enabled" | "on" => Some(true),
            "false" | "0" | "no" | "disabled" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn time(value: Option<&Value>) -> Option<std::time::SystemTime> {
    match value? {
        Value::Number(number) => Timestamp::Number(number.as_f64()?).time(),
        Value::String(text) if !text.trim().is_empty() => Timestamp::Text(text.clone()).time(),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// CodexBar's Kilo Pass fixture: a $19 credit block and a Starter pass.
    const PASS: &str = r#"[
      {"result":{"data":{"creditBlocks":[{"id":"cb-1","effective_date":"2026-02-01T00:00:00Z",
        "expiry_date":null,"balance_mUsd":19000000,"amount_mUsd":19000000,"is_free":false}],
        "totalBalance_mUsd":19000000,"autoTopUpEnabled":false}}},
      {"result":{"data":{"subscription":{"tier":"tier_19","currentPeriodUsageUsd":0,
        "currentPeriodBaseCreditsUsd":19.0,"currentPeriodBonusCreditsUsd":9.5,
        "nextBillingAt":"2026-03-28T04:00:00.000Z"}}}},
      {"result":{"data":{"enabled":false,"amountCents":5000,"paymentMethod":null}}}
    ]"#;

    #[test]
    fn reads_credit_blocks_and_the_pass() {
        let report = parse(PASS).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Starter"));
        assert_eq!(
            report.balances,
            vec![Balance::new("Credits left", 19., Unit::Currency("USD".into())).out_of(19.)]
        );
        assert_eq!(report.windows.len(), 1);
        let pass = &report.windows[0];
        assert_eq!(pass.kind, Kind::Monthly);
        assert_eq!(pass.percent(), 0);
        assert!(pass.resets_at.is_some());
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Plan".into(),
                facts: vec![
                    ("Kilo Pass".into(), "$0.00 of $19.00 (+ $9.50 bonus)".into()),
                    ("Auto top-up".into(), "Off".into()),
                ],
            }]
        );
    }

    #[test]
    fn reads_generic_credit_counts_and_a_named_plan() {
        let body = r#"[
          {"result":{"data":{"json":{"blocks":[{"usedCredits":25,"totalCredits":100,"remainingCredits":75}]}}}},
          {"result":{"data":{"json":{"plan":{"name":"Kilo Pass Pro"}}}}},
          {"result":{"data":{"json":{"enabled":true,"paymentMethod":"visa"}}}}
        ]"#;
        let report = parse(body).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Kilo Pass Pro"));
        assert_eq!(
            report.balances,
            vec![Balance::new("Credits left", 75., Unit::Count("credits".into())).out_of(100.)]
        );
        assert!(report.windows.is_empty());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("facts expected");
        };
        assert_eq!(facts[0], ("Auto top-up".into(), "visa".into()));
    }

    #[test]
    fn names_tiers_and_top_up_amounts() {
        let body = r#"[
          {"result":{"data":{"creditBlocks":[],"totalBalance_mUsd":0,"autoTopUpEnabled":true}}},
          {"result":{"data":{"subscription":{"currentPeriodUsageUsd":1.0,"currentPeriodBaseCreditsUsd":19.0}}}},
          {"result":{"data":{"enabled":true,"amountCents":5000,"paymentMethod":null}}}
        ]"#;
        let report = parse(body).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Kilo Pass"));
        assert_eq!(report.windows[0].percent(), 5);
        assert_eq!(
            report.balances,
            vec![Balance::new("Credits left", 0., Unit::Currency("USD".into())).out_of(0.)]
        );
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("facts expected");
        };
        assert_eq!(facts[1], ("Auto top-up".into(), "$50".into()));
    }

    #[test]
    fn maps_an_unauthorized_procedure() {
        let body =
            r#"[{"error":{"json":{"message":"UNAUTHORIZED","data":{"code":"UNAUTHORIZED"}}}}]"#;
        assert!(matches!(parse(body), Err(Error::UsageRejected)));
    }
}
