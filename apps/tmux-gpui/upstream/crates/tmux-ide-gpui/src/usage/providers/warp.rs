//! Warp credits, read from Warp's GraphQL API with an API key: the `api_key`
//! setting (or `WARP_API_KEY` / `WARP_TOKEN` here), else those variables on
//! the probed host. Everything CodexBar reads is ported: monthly credits with
//! their refresh time, and add-on (bonus) credits granted to the user and its
//! workspaces with the earliest expiry. The Warp app's own sign-in is not
//! read, as CodexBar does not read it either.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use serde_json::Value;
use std::time::SystemTime;

const URL: &str = "https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo";
/// Warp's edge limiter answers 429 unless the agent looks like its client.
const AGENT: &str = "Warp/1.0";
const QUERY: &str = "query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    __typename
    ... on UserOutput {
      user {
        requestLimitInfo { isUnlimited nextRefreshTime requestLimit requestsUsedSinceLastRefresh }
        bonusGrants { requestCreditsGranted requestCreditsRemaining expiration }
        workspaces { bonusGrantsInfo { grants { requestCreditsGranted requestCreditsRemaining expiration } } }
      }
    }
  }
}";

pub(crate) struct Warp;

static META: Meta = Meta::new("warp", "Warp")
    .dashboard("https://app.warp.dev/settings/billing")
    .status_page("https://status.warp.dev")
    .settings(&[Setting::new(
        "api_key",
        &["WARP_API_KEY", "WARP_TOKEN"],
        "A Warp API key (wk-…). In Warp open your profile menu, then Settings → Platform → \
         API Keys, and create one. See https://docs.warp.dev/reference/cli/api-keys.",
    )]);

impl Service for Warp {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("WARP_API_KEY"))
            .or_else(|| probe.env("WARP_TOKEN"))?;
        let os = if probe.is_macos() { "macOS" } else { "Linux" };
        let body = serde_json::json!({
            "query": QUERY,
            "operationName": "GetRequestLimitInfo",
            "variables": {
                "requestContext": {
                    "clientContext": {},
                    "osContext": { "category": os, "name": os, "version": "0.0.0" }
                }
            }
        });
        let request = Request::post(URL)
            .bearer(&key)
            .header("Accept", "application/json")
            .header("User-Agent", AGENT)
            .header("x-warp-client-id", "warp-app")
            .header("x-warp-os-category", os)
            .header("x-warp-os-name", os)
            .header("x-warp-os-version", "0.0.0")
            .json(body.to_string());
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let response: Response = json(body)?;
    // GraphQL reports a refused key as errors in a 200 answer.
    if response.errors.is_some_and(|errors| !errors.is_empty()) {
        return Err(Error::UsageRejected);
    }
    let user = response
        .data
        .and_then(|data| data.user)
        .and_then(|user| user.user)
        .ok_or_else(invalid)?;
    let limits = user.request_limit_info.ok_or_else(invalid)?;
    let unlimited = limits.is_unlimited.as_ref().is_some_and(flag);
    let limit = limits.request_limit.as_ref().map_or(0, count);
    let used = limits
        .requests_used_since_last_refresh
        .as_ref()
        .map_or(0, count);
    let monthly = if unlimited {
        Window::new(Kind::Monthly, 0., None, None)
    } else {
        Window::new(
            Kind::Monthly,
            if limit > 0 {
                used as f64 / limit as f64 * 100.
            } else {
                0.
            },
            limits.next_refresh_time.as_ref().and_then(Timestamp::time),
            Some(MONTH),
        )
    };
    let grants: Vec<&Grant> = user
        .bonus_grants
        .iter()
        .flatten()
        .chain(
            user.workspaces
                .iter()
                .flatten()
                .filter_map(|workspace| workspace.bonus_grants_info.as_ref())
                .flat_map(|info| info.grants.iter().flatten()),
        )
        .collect();
    let granted: i64 = grants.iter().map(|grant| grant.granted()).sum();
    let remaining: i64 = grants.iter().map(|grant| grant.remaining()).sum();
    let bonus = (granted > 0 || remaining > 0).then(|| {
        let balance = Balance::new(
            "Add-on credits",
            remaining.max(0) as f64,
            Unit::Count("credits".into()),
        );
        if granted > 0 {
            balance.out_of(granted as f64)
        } else {
            balance
        }
    });
    let expiring = grants
        .iter()
        .filter(|grant| grant.remaining() > 0)
        .filter_map(|grant| Some((grant.expires()?, grant.remaining())))
        .min_by_key(|(at, _)| *at);
    let mut facts = vec![(
        "Monthly credits".to_owned(),
        if unlimited {
            "Unlimited".to_owned()
        } else {
            format!("{} of {}", group(used), group(limit))
        },
    )];
    if let Some((at, _)) = expiring {
        let soonest: i64 = grants
            .iter()
            .filter(|grant| grant.remaining() > 0 && grant.expires() == Some(at))
            .map(|grant| grant.remaining())
            .sum();
        let date = chrono::DateTime::<chrono::Utc>::from(at).format("%b %-d, %Y");
        facts.push((
            "Next add-on expiry".to_owned(),
            format!("{} credits on {date}", group(soonest)),
        ));
    }
    Ok(Report::new(
        Provider(&Warp),
        Account {
            email: None,
            plan: unlimited.then(|| "Unlimited".to_owned()),
        },
        vec![monthly],
    )
    .with_balances(bonus)
    .with_sections([Section::Facts {
        title: "Credits".into(),
        facts,
    }]))
}

/// Warp sends counts as numbers or numeric strings.
fn count(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64))
            .unwrap_or(0),
        Value::String(text) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn flag(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.),
        Value::String(text) => matches!(text.trim().to_lowercase().as_str(), "true" | "1" | "yes"),
        _ => false,
    }
}

#[derive(Deserialize)]
struct Response {
    data: Option<Data>,
    errors: Option<Vec<Value>>,
}

#[derive(Deserialize)]
struct Data {
    user: Option<UserOutput>,
}

#[derive(Deserialize)]
struct UserOutput {
    user: Option<User>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    request_limit_info: Option<Limits>,
    bonus_grants: Option<Vec<Grant>>,
    workspaces: Option<Vec<Workspace>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    is_unlimited: Option<Value>,
    next_refresh_time: Option<Timestamp>,
    request_limit: Option<Value>,
    requests_used_since_last_refresh: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    bonus_grants_info: Option<GrantsInfo>,
}

#[derive(Deserialize)]
struct GrantsInfo {
    grants: Option<Vec<Grant>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    request_credits_granted: Option<Value>,
    request_credits_remaining: Option<Value>,
    expiration: Option<Timestamp>,
}

impl Grant {
    fn granted(&self) -> i64 {
        self.request_credits_granted.as_ref().map_or(0, count)
    }

    fn remaining(&self) -> i64 {
        self.request_credits_remaining.as_ref().map_or(0, count)
    }

    fn expires(&self) -> Option<SystemTime> {
        self.expiration.as_ref().and_then(Timestamp::time)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// CodexBar's fetcher fixture.
    const LIMITS: &str = r#"{
      "data": {
        "user": {
          "__typename": "UserOutput",
          "user": {
            "requestLimitInfo": {
              "isUnlimited": false,
              "nextRefreshTime": "2026-02-28T19:16:33.462988Z",
              "requestLimit": 1500,
              "requestsUsedSinceLastRefresh": 5
            },
            "bonusGrants": [
              {"requestCreditsGranted": 20, "requestCreditsRemaining": 10,
               "expiration": "2026-03-01T10:00:00Z"}
            ],
            "workspaces": [
              {"bonusGrantsInfo": {"grants": [
                {"requestCreditsGranted": "15", "requestCreditsRemaining": "5",
                 "expiration": "2026-03-15T10:00:00Z"}
              ]}}
            ]
          }
        }
      }
    }"#;

    #[test]
    fn reads_monthly_and_add_on_credits() {
        let report = parse(LIMITS).unwrap();
        assert_eq!(report.provider.id(), "warp");
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 5. / 15.).abs() < 1e-4);
        assert!(window.resets_at.is_some());
        let bonus = &report.balances[0];
        assert_eq!(bonus.amount, 15.);
        assert_eq!(bonus.total, Some(35.));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Monthly credits".to_owned(), "5 of 1,500".to_owned())
        );
        assert_eq!(
            facts[1],
            (
                "Next add-on expiry".to_owned(),
                "10 credits on Mar 1, 2026".to_owned()
            )
        );
    }

    #[test]
    fn unlimited_shows_an_empty_window() {
        let report = parse(
            r#"{"data":{"user":{"user":{"requestLimitInfo":
              {"isUnlimited":true,"requestLimit":0,"requestsUsedSinceLastRefresh":0}}}}}"#,
        )
        .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Unlimited"));
        assert_eq!(report.windows[0].percent(), 0);
        assert!(report.balances.is_empty());
    }

    #[test]
    fn graphql_errors_are_a_rejection() {
        assert!(matches!(
            parse(r#"{"errors":[{"message":"Unauthorized"}]}"#),
            Err(Error::UsageRejected)
        ));
    }
}
