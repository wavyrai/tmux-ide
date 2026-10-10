//! Kimi Code (Kimi For Coding) quotas: the 5-hour rate limit, the weekly
//! request quota, and the monthly Total usage pool, in CodexBar's order:
//!
//! 1. a Kimi Code API key from the config or `KIMI_CODE_API_KEY`, sent to
//!    `GET {api}/coding/v1/usages`;
//! 2. the Kimi Code CLI's own sign-in, `$KIMI_CODE_HOME/credentials/kimi-code.json`
//!    (default `~/.kimi-code`), while its access token is fresh, with the CLI's
//!    device headers (China region only, as the file does not say which host
//!    issued it; it is never refreshed or rewritten);
//! 3. the web session token, the `kimi-auth` cookie's value, sent to the
//!    console's `GetUsages` call. It comes from the `token` setting
//!    (`KIMI_AUTH_TOKEN`), else from a Cookie header in the `cookie` setting
//!    (`KIMI_MANUAL_COOKIE`), else from Chrome or Safari for the region's
//!    site when Kimi is listed in `show_providers`.
//!
//! With a web token, API and CLI results are enriched as CodexBar does with
//! the membership pool (`GetSubscriptionStats`) and plan title
//! (`GetSubscription`); failures there never fail the report.
//!
//! Not ported: the Kimi Desktop app's cookie database, Chromium local
//! storage (where kimi.ai keeps `access_token`), retrying the next browser
//! session when one is rejected, and multiple labeled web accounts.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, SESSION, Section, WEEK, Window, group},
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::invalid,
    },
};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, SystemTime};

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Kimi;

static META: Meta = Meta::new("kimi", "Kimi Code")
    .dashboard("https://www.kimi.com/code/console")
    .settings(&[
        Setting::new(
            "api_key",
            &["KIMI_CODE_API_KEY"],
            "A Kimi Code API key from the Kimi Code console (https://www.kimi.com/code/console, \
             or https://www.kimi.ai/code/console for International). Not needed when the \
             Kimi Code CLI is signed in on the host.",
        ),
        Setting::new(
            "region",
            &[],
            "Which Kimi service the credentials belong to: \"china\" (the default, kimi.com) \
             or \"international\" (kimi.ai). Moonshot Open Platform keys belong to the \
             moonshot provider instead.",
        ),
        Setting::new(
            "base_url",
            &["KIMI_CODE_BASE_URL"],
            "An https Kimi Code API base to use with the API key instead of \
             https://api.kimi.com, for a compatible proxy. Setting it stops the CLI's \
             sign-in from being used.",
        ),
        Setting::new(
            "token",
            &["KIMI_AUTH_TOKEN"],
            "Your Kimi web session, for the membership pool and plan, or on its own. Sign in \
             at https://www.kimi.com/code/console, open Developer Tools → Application → \
             Cookies → https://www.kimi.com, and copy the value of the `kimi-auth` cookie \
             (a JWT starting with eyJ), without its name. On kimi.ai, copy `access_token` \
             from Local Storage instead. Not needed when Kimi is listed in show_providers \
             and you are signed in with Chrome or Safari.",
        ),
        Setting::new(
            "cookie",
            &["KIMI_MANUAL_COOKIE"],
            "Instead of token, a whole Kimi Cookie header that includes kimi-auth, as \
             \"kimi-auth=value; …\".",
        ),
    ]);

impl Service for Kimi {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let region = Region::from(probe.text_setting("region").as_deref());
        let web = probe
            .setting("token")
            .or_else(|| probe.cookie_value(&region.cookie_domains(), "kimi-auth"));
        let base_url = probe.text_setting("base_url");

        if let Some(key) = probe.setting("api_key") {
            let base = base_url
                .filter(|url| url.starts_with("https://"))
                .unwrap_or_else(|| region.api().into());
            let request = Request::get(usages_url(&base)).bearer(&key);
            return Some(code(probe, request, web.as_ref(), region));
        }

        if region == Region::China && base_url.is_none() {
            let home = |rest: &str| HostPath::env_or("KIMI_CODE_HOME", ".kimi-code", rest);
            if let Some(file) = probe.file(&home("credentials/kimi-code.json")) {
                let fresh = probe
                    .text(&file, &["expires_at"])
                    .and_then(|expiry| expiry.parse::<f64>().ok())
                    .and_then(|expiry| Timestamp::Number(expiry).time())
                    .is_some_and(|expiry| expiry > SystemTime::now() + Duration::from_secs(60));
                match probe.field(&file, &["access_token"]).filter(|_| fresh) {
                    Some(token) => {
                        let device = probe
                            .read(&home("device_id"))
                            .map(|id| ascii(id.trim()))
                            .filter(|id| !id.is_empty());
                        let system = if probe.is_macos() { "macOS" } else { "Linux" };
                        let mut request = Request::get(usages_url(region.api()))
                            .bearer(&token)
                            .header(
                                "User-Agent",
                                concat!("herdr-gpui/", env!("CARGO_PKG_VERSION")),
                            )
                            .header("X-Msh-Platform", "kimi_code_cli")
                            .header("X-Msh-Version", env!("CARGO_PKG_VERSION"))
                            .header("X-Msh-Device-Model", system);
                        if let Some(device) = device {
                            request = request.header("X-Msh-Device-Id", device);
                        }
                        return Some(code(probe, request, web.as_ref(), region));
                    }
                    // CodexBar never refreshes the CLI's token: sign in again there.
                    None if web.is_none() => return Some(Err(Error::UsageRejected)),
                    None => {}
                }
            }
        }

        let token = web?;
        Some(web_usage(probe, &token, region))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Region {
    China,
    International,
}

impl From<Option<&str>> for Region {
    fn from(value: Option<&str>) -> Self {
        match value
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("international" | "global" | "kimi.ai") => Self::International,
            _ => Self::China,
        }
    }
}

impl Region {
    fn api(self) -> &'static str {
        match self {
            Self::China => "https://api.kimi.com",
            Self::International => "https://api.kimi.ai",
        }
    }

    /// The sites whose `kimi-auth` cookie is the web session, as CodexBar
    /// imports it.
    fn cookie_domains(self) -> [&'static str; 2] {
        match self {
            Self::China => ["www.kimi.com", "kimi.com"],
            Self::International => ["www.kimi.ai", "kimi.ai"],
        }
    }

    fn web(self) -> &'static str {
        match self {
            Self::China => "https://www.kimi.com",
            Self::International => "https://www.kimi.ai",
        }
    }
}

/// `…/coding/v1/usages`, whether the base ends at the host, `coding`, or
/// `coding/v1`.
fn usages_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/coding/v1") {
        format!("{base}/usages")
    } else if base.ends_with("/coding") {
        format!("{base}/v1/usages")
    } else {
        format!("{base}/coding/v1/usages")
    }
}

fn code(
    probe: &mut Probe,
    request: Request,
    web: Option<&Secret>,
    region: Region,
) -> Result<Report> {
    let body = probe.body(request.header("Accept", "application/json"))?;
    let mut usage = parse_code(&body)?;
    if let Some(token) = web {
        enrich(probe, token, region, &mut usage);
    }
    Ok(usage.report())
}

fn web_usage(probe: &mut Probe, token: &Secret, region: Region) -> Result<Report> {
    let body = probe.body(
        web_request(
            region,
            "kimi.gateway.billing.v1.BillingService/GetUsages",
            token,
        )
        .json(r#"{"scope":["FEATURE_CODING"]}"#),
    )?;
    let mut usage = parse_web(&body)?;
    enrich(probe, token, region, &mut usage);
    Ok(usage.report())
}

/// The membership pool and plan title, best effort: the quota stands without
/// them.
fn enrich(probe: &mut Probe, token: &Secret, region: Region, usage: &mut Usage) {
    let mut call = |method: &str| {
        probe
            .body(web_request(region, method, token).json("{}"))
            .ok()
    };
    if let Some(stats) = call("kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats")
        .and_then(|body| parse_stats(&body))
    {
        usage.monthly = usage.monthly.take().or(stats.monthly);
        usage.code_weekly = stats.code_weekly;
    }
    if usage.plan.is_none() {
        usage.plan = call("kimi.gateway.membership.v2.MembershipService/GetSubscription")
            .and_then(|body| parse_plan(&body));
    }
}

fn web_request(region: Region, method: &str, token: &Secret) -> Request {
    let origin = region.web();
    Request::post(format!("{origin}/apiv2/{method}"))
        .bearer(token)
        .secret_header("Cookie", "kimi-auth=", token)
        .header("Origin", origin)
        .header("Referer", format!("{origin}/code/console"))
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("User-Agent", USER_AGENT)
        .header("connect-protocol-version", "1")
        .header("x-language", "en-US")
        .header("x-msh-platform", "web")
}

/// What the Code API or the console reports, before it becomes a report.
#[derive(Debug, Default)]
pub(crate) struct Usage {
    weekly: Option<Window>,
    session: Option<Window>,
    monthly: Option<Window>,
    code_weekly: Option<Window>,
    weekly_requests: Option<(f64, f64)>,
    session_requests: Option<(f64, f64)>,
    plan: Option<String>,
}

impl Usage {
    pub(crate) fn report(self) -> Report {
        let distinct = self.code_weekly.filter(|code| {
            !self.weekly.as_ref().is_some_and(|weekly| {
                weekly.length.is_some()
                    && (weekly.used - code.used).abs() <= 1.
                    && weekly.resets_at.zip(code.resets_at).is_some_and(|(a, b)| {
                        a.max(b).duration_since(a.min(b)).unwrap_or_default()
                            <= Duration::from_secs(300)
                    })
            })
        });
        let requests = |(used, limit): (f64, f64)| {
            format!(
                "{} of {}",
                group(used.round() as i64),
                group(limit.round() as i64)
            )
        };
        let facts: Vec<(String, String)> = [
            ("Weekly requests", self.weekly_requests.map(requests)),
            ("Rate limit requests", self.session_requests.map(requests)),
        ]
        .into_iter()
        .filter_map(|(label, value)| Some((label.to_owned(), value?)))
        .collect();
        let windows = [self.session, self.weekly, self.monthly]
            .into_iter()
            .flatten()
            .collect();
        Report::new(
            Provider(&Kimi),
            Account {
                email: None,
                plan: self.plan,
            },
            windows,
        )
        .with_sections(distinct.map(Section::Limit).into_iter().chain(
            (!facts.is_empty()).then(|| Section::Facts {
                title: "Requests".into(),
                facts,
            }),
        ))
    }
}

/// `GET /coding/v1/usages`: ratio pools take precedence over the older
/// request counts for the windows they report.
pub(crate) fn parse_code(body: &str) -> Result<Usage> {
    let response: CodeResponse = json(body)?;
    let pools = response.usages.unwrap_or_default();
    let limit = response.limits.as_ref().and_then(|limits| limits.first());
    let session_minutes = limit.map_or(Some(300), |limit| {
        limit.window.as_ref().and_then(RateWindow::minutes)
    });
    let has_monthly = pools.limit_month_total.is_some();
    let weekly_counts = response.usage.as_ref().and_then(Detail::counts);

    let weekly = resolve(
        pools.limit_7d.as_ref(),
        response.usage.as_ref(),
        WEEK,
        Some(7 * 24 * 60),
        has_monthly,
        weekly_counts,
    )
    .or_else(|| {
        response
            .usage
            .as_ref()
            .and_then(|detail| detail.window(Kind::Weekly, Some(WEEK)))
    });
    let session = resolve(
        pools.limit_5h.as_ref(),
        limit.map(|limit| &limit.detail),
        SESSION,
        session_minutes,
        has_monthly,
        weekly_counts,
    )
    .or_else(|| {
        let length = session_minutes.map(|minutes| Duration::from_secs(u64::from(minutes) * 60));
        limit.and_then(|limit| limit.detail.window(Kind::Session, length))
    });
    let monthly = pools
        .limit_month_total
        .as_ref()
        .and_then(|pool| pool.window(total_usage(), MONTH));
    if weekly.is_none() && session.is_none() && monthly.is_none() {
        return Err(invalid());
    }
    Ok(Usage {
        weekly,
        session,
        monthly,
        code_weekly: None,
        weekly_requests: weekly_counts
            .filter(|counts| counts.2)
            .map(|(used, limit, _)| (used, limit)),
        session_requests: limit
            .and_then(|limit| limit.detail.counts())
            .filter(|counts| counts.2)
            .map(|(used, limit, _)| (used, limit)),
        plan: plan_name(response.user.as_ref(), response.version.as_ref()),
    })
}

/// The console's `GetUsages` answer, for the `FEATURE_CODING` scope.
pub(crate) fn parse_web(body: &str) -> Result<Usage> {
    let response: WebResponse = json(body)?;
    let coding = response
        .usages
        .into_iter()
        .find(|usage| usage.scope == "FEATURE_CODING")
        .ok_or_else(invalid)?;
    let limit = coding.limits.as_ref().and_then(|limits| limits.first());
    let length = limit.map_or(Some(SESSION), |limit| {
        limit
            .window
            .as_ref()
            .and_then(RateWindow::minutes)
            .map(|minutes| Duration::from_secs(u64::from(minutes) * 60))
    });
    let counts = |detail: &Detail| {
        detail
            .counts()
            .filter(|counts| counts.2)
            .map(|(u, l, _)| (u, l))
    };
    Ok(Usage {
        weekly: coding.detail.window(Kind::Weekly, Some(WEEK)),
        session: limit.and_then(|limit| limit.detail.window(Kind::Session, length)),
        monthly: None,
        code_weekly: None,
        weekly_requests: counts(&coding.detail),
        session_requests: limit.and_then(|limit| counts(&limit.detail)),
        plan: None,
    })
}

pub(crate) struct Stats {
    monthly: Option<Window>,
    code_weekly: Option<Window>,
}

/// `GetSubscriptionStats`: the shared subscription pool and the Code-only
/// 7-day limit.
pub(crate) fn parse_stats(body: &str) -> Option<Stats> {
    let stats: StatsResponse = serde_json::from_str(body).ok()?;
    let monthly = stats.subscription_balance.and_then(|balance| {
        let feature_ok = balance
            .feature
            .as_deref()
            .is_none_or(|feature| feature == "FEATURE_OMNI");
        let type_ok = balance
            .kind
            .as_deref()
            .is_none_or(|kind| kind == "SUBSCRIPTION");
        let ratio = balance
            .amount_used_ratio
            .filter(|ratio| ratio.is_finite())?;
        (feature_ok && type_ok).then(|| {
            Window::new(
                total_usage(),
                ratio * 100.,
                balance.expire_time.as_ref().and_then(Timestamp::time),
                Some(MONTH),
            )
        })
    });
    let code_weekly = stats.ratelimit_code_7d.and_then(|limit| {
        if limit.enabled == Some(false) {
            return None;
        }
        let ratio = limit.ratio.filter(|ratio| ratio.is_finite())?;
        Some(Window::new(
            Kind::Named("Code 7-day".into()),
            ratio * 100.,
            limit.reset_time.as_ref().and_then(Timestamp::time),
            Some(WEEK),
        ))
    });
    Some(Stats {
        monthly,
        code_weekly,
    })
}

/// `GetSubscription`: the active plan's title.
pub(crate) fn parse_plan(body: &str) -> Option<String> {
    let response: Value = serde_json::from_str(body).ok()?;
    let subscription = response.get("subscription")?;
    let active = subscription.get("active").and_then(Value::as_bool) == Some(true)
        && subscription.get("status").and_then(Value::as_str) == Some("SUBSCRIPTION_STATUS_ACTIVE");
    let title = subscription.get("goods")?.get("title")?.as_str()?.trim();
    (active && !title.is_empty()).then(|| title.to_owned())
}

fn total_usage() -> Kind {
    Kind::Named("Total usage".into())
}

/// A ratio pool, unless it is a zero placeholder next to populated counts
/// for the same window and reset, which mixed older answers carry.
fn resolve(
    pool: Option<&Pool>,
    detail: Option<&Detail>,
    length: Duration,
    count_minutes: Option<u32>,
    has_monthly: bool,
    weekly_counts: Option<(f64, f64, bool)>,
) -> Option<Window> {
    let kind = if length == WEEK {
        Kind::Weekly
    } else {
        Kind::Session
    };
    let window = pool?.window(kind, length)?;
    let placeholder = window.used == 0.
        && !has_monthly
        && weekly_counts.is_some_and(|counts| counts.2)
        && count_minutes == u32::try_from(length.as_secs() / 60).ok()
        && detail.is_some_and(|detail| {
            let counts = detail
                .counts()
                .filter(|(used, _, reliable)| *reliable && *used > 0.);
            let reset = detail.reset.as_ref().and_then(Timestamp::time);
            counts.is_some()
                && reset.zip(window.resets_at).is_some_and(|(a, b)| {
                    a.max(b).duration_since(a.min(b)).unwrap_or_default() <= Duration::from_secs(2)
                })
        });
    (!placeholder).then_some(window)
}

/// The V1 membership catalog's names; unknown levels are kept as sent.
fn plan_name(user: Option<&Value>, version: Option<&Value>) -> Option<String> {
    let level = user?.get("membership")?.get("level")?.as_str()?.trim();
    if level.is_empty() || level == "LEVEL_UNSPECIFIED" {
        return None;
    }
    let v1 = match version {
        None | Some(Value::Null) => true,
        Some(Value::String(version)) => version == "GOODS_VERSION_V1",
        Some(_) => false,
    };
    let name = match level {
        _ if !v1 => level,
        "LEVEL_FREE" => "Adagio",
        "LEVEL_TRIAL" => "Andante",
        "LEVEL_BASIC" => "Moderato",
        "LEVEL_INTERMEDIATE" => "Allegretto",
        "LEVEL_ADVANCED" => "Allegro",
        other => other,
    };
    Some(name.to_owned())
}

/// Header values must be visible ASCII.
fn ascii(value: &str) -> String {
    value.chars().filter(|c| (' '..='~').contains(c)).collect()
}

#[derive(Deserialize)]
struct CodeResponse {
    usage: Option<Detail>,
    usages: Option<Pools>,
    limits: Option<Vec<RateLimit>>,
    user: Option<Value>,
    version: Option<Value>,
}

#[derive(Default, Deserialize)]
struct Pools {
    limit_5h: Option<Pool>,
    limit_7d: Option<Pool>,
    limit_month_total: Option<Pool>,
}

#[derive(Deserialize)]
struct Pool {
    #[serde(default, deserialize_with = "number")]
    used_ratio: Option<f64>,
    reset_time: Option<Timestamp>,
}

impl Pool {
    fn window(&self, kind: Kind, length: Duration) -> Option<Window> {
        let ratio = self
            .used_ratio
            .filter(|ratio| ratio.is_finite() && *ratio >= 0.)?;
        Some(Window::new(
            kind,
            ratio.min(1.) * 100.,
            self.reset_time.as_ref().and_then(Timestamp::time),
            Some(length),
        ))
    }
}

#[derive(Deserialize)]
struct Detail {
    #[serde(default, deserialize_with = "number")]
    limit: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    used: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    remaining: Option<f64>,
    #[serde(
        rename = "resetTime",
        alias = "resetAt",
        alias = "reset_time",
        alias = "reset_at"
    )]
    reset: Option<Timestamp>,
}

impl Detail {
    /// Used and limit, and whether the counters were consistent; used may
    /// exceed the limit during overage.
    fn counts(&self) -> Option<(f64, f64, bool)> {
        let limit = self
            .limit
            .filter(|limit| limit.is_finite() && *limit > 0.)?;
        if let Some(used) = self.used.filter(|used| used.is_finite() && *used >= 0.) {
            return Some((used, limit, true));
        }
        if let Some(remaining) = self
            .remaining
            .filter(|remaining| (0. ..=limit).contains(remaining))
        {
            return Some((limit - remaining, limit, true));
        }
        Some((0., limit, false))
    }

    /// Inconsistent counters keep a gauge but lose their length, so they
    /// cannot suggest a pace.
    fn window(&self, kind: Kind, length: Option<Duration>) -> Option<Window> {
        let (used, limit, reliable) = self.counts()?;
        Some(Window::new(
            kind,
            used / limit * 100.,
            self.reset.as_ref().and_then(Timestamp::time),
            length.filter(|_| reliable),
        ))
    }
}

#[derive(Deserialize)]
struct RateLimit {
    window: Option<RateWindow>,
    detail: Detail,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateWindow {
    duration: i64,
    time_unit: String,
}

impl RateWindow {
    fn minutes(&self) -> Option<u32> {
        let unit = match self.time_unit.as_str() {
            "TIME_UNIT_MINUTE" => 1,
            "TIME_UNIT_HOUR" => 60,
            "TIME_UNIT_DAY" => 24 * 60,
            _ => return None,
        };
        u32::try_from(self.duration)
            .ok()
            .filter(|duration| *duration > 0)?
            .checked_mul(unit)
    }
}

#[derive(Deserialize)]
struct WebResponse {
    usages: Vec<WebUsage>,
}

#[derive(Deserialize)]
struct WebUsage {
    scope: String,
    detail: Detail,
    limits: Option<Vec<RateLimit>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsResponse {
    subscription_balance: Option<SubscriptionBalance>,
    #[serde(rename = "ratelimitCode7d")]
    ratelimit_code_7d: Option<CodeLimit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionBalance {
    feature: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "number")]
    amount_used_ratio: Option<f64>,
    expire_time: Option<Timestamp>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeLimit {
    #[serde(default, deserialize_with = "number")]
    ratio: Option<f64>,
    enabled: Option<bool>,
    reset_time: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(text: &str) -> SystemTime {
        Timestamp::Text(text.into()).time().unwrap()
    }

    /// The Code API answer documented in CodexBar's `docs/kimi.md`.
    const COUNTS: &str = r#"{
      "usage":{"limit":"2048","used":"214","remaining":"1834","resetTime":"2026-01-09T15:23:13.716839300Z"},
      "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
        "detail":{"limit":"200","used":"139","remaining":"61","resetTime":"2026-01-06T13:33:02.717479433Z"}}],
      "user":{"membership":{"level":"LEVEL_BASIC"}}
    }"#;

    #[test]
    fn reads_request_counts() {
        let report = parse_code(COUNTS).unwrap().report();
        assert_eq!(report.account.plan.as_deref(), Some("Moderato"));
        let session = &report.windows[0];
        assert_eq!(session.kind, Kind::Session);
        assert!((session.used - 69.5).abs() < 1e-4);
        assert_eq!(session.length, Some(SESSION));
        let weekly = &report.windows[1];
        assert_eq!(weekly.kind, Kind::Weekly);
        assert!((weekly.used - 10.449_219).abs() < 1e-4);
        assert_eq!(weekly.length, Some(WEEK));
        assert!(weekly.resets_at.is_some());
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Requests".into(),
                facts: vec![
                    ("Weekly requests".into(), "214 of 2,048".into()),
                    ("Rate limit requests".into(), "139 of 200".into()),
                ],
            }]
        );
    }

    #[test]
    fn ratio_pools_take_precedence() {
        // CodexBar's ratio-pool fixture: a monthly pool keeps a zero 5-hour ratio.
        let body = r#"{
          "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
            "detail":{"limit":"100","used":"25","remaining":"75"}}],
          "usages":{
            "limit_5h":{"used_ratio":0,"reset_time":"2026-09-16T20:15:44Z"},
            "limit_month_total":{"used_ratio":0.0056,"reset_time":"2026-10-17T00:00:00Z"},
            "limit_month_code":{"used_ratio":0,"reset_time":"2026-10-17T00:00:00Z"}
          }
        }"#;
        let report = parse_code(body).unwrap().report();
        assert_eq!(report.account.plan, None);
        assert_eq!(report.windows.len(), 2);
        let session = &report.windows[0];
        assert_eq!(session.kind, Kind::Session);
        assert_eq!(session.used, 0.);
        assert_eq!(session.resets_at, Some(at("2026-09-16T20:15:44Z")));
        let monthly = &report.windows[1];
        assert_eq!(monthly.kind, Kind::Named("Total usage".into()));
        assert!((monthly.used - 0.56).abs() < 1e-4);
        assert_eq!(monthly.length, Some(MONTH));
    }

    #[test]
    fn a_zero_ratio_placeholder_yields_to_matching_counts() {
        let body = r#"{
          "usage":{"limit":"100","used":"40","resetTime":"2026-09-20T00:00:01Z"},
          "usages":{"limit_7d":{"used_ratio":0,"reset_time":"2026-09-20T00:00:00Z"}}
        }"#;
        let report = parse_code(body).unwrap().report();
        assert_eq!(report.windows[0].kind, Kind::Weekly);
        assert_eq!(report.windows[0].percent(), 40);
    }

    #[test]
    fn rejects_an_answer_without_windows() {
        assert!(matches!(parse_code("{}"), Err(Error::UsageJson(_))));
    }

    #[test]
    fn reads_the_console_usage_and_enrichment() {
        let body = r#"{"usages":[{"scope":"FEATURE_CODING",
          "detail":{"limit":"2048","used":"214","remaining":"1834","resetTime":"2026-01-09T15:23:13.716839300Z"},
          "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
            "detail":{"limit":"200","used":"139","remaining":"61","resetTime":"2026-01-06T13:33:02.717479433Z"}}]}]}"#;
        let mut usage = parse_web(body).unwrap();
        let stats = parse_stats(
            r#"{"subscriptionBalance":{"feature":"FEATURE_OMNI","type":"SUBSCRIPTION","amountUsedRatio":0.42,
                "expireTime":"2026-02-01T00:00:00Z"},
               "ratelimitCode7d":{"ratio":0.5,"enabled":true,"resetTime":"2026-01-10T00:00:00Z"}}"#,
        )
        .unwrap();
        usage.monthly = stats.monthly;
        usage.code_weekly = stats.code_weekly;
        usage.plan = parse_plan(
            r#"{"subscription":{"active":true,"status":"SUBSCRIPTION_STATUS_ACTIVE","goods":{"title":"Allegretto"}}}"#,
        );
        let report = usage.report();
        assert_eq!(report.account.plan.as_deref(), Some("Allegretto"));
        assert_eq!(report.windows.len(), 3);
        assert_eq!(report.windows[2].kind, Kind::Named("Total usage".into()));
        assert_eq!(report.windows[2].percent(), 42);
        // The Code 7-day ratio differs from the weekly counts, so it shows.
        assert!(matches!(
            &report.sections[0],
            Section::Limit(window) if window.kind == Kind::Named("Code 7-day".into()) && window.percent() == 50
        ));
    }

    #[test]
    fn session_cookies_follow_the_region() {
        assert_eq!(Region::China.cookie_domains(), ["www.kimi.com", "kimi.com"]);
        assert_eq!(
            Region::International.cookie_domains(),
            ["www.kimi.ai", "kimi.ai"]
        );
    }

    #[test]
    fn parses_bases_and_regions() {
        assert_eq!(
            usages_url("https://api.kimi.com"),
            "https://api.kimi.com/coding/v1/usages"
        );
        assert_eq!(
            usages_url("https://proxy.example/coding/"),
            "https://proxy.example/coding/v1/usages"
        );
        assert_eq!(
            usages_url("https://proxy.example/coding/v1"),
            "https://proxy.example/coding/v1/usages"
        );
        assert_eq!(Region::from(None), Region::China);
        assert_eq!(Region::from(Some("International")), Region::International);
        assert_eq!(
            parse_plan(r#"{"subscription":{"active":false,"goods":{"title":"X"}}}"#),
            None
        );
    }
}
