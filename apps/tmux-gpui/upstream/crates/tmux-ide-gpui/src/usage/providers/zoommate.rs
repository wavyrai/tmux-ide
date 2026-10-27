//! ZoomMate credits, read from the first-party web client's
//! `credits/status` endpoint. The sign-in is either a bearer `token` copied
//! from that request (it expires about hourly), or Zoom session cookies from
//! the `cookie` setting or Chrome/Safari, which the web client's login
//! bootstrap exchanges for a fresh bearer on every refresh. Both API hosts,
//! `ai.zoom.us` then `zoommate.zoom.us`, are tried as CodexBar does.
//!
//! Not ported: the account email, which only arrives in the bootstrap
//! response next to the bearer and so would bring the credential back; the
//! 30-day `credits/history` dashboard; and CodexBar's per-host narrowing of
//! the parent-domain cookies, since the probe takes one cookie header.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::Duration;

const HOSTS: [&str; 2] = ["ai.zoom.us", "zoommate.zoom.us"];
const STATUS: &str = "/ai-computer/api/v1/credits/status";
const LOGIN: &str = "/ai-computer/api/v1/login/?continue=https%3A%2F%2Fzoommate.zoom.us%2F";
const ORIGIN: &str = "https://zoommate.zoom.us";
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const DOMAINS: &[&str] = &["ai.zoom.us", "zoommate.zoom.us", "zoom.us"];

pub(crate) struct Zoommate;

static META: Meta = Meta::new("zoommate", "ZoomMate")
    .dashboard("https://zoommate.zoom.us/#/?settings=credit-usage")
    .status_page("https://www.zoomstatus.com")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "Your Zoom session cookies. Sign in at https://zoommate.zoom.us, open Developer \
             Tools > Application > Cookies for https://zoommate.zoom.us (Zoom's sign-in \
             cookies such as _zm_ssid, _zm_lang and cf_clearance live on zoom.us), and \
             paste them all as \"name=value; name2=value2\". They are exchanged for a \
             short-lived token on every refresh.",
        ),
        Setting::new(
            "token",
            &[],
            "A bearer token instead of cookies: on https://zoommate.zoom.us open Developer \
             Tools > Network, reload the AI credit usage page, select the credits/status \
             request and copy its Authorization header without \"Bearer \". It expires \
             after about an hour.",
        ),
    ]);

impl Service for Zoommate {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let token = probe.setting("token");
        let cookie = probe.cookies(DOMAINS, &[]);
        let token = match (token, &cookie) {
            (Some(token), _) => token,
            (None, Some(cookie)) => match mint(probe, cookie) {
                Ok(token) => token,
                Err(error) => return Some(Err(error)),
            },
            (None, None) => return None,
        };
        Some(
            failover(|host| {
                let mut request =
                    headers(Request::get(format!("https://{host}{STATUS}"))).bearer(&token);
                if let Some(cookie) = &cookie {
                    request = request.cookie(cookie);
                }
                probe.body(request)
            })
            .and_then(|body| parse(&body)),
        )
    }
}

/// Exchanges the session cookies for the web client's bearer (`data.nak`).
fn mint(probe: &mut Probe, cookie: &Secret) -> Result<Secret> {
    failover(|host| {
        let request = headers(Request::get(format!("https://{host}{LOGIN}"))).cookie(cookie);
        probe.exchange(request, &["data", "nak"])
    })
}

/// The hosts serve the same API; a rejection or a malformed answer comes
/// from a host that answered, so only other failures move to the next one.
fn failover<T>(mut attempt: impl FnMut(&str) -> Result<T>) -> Result<T> {
    let mut last = Error::UsageConnect;
    for host in HOSTS {
        match attempt(host) {
            Ok(value) => return Ok(value),
            Err(error @ (Error::UsageRejected | Error::UsageJson(_))) => return Err(error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn headers(request: Request) -> Request {
    request
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("User-Agent", AGENT)
        .header("Origin", ORIGIN)
        .header("Referer", ORIGIN)
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-site")
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let status = json::<Envelope>(body)?
        .data
        .and_then(|data| data.credit_status)
        .ok_or_else(invalid)?;
    let cap = status.budget_cap.unwrap_or(0.);
    let used = status.used_credit.unwrap_or(0.);
    let unlimited = status.is_unlimited.unwrap_or(false) || cap <= 0.;
    let time = |millis: Option<f64>| millis.and_then(|at| Timestamp::Number(at).time());
    let (start, end) = (time(status.cycle_start_date), time(status.cycle_end_date));
    let length = start
        .zip(end)
        .and_then(|(start, end)| end.duration_since(start).ok())
        .filter(|length| *length >= Duration::from_secs(3600))
        .unwrap_or(MONTH);
    let windows = if unlimited {
        Vec::new()
    } else {
        vec![Window::new(
            Kind::Monthly,
            used / cap * 100.,
            end,
            Some(length),
        )]
    };
    let balance = if unlimited {
        Balance::new("Credits used", used, Unit::Count("credits".into()))
    } else {
        let left = status.remaining_credit.unwrap_or(cap - used).max(0.);
        Balance::new("Credits left", left, Unit::Count("credits".into())).out_of(cap)
    };
    let mut facts = Vec::new();
    if unlimited {
        facts.push(("Budget".into(), "Unlimited".into()));
    }
    if let Some(overage) = status.overage_credit.filter(|overage| *overage > 0.) {
        facts.push(("Overage".into(), format!("{overage:.2} credits")));
    }
    if status.is_quota_available == Some(false) {
        facts.push(("Quota".into(), "Exhausted".into()));
    }
    Ok(
        Report::new(Provider(&Zoommate), Account::default(), windows)
            .with_balances([balance])
            .with_sections((!facts.is_empty()).then(|| Section::Facts {
                title: "Credits".into(),
                facts,
            })),
    )
}

#[derive(Deserialize)]
struct Envelope {
    data: Option<Data>,
}

#[derive(Deserialize)]
struct Data {
    credit_status: Option<CreditStatus>,
}

#[derive(Deserialize)]
struct CreditStatus {
    budget_cap: Option<f64>,
    used_credit: Option<f64>,
    remaining_credit: Option<f64>,
    overage_credit: Option<f64>,
    /// Epoch milliseconds.
    cycle_start_date: Option<f64>,
    cycle_end_date: Option<f64>,
    is_quota_available: Option<bool>,
    is_unlimited: Option<bool>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    const STATUS_BODY: &str = r#"{ "data": { "credit_status": {
      "budget_cap": 12345.0, "used_credit": 678.0, "remaining_credit": 11667.0,
      "overage_credit": 0.0, "allow_overage": false,
      "cycle_start_date": 1893456000000, "cycle_end_date": 1896134399000,
      "is_quota_available": true, "is_unlimited": false } },
      "status_code": 200, "error_message": null }"#;

    #[test]
    fn parses_credit_window_and_balance() {
        let report = parse(STATUS_BODY).unwrap();
        assert_eq!(report.windows.len(), 1);
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 678. / 12345. * 100.).abs() < 0.001);
        assert_eq!(
            window.resets_at,
            SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(1_896_134_399))
        );
        assert_eq!(window.length, Some(Duration::from_secs(2_678_399)));
        assert_eq!(report.balances[0].amount, 11667.);
        assert_eq!(report.balances[0].total, Some(12345.));
        assert!(report.sections.is_empty());
    }

    #[test]
    fn unlimited_budget_has_no_window() {
        let body = STATUS_BODY.replace("\"is_unlimited\": false", "\"is_unlimited\": true");
        let report = parse(&body).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Credits used");
        assert_eq!(report.balances[0].amount, 678.);
    }

    #[test]
    fn missing_credit_status_is_an_error() {
        assert!(parse(r#"{"data": {}}"#).is_err());
    }

    #[test]
    fn failover_stops_on_rejection() {
        let mut tried = Vec::new();
        let result: Result<()> = failover(|host| {
            tried.push(host.to_owned());
            Err(Error::UsageRejected)
        });
        assert!(matches!(result, Err(Error::UsageRejected)));
        assert_eq!(tried, ["ai.zoom.us"]);
        let mut tried = Vec::new();
        let result = failover(|host| {
            tried.push(host.to_owned());
            if host == "ai.zoom.us" {
                Err(Error::UsageStatus(502))
            } else {
                Ok(host.len())
            }
        });
        assert_eq!(result.unwrap(), "zoommate.zoom.us".len());
    }
}
