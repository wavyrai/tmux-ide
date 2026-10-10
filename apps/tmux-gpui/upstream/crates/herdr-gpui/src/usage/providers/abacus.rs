//! Abacus AI (ChatLLM/RouteLLM) compute credits, read with the
//! apps.abacus.ai web session: the `cookie` setting, else (when listed) the
//! abacus.ai cookies from Chrome or Safari.
//!
//! Not ported: CodexBar filters imported cookies down to session-looking
//! names, caches a working header in the keychain, and tries each browser
//! profile in turn; here the first browser with abacus.ai cookies is used,
//! and nothing is cached.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Unit, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values,
    },
};
use serde_json::Value;
use std::time::Duration;

const POINTS_URL: &str = "https://apps.abacus.ai/api/_getOrganizationComputePoints";
const BILLING_URL: &str = "https://apps.abacus.ai/api/_getBillingInfo";

pub(crate) struct Abacus;

static META: Meta = Meta::new("abacus", "Abacus AI")
    .dashboard("https://apps.abacus.ai/chatllm/admin/compute-points-usage")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Sign in to https://apps.abacus.ai, open Developer Tools > Application > Cookies \
         for https://apps.abacus.ai, and copy its session cookies (names containing \
         \"session\", \"auth\", or \"sid\"). Paste them as \"name=value; name2=value2\"; \
         the whole Cookie header of any apps.abacus.ai request also works.",
    )]);

impl Service for Abacus {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["abacus.ai"], &[])?;
        Some(read(probe, &cookie))
    }
}

fn read(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let points = Request::get(POINTS_URL)
        .cookie(cookie)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");
    let points = probe.body(points)?;
    let billing = Request::post(BILLING_URL)
        .cookie(cookie)
        .header("Accept", "application/json")
        .json("{}")
        .timeout(Duration::from_secs(5));
    // Billing only adds the plan and reset date; credits stand without it.
    let billing = probe.body(billing).ok();
    parse(&points, billing.as_deref())
}

pub(crate) fn parse(points: &str, billing: Option<&str>) -> Result<Report> {
    let points = result(points)?;
    let total = amount(points.get("totalComputePoints"));
    let left = amount(points.get("computePointsLeft"));
    let (Some(total), Some(left)) = (total, left) else {
        return Err(values::invalid());
    };
    let billing = billing.and_then(|body| result(body).ok());
    let resets_at = billing
        .as_ref()
        .and_then(|billing| billing.get("nextBillingDate"))
        .and_then(Value::as_str)
        .and_then(|text| Timestamp::Text(text.to_owned()).time());
    let plan = billing
        .as_ref()
        .and_then(|billing| billing.get("currentTier"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(str::to_owned);
    let used = total - left;
    let percent = if total > 0. { used / total * 100. } else { 0. };
    // The billing cycle is the calendar month before the reset; without a
    // reset the length stays unknown, so no pace is guessed.
    let length = resets_at.and_then(|reset| {
        let reset = chrono::DateTime::<chrono::Utc>::from(reset);
        let start = reset.checked_sub_months(chrono::Months::new(1))?;
        (reset - start).to_std().ok()
    });
    let window = Window::new(Kind::Named("Credits".into()), percent, resets_at, length);
    let credits = Balance::new("Credits used", used.max(0.), Unit::Count("credits".into()));
    let credits = if total > 0. {
        credits.out_of(total)
    } else {
        credits
    };
    Ok(Report::new(
        Provider(&Abacus),
        Account { email: None, plan },
        vec![window],
    )
    .with_balances([credits]))
}

/// Abacus wraps answers as `{"success": true, "result": {...}}`; a failure
/// that names the session means the sign-in expired.
fn result(body: &str) -> Result<Value> {
    let mut root: Value = json(body)?;
    if root.get("success").and_then(Value::as_bool) == Some(true)
        && let Some(result) = root.get_mut("result").filter(|result| result.is_object())
    {
        return Ok(result.take());
    }
    let message = root
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let signed_out = [
        "expired",
        "session",
        "login",
        "authenticate",
        "unauthorized",
        "unauthenticated",
        "forbidden",
    ]
    .iter()
    .any(|word| message.contains(word));
    Err(if signed_out {
        Error::UsageRejected
    } else {
        values::invalid()
    })
}

fn amount(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|number| number.is_finite())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const POINTS: &str = r#"{"success": true, "result": {"totalComputePoints": 20000,
        "computePointsLeft": 15000}}"#;

    #[test]
    fn credits_with_billing_cycle() {
        let billing = r#"{"success": true, "result": {"nextBillingDate": "2026-10-15T00:00:00Z",
            "currentTier": "Pro"}}"#;
        let report = parse(POINTS, Some(billing)).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        let window = &report.windows[0];
        assert!((window.used - 25.).abs() < 1e-4);
        assert!(window.resets_at.is_some());
        // September 15 to October 15.
        assert_eq!(window.length, Some(Duration::from_secs(30 * 86_400)));
        assert_eq!(
            report.balances,
            vec![Balance::new("Credits used", 5000., Unit::Count("credits".into())).out_of(20000.)]
        );
    }

    #[test]
    fn missing_billing_leaves_the_cycle_unknown() {
        let report = parse(POINTS, Some(r#"{"success": false, "error": "boom"}"#)).unwrap();
        assert_eq!(report.windows[0].length, None);
        assert_eq!(report.account.plan, None);
    }

    #[test]
    fn expired_session_is_rejected() {
        let body = r#"{"success": false, "error": "Session expired, please login"}"#;
        assert!(matches!(parse(body, None), Err(Error::UsageRejected)));
        let body = r#"{"success": true, "result": {"totalComputePoints": 1}}"#;
        assert!(matches!(parse(body, None), Err(Error::UsageJson(_))));
    }
}
