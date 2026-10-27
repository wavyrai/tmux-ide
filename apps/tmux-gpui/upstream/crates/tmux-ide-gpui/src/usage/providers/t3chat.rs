//! T3 Chat's 4-hour Base and monthly Overage buckets, read from the
//! `getCustomerData` tRPC call the t3.chat settings page makes, with the
//! browser session: the `cookie` setting, else (when the provider is listed)
//! the t3.chat cookies from Chrome or Safari, as CodexBar does.
//!
//! T3 Chat publishes no API, so this may stop working without notice.
//! Not ported: CodexBar's manual mode also accepts a full "Copy as cURL"
//! capture and forwards its extra browser headers, which gets past a
//! Vercel security challenge that a bare Cookie header can trigger; here
//! only the Cookie header is sent.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, Provider, Report, Section, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp},
        values::invalid,
    },
};
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

/// `getCustomerData` with the input the web client sends:
/// `{"0":{"json":{"sessionId":null},"meta":{"values":{"sessionId":["undefined"]}}}}`.
const URL: &str = "https://t3.chat/api/trpc/getCustomerData?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22sessionId%22%3Anull%7D%2C%22meta%22%3A%7B%22values%22%3A%7B%22sessionId%22%3A%5B%22undefined%22%5D%7D%7D%7D%7D";
const BASE: Duration = Duration::from_secs(4 * 3600);

pub(crate) struct T3chat;

static META: Meta = Meta::new("t3chat", "T3 Chat")
    .dashboard("https://t3.chat/settings/customization")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Your t3.chat browser session. Sign in at https://t3.chat, open Developer Tools → \
         Application → Cookies → https://t3.chat, and copy every cookie there (the session \
         cookies change names between releases), pasted as one header: \
         \"name=value; name2=value2\". It is sent only to t3.chat.",
    )]);

impl Service for T3chat {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["t3.chat"], &[])?;
        let request = Request::get(URL)
            .cookie(&cookie)
            .header("Accept", "*/*")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header(
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            )
            .header("Sec-Fetch-Dest", "empty")
            .header("Sec-Fetch-Mode", "cors")
            .header("Sec-Fetch-Site", "same-origin")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("Referer", "https://t3.chat/settings/customization")
            .header("Origin", "https://t3.chat")
            .header("trpc-accept", "application/jsonl")
            .header("x-trpc-source", "web-client")
            .header("x-trpc-batch", "true");
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

/// The answer is JSON lines; the customer data sits somewhere inside one.
pub(crate) fn parse(body: &str) -> Result<Report> {
    let data = body
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find_map(|line| find(&line).cloned())
        .ok_or_else(invalid)?;

    let number = |key: &str| -> Result<Option<f64>> {
        match data.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_f64()
                .filter(|n| n.is_finite())
                .map(Some)
                .ok_or_else(invalid),
        }
    };
    let text = |object: &Map<String, Value>, key: &str| -> Result<Option<String>> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.trim().to_owned()).filter(|t| !t.is_empty())),
            Some(_) => Err(invalid()),
        }
    };
    let subscription = match data.get("subscription") {
        None | Some(Value::Null) => None,
        Some(Value::Object(subscription)) => Some(subscription),
        Some(_) => return Err(invalid()),
    };
    let period = |key: &str| -> Result<Option<SystemTime>> {
        match subscription.and_then(|subscription| subscription.get(key)) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(value)) => Ok(value.as_f64().and_then(time)),
            Some(_) => Err(invalid()),
        }
    };

    let base_reset = number("usageFourHourNextResetAt")?
        .and_then(time)
        .or(number("usageWindowNextResetAt")?.and_then(time));
    let base = Window::new(
        Kind::Session,
        number("usageFourHourPercentage")?.unwrap_or(0.),
        base_reset,
        Some(BASE),
    );
    let (start, end) = (period("currentPeriodStart")?, period("currentPeriodEnd")?);
    let overage = Window::new(
        Kind::Named("Overage".into()),
        number("usageMonthPercentage")?
            .or(number("usagePeriodPercentage")?)
            .unwrap_or(0.),
        end,
        start
            .zip(end)
            .and_then(|(start, end)| end.duration_since(start).ok()),
    );

    let plan = match subscription {
        Some(subscription) => text(subscription, "productName")?,
        None => None,
    }
    .or(text(&data, "subTier")?)
    .map(|plan| plan_name(&plan))
    .filter(|plan| !plan.is_empty());
    let band = text(&data, "usageBand")?;
    let status = match subscription {
        Some(subscription) => text(subscription, "status")?,
        None => None,
    };
    let facts: Vec<(String, String)> = [("Usage band", band), ("Subscription", status)]
        .into_iter()
        .filter_map(|(label, value)| Some((label.to_owned(), value?)))
        .collect();

    Ok(Report::new(
        Provider(&T3chat),
        Account { email: None, plan },
        vec![base, overage],
    )
    .with_sections((!facts.is_empty()).then(|| Section::Facts {
        title: "Plan".into(),
        facts,
    })))
}

fn find(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(object) => {
            let found = object.contains_key("usageFourHourPercentage")
                || object.contains_key("usageMonthPercentage")
                || (object.contains_key("subscription") && object.contains_key("usageBand"));
            if found {
                return Some(object);
            }
            object.values().find_map(find)
        }
        Value::Array(items) => items.iter().find_map(find),
        _ => None,
    }
}

/// JavaScript milliseconds or Unix seconds; zero means unset.
fn time(value: f64) -> Option<SystemTime> {
    (value > 0.)
        .then_some(value)
        .and_then(|value| Timestamp::Number(value).time())
}

/// `pro-annual` reads as `Pro Annual`.
fn plan_name(raw: &str) -> String {
    raw.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    /// The JSONL shape of a `getCustomerData` batch, with a subscription.
    const FIXTURE: &str = concat!(
        r#"{"json":{"0":[[0],[null,0,0]]}}"#,
        "\n",
        r#"{"json":[0,0,[[{"result":{"data":{"json":{"subTier":"pro","usageBand":"standard","#,
        r#""usageFourHourPercentage":37.5,"usageFourHourNextResetAt":1790000000000,"#,
        r#""usageMonthPercentage":12,"lifetimeBalance":0,"subscription":{"productId":"prod_1","#,
        r#""productName":"pro-monthly","status":"active","currentPeriodStart":1788000000,"#,
        r#""currentPeriodEnd":1790592000}}}}}]]]}"#,
        "\n"
    );

    #[test]
    fn reads_base_and_overage_windows() {
        let report = parse(FIXTURE).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro Monthly"));
        assert_eq!(report.windows.len(), 2);
        let base = &report.windows[0];
        assert_eq!(base.kind, Kind::Session);
        assert_eq!(base.percent(), 38);
        assert_eq!(base.length, Some(BASE));
        assert_eq!(
            base.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000))
        );
        let overage = &report.windows[1];
        assert_eq!(overage.kind, Kind::Named("Overage".into()));
        assert_eq!(overage.percent(), 12);
        assert_eq!(
            overage.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_592_000))
        );
        assert_eq!(overage.length, Some(Duration::from_secs(2_592_000)));
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Plan".into(),
                facts: vec![
                    ("Usage band".into(), "standard".into()),
                    ("Subscription".into(), "active".into()),
                ],
            }]
        );
    }

    #[test]
    fn falls_back_to_the_tier_and_period_percentage() {
        // One JSON line: the answer is split into lines before parsing.
        let body = concat!(
            r#"{"subTier":"free","usageFourHourPercentage":null,"#,
            r#""usagePeriodPercentage":40,"usageWindowNextResetAt":1790000000}"#
        );
        let report = parse(body).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Free"));
        assert_eq!(report.windows[0].percent(), 0);
        assert!(report.windows[0].resets_at.is_some());
        assert_eq!(report.windows[1].percent(), 40);
        assert_eq!(report.windows[1].resets_at, None);
    }

    #[test]
    fn rejects_answers_without_customer_data() {
        assert!(matches!(parse("{\"json\":{}}\n"), Err(Error::UsageJson(_))));
        assert!(matches!(
            parse(r#"{"usageFourHourPercentage":"high"}"#),
            Err(Error::UsageJson(_))
        ));
    }
}
