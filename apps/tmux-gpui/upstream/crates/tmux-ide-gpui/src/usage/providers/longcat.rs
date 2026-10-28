//! LongCat token quota and fuel packs, read from the `longcat.chat` web
//! console with its session cookies: the `cookie` setting (or
//! `LONGCAT_MANUAL_COOKIE` here), else, when the provider is listed, the
//! `longcat.chat` cookies from Chrome or Safari. LongCat's API keys expose
//! no usage endpoint, so a console session is the only sign-in. The live
//! token-pack summary is preferred over the legacy `tokenUsage` aggregate,
//! which reports stale zeros for token-pack accounts. CodexBar also accepts
//! a pasted cURL command in place of the header; here only the header is
//! accepted.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, Provider, Report, Section, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{invalid, number},
    },
};
use serde_json::Value;
use std::time::{Duration, SystemTime};

const HOST: &str = "https://longcat.chat";
const USER_CURRENT: &str = "/api/v1/user-current";
const TOKEN_PACKS: &str = "/api/pay/quota/metering/token-packs/summary";
const TOKEN_USAGE: &str = "/api/lc-platform/v1/tokenUsage";
const PENDING_FUEL: &str = "/api/lc-platform/v1/pending-fuel-packages";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Longcat;

static META: Meta = Meta::new("longcat", "LongCat")
    .dashboard("https://longcat.chat/platform/")
    .settings(&[Setting::new(
        "cookie",
        &["LONGCAT_MANUAL_COOKIE"],
        "The LongCat console session. Sign in at https://longcat.chat/platform/usage, open \
         Developer Tools > Application > Cookies > https://longcat.chat, and copy every \
         cookie of the site (the console does not document which one holds the session). \
         Paste them as \"name=value; name2=value2\", or copy the Cookie request header of \
         a request to longcat.chat from the Network tab.",
    )]);

impl Service for Longcat {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["longcat.chat"], &[])?;
        Some(fetch(probe, &cookie))
    }
}

fn fetch(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let get = |path: &str| console(Request::get(format!("{HOST}{path}")), cookie);
    // The required probe: an expired session fails here rather than
    // showing an empty report.
    let account = payload(&required(probe, get(USER_CURRENT))?)?;
    if !account.is_object() {
        return Err(invalid());
    }
    let packs = console(Request::post(format!("{HOST}{TOKEN_PACKS}")), cookie).json("{}");
    let summary = optional(probe, packs);
    let usage = if active_lot(summary.as_ref()).is_none() {
        let usage = payload(&required(probe, get(TOKEN_USAGE))?)?;
        let canonical = usage
            .get("usage")
            .filter(|usage| usage.is_object())
            .unwrap_or(&usage);
        if canonical.get("totalToken").and_then(number).is_none() {
            return Err(invalid());
        }
        Some(usage)
    } else {
        None
    };
    let fuel = optional(probe, get(PENDING_FUEL));
    Ok(build(
        Some(&account),
        summary.as_ref(),
        usage.as_ref(),
        fuel.as_ref(),
    ))
}

fn console(request: Request, cookie: &Secret) -> Request {
    request
        .cookie(cookie)
        .header("Accept", "application/json, text/plain, */*")
        .header("Origin", HOST)
        .header("Referer", format!("{HOST}/platform/usage"))
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("User-Agent", USER_AGENT)
}

fn required(probe: &mut Probe, request: Request) -> Result<String> {
    let response = probe.http(request)?;
    // An expired session redirects to the sign-in page.
    if (300..400).contains(&response.status) {
        return Err(Error::UsageRejected);
    }
    response.ok()
}

/// Supplementary data: any failure leaves it out.
fn optional(probe: &mut Probe, request: Request) -> Option<Value> {
    let body = probe.http(request).ok().filter(|r| r.status == 200)?.body;
    payload(&body).ok().filter(Value::is_object)
}

/// The `data` of LongCat's `{code, message, data}` envelope, where code 0 or
/// 200 is success.
fn payload(body: &str) -> Result<Value> {
    let mut envelope: Value = json(body)?;
    let Some(object) = envelope.as_object_mut() else {
        return Err(invalid());
    };
    if let Some(code) = object.get("code") {
        let code = number(code)
            .filter(|code| code.fract() == 0.)
            .ok_or_else(invalid)?;
        if code != 0. && code != 200. {
            return Err(if code == 401. || code == 403. {
                Error::UsageRejected
            } else {
                u16::try_from(code as i64).map_or(invalid(), Error::UsageStatus)
            });
        }
    }
    Ok(object.remove("data").unwrap_or(envelope))
}

fn active_lot(summary: Option<&Value>) -> Option<&Value> {
    let lot = summary?.get("currentLot")?;
    let active = lot
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status.eq_ignore_ascii_case("ACTIVE"));
    let total = lot.get("totalToken").and_then(number)?;
    (active && total > 0.).then_some(lot)
}

fn expiry(value: &Value) -> Option<SystemTime> {
    match value {
        Value::Number(_) => {
            let number = number(value)?;
            let seconds = if number > 1e12 {
                number / 1000.
            } else {
                number
            };
            if seconds <= 1e9 {
                return None;
            }
            SystemTime::UNIX_EPOCH.checked_add(Duration::try_from_secs_f64(seconds).ok()?)
        }
        Value::String(text) => Timestamp::Text(text.clone()).time(),
        _ => None,
    }
}

fn build(
    account: Option<&Value>,
    summary: Option<&Value>,
    usage: Option<&Value>,
    fuel: Option<&Value>,
) -> Report {
    let name = account.and_then(|account| {
        ["name", "nickName"]
            .into_iter()
            .find_map(|key| account.get(key)?.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    });
    let field = |object: &Value, key: &str| object.get(key).and_then(number);
    let (total, used, remaining) = match active_lot(summary) {
        Some(lot) => {
            let total = field(lot, "totalToken");
            let used = field(lot, "consumedToken").unwrap_or(0.);
            (total, Some(used), total.map(|total| total - used))
        }
        None => match usage {
            Some(usage) => {
                // `usage` is the aggregate; `extData` breaks it down by model.
                let usage = usage
                    .get("usage")
                    .filter(|usage| usage.is_object())
                    .unwrap_or(usage);
                (
                    field(usage, "totalToken"),
                    field(usage, "usedToken"),
                    field(usage, "availableToken"),
                )
            }
            None => (None, None, None),
        },
    };
    let mut windows = Vec::new();
    let mut facts = Vec::new();
    if let Some(total) = total.filter(|total| *total > 0.) {
        let used = used
            .or(remaining.map(|remaining| total - remaining))
            .unwrap_or(0.)
            .max(0.);
        windows.push(Window::new(
            Kind::Named("Token quota".into()),
            used / total * 100.,
            None,
            None,
        ));
        facts.push(("Tokens used".to_owned(), format!("{used:.0}/{total:.0}")));
    }
    if let Some(fuel) = fuel {
        let packages = fuel
            .get("list")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let left: Vec<f64> = packages
            .iter()
            .filter_map(|package| field(package, "availableToken"))
            .collect();
        let nearest = packages
            .iter()
            .filter_map(|package| expiry(package.get("expireTime")?))
            .min();
        if let Some(total) = field(fuel, "totalQuota").filter(|total| *total > 0.) {
            let remaining = if left.is_empty() {
                total
            } else {
                left.iter().sum::<f64>()
            };
            windows.push(Window::new(
                Kind::Named("Fuel pack".into()),
                (total - remaining).max(0.) / total * 100.,
                nearest,
                None,
            ));
            facts.push((
                "Fuel pack left".to_owned(),
                format!("{remaining:.0}/{total:.0}"),
            ));
        }
    }
    Report::new(
        Provider(&Longcat),
        Account {
            email: name,
            plan: None,
        },
        windows,
    )
    .with_sections((!facts.is_empty()).then(|| Section::Facts {
        title: "Quota".into(),
        facts,
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn data(body: &str) -> Value {
        payload(body).unwrap()
    }

    #[test]
    fn falls_back_to_legacy_token_usage() {
        let account = data(r#"{"code":0,"data":{"name":"LongCat User","token":"x"}}"#);
        let usage = data(
            r#"{"code":0,"data":{"usage":{"totalToken":500000,"usedToken":120000,
                "availableToken":380000,"freeAvailableToken":380000},
                "extData":{"LongCat-Flash-Lite":{"totalToken":50000000,"usedToken":0}}}}"#,
        );
        let fuel = data(r#"{"code":0,"data":{"totalQuota":0,"list":[]}}"#);
        let report = build(Some(&account), None, Some(&usage), Some(&fuel));
        assert_eq!(report.account.email.as_deref(), Some("LongCat User"));
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].used, 24.);
    }

    #[test]
    fn prefers_an_active_token_pack_lot() {
        let summary = data(
            r#"{"code":0,"data":{"currentLot":{"totalToken":50000000,"consumedToken":1212576,
                "consumedRatio":0.02425152,"status":"ACTIVE"}}}"#,
        );
        let stale =
            data(r#"{"usage":{"totalToken":500000,"usedToken":0,"availableToken":500000}}"#);
        assert!(active_lot(Some(&summary)).is_some());
        let report = build(None, Some(&summary), Some(&stale), None);
        assert!((report.windows[0].used - 2.425152).abs() < 1e-4);
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0].1, "1212576/50000000");
    }

    #[test]
    fn sums_fuel_packages_with_the_nearest_expiry() {
        let fuel = data(
            r#"{"totalQuota":1000,"list":[{"availableToken":600,"expireTime":1760000000000},
                {"availableToken":150,"expireTime":"2025-06-15T15:06:40Z"}]}"#,
        );
        let report = build(None, None, None, Some(&fuel));
        assert_eq!(report.windows.len(), 1);
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Named("Fuel pack".into()));
        assert_eq!(window.used, 25.);
        assert_eq!(
            window.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_750_000_000))
        );
    }

    #[test]
    fn envelope_codes_map_to_errors() {
        assert!(matches!(
            payload(r#"{"code":401,"message":"login"}"#),
            Err(Error::UsageRejected)
        ));
        assert!(matches!(
            payload(r#"{"code":"500","msg":"busy"}"#),
            Err(Error::UsageStatus(500))
        ));
        assert!(matches!(
            payload(r#"{"code":"x"}"#),
            Err(Error::UsageJson(_))
        ));
        assert_eq!(data(r#"{"code":200,"data":{"a":1}}"#)["a"], 1);
        assert_eq!(data(r#"{"a":1}"#)["a"], 1);
    }

    #[test]
    fn an_inactive_lot_is_ignored() {
        let summary = data(r#"{"currentLot":{"totalToken":10,"status":"EXPIRED"}}"#);
        assert!(active_lot(Some(&summary)).is_none());
        assert!(active_lot(Some(&data(r#"{"currentLot":null}"#))).is_none());
    }
}
