//! Qoder big model credits, read from the account dashboard API with the
//! qoder.com (or qoder.com.cn) browser session: the `cookie` setting, else
//! the site's cookies from Chrome or Safari when the provider is listed.
//!
//! Not ported from CodexBar: parsing a pasted cURL or HTTP request capture to
//! pick the site. The `site` setting chooses qoder.com.cn instead.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Unit, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;

const GLOBAL: &str = "https://qoder.com";
const CHINA: &str = "https://qoder.com.cn";
const USAGE_PATH: &str = "/api/v2/me/usages/big_model_credits";
const BROWSER: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                       (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Qoder;

static META: Meta = Meta::new("qoder", "Qoder")
    .dashboard("https://qoder.com/account/usage")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "Your Qoder browser session. Sign in at https://qoder.com/account/usage (or \
             https://qoder.com.cn/account/usage), open Developer Tools > Application > \
             Cookies for qoder.com (or qoder.com.cn), and copy every cookie of the site as \
             one header: \"name=value; name2=value2\".",
        ),
        Setting::new(
            "site",
            &[],
            "Which Qoder site the account belongs to: \"global\" for qoder.com (the \
             default) or \"china\" for qoder.com.cn.",
        ),
    ]);

impl Service for Qoder {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let china = probe
            .text_setting("site")
            .is_some_and(|site| matches!(site.to_ascii_lowercase().as_str(), "china" | "cn"));
        let (origin, cookie) = if china {
            (CHINA, probe.cookies(&["qoder.com.cn"], &[])?)
        } else {
            match probe.cookies(&["qoder.com"], &[]) {
                Some(cookie) => (GLOBAL, cookie),
                None => (CHINA, probe.cookies(&["qoder.com.cn"], &[])?),
            }
        };
        Some(fetch(probe, origin, &cookie))
    }
}

fn fetch(probe: &mut Probe, origin: &str, cookie: &Secret) -> Result<Report> {
    let request = Request::get(format!("{origin}{USAGE_PATH}"))
        .cookie(cookie)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("User-Agent", BROWSER)
        .header("Origin", origin)
        .header("Referer", format!("{origin}/account/usage"))
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Bx-V", "2.5.35");
    let body = probe.body(request)?;
    parse(&body, origin == CHINA)
}

pub(crate) fn parse(body: &str, china: bool) -> Result<Report> {
    let usage: Usage = json(body)?;
    let base = usage
        .total_quota
        .and_then(|quota| quota.quota_summary)
        .ok_or_else(invalid)?
        .amounts()
        .ok_or_else(invalid)?;
    let shared = usage
        .shared_quota
        .and_then(|quota| quota.quota_summary)
        .map(|summary| summary.amounts().ok_or_else(invalid))
        .transpose()?;
    // A shared pool adds to the plan's own; Qoder's percentage then covers
    // only one of them, so it is recomputed from the sums.
    let used = base.used + shared.map_or(0., |shared| shared.used);
    let total = base.total + shared.map_or(0., |shared| shared.total);
    let remaining = base.remaining + shared.map_or(0., |shared| shared.remaining);
    if total == 0. && (used != 0. || remaining != 0.) {
        return Err(invalid());
    }
    let percent = match (shared, base.percent) {
        (None, Some(percent)) => percent,
        _ if total > 0. => used / total * 100.,
        _ => 100.,
    };
    let resets_at = usage.next_reset_at.as_ref().and_then(Timestamp::time);
    let window = Window::new(Kind::Named("Credits".into()), percent, resets_at, None);
    let account = Account {
        email: None,
        plan: china.then(|| "qoder.com.cn".to_owned()),
    };
    Ok(
        Report::new(Provider(&Qoder), account, vec![window]).with_balances([Balance::new(
            "Credits left",
            remaining,
            Unit::Count("credits".into()),
        )
        .out_of(total)]),
    )
}

#[derive(Deserialize)]
struct Usage {
    #[serde(alias = "totalQuota")]
    total_quota: Option<Quota>,
    #[serde(alias = "sharedQuota")]
    shared_quota: Option<Quota>,
    #[serde(alias = "nextResetAt")]
    next_reset_at: Option<Timestamp>,
}

#[derive(Deserialize)]
struct Quota {
    #[serde(alias = "quotaSummary")]
    quota_summary: Option<Summary>,
}

#[derive(Deserialize)]
struct Summary {
    #[serde(alias = "usedValue")]
    used_value: Option<f64>,
    #[serde(alias = "limitValue")]
    limit_value: Option<f64>,
    #[serde(alias = "remainingValue")]
    remaining_value: Option<f64>,
    #[serde(alias = "usagePercentage")]
    usage_percentage: Option<f64>,
}

#[derive(Clone, Copy)]
struct Amounts {
    used: f64,
    total: f64,
    remaining: f64,
    percent: Option<f64>,
}

impl Summary {
    fn amounts(&self) -> Option<Amounts> {
        let used = self.used_value.filter(|value| value.is_finite())?;
        let total = self.limit_value.filter(|value| value.is_finite())?;
        let remaining = self
            .remaining_value
            .unwrap_or_else(|| (total - used).max(0.));
        let percent = self.usage_percentage;
        let valid = used >= 0.
            && total >= 0.
            && remaining.is_finite()
            && remaining >= 0.
            && percent.is_none_or(f64::is_finite);
        valid.then_some(Amounts {
            used,
            total,
            remaining,
            percent,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    #[test]
    fn parses_credits_and_reset() {
        let body = r#"{
          "nextResetAt": "2024-09-01T00:00:00Z",
          "status": "active",
          "totalQuota": {
            "quotaSummary": {
              "usedValue": 125,
              "limitValue": 500,
              "remainingValue": 375,
              "usagePercentage": 25,
              "unit": "credit"
            },
            "quotaDetail": []
          }
        }"#;
        let report = parse(body, false).unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].percent(), 25);
        assert!(report.windows[0].resets_at.is_some());
        assert_eq!(report.balances[0].amount, 375.);
        assert_eq!(report.balances[0].total, Some(500.));
        assert_eq!(report.account.plan, None);
    }

    #[test]
    fn merges_shared_quota() {
        let body = r#"{
          "total_quota": {
            "quota_summary": {"used_value": 1500, "limit_value": 1500, "remaining_value": 0,
                              "usage_percentage": 100}
          },
          "shared_quota": {
            "quota_summary": {"used_value": 200, "limit_value": 1000, "remaining_value": 800,
                              "usage_percentage": 20}
          }
        }"#;
        let report = parse(body, true).unwrap();
        assert_eq!(report.windows[0].percent(), 68);
        assert_eq!(report.balances[0].amount, 800.);
        assert_eq!(report.balances[0].total, Some(2500.));
        assert_eq!(report.account.plan.as_deref(), Some("qoder.com.cn"));
    }

    #[test]
    fn zero_quota_is_fully_used() {
        let body = r#"{"totalQuota":{"quotaSummary":{"usedValue":0,"limitValue":0,
                      "remainingValue":0,"unit":"credit"}}}"#;
        assert_eq!(parse(body, false).unwrap().windows[0].percent(), 100);
    }

    #[test]
    fn rejects_missing_quota() {
        assert!(matches!(
            parse(r#"{"status":"active"}"#, false),
            Err(Error::UsageJson(_))
        ));
    }
}
