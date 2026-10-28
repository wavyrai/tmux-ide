//! GitKraken AI usage, read from `api.gitkraken.dev` with an account session
//! access token from the config or `GITKRAKEN_API_TOKEN`: weekly personal
//! credits and, for an organization, the shared pool. Like CodexBar, this
//! finds no local sign-in: the `gk` CLI fallback and CLI session discovery
//! are not supported there either, and there is no OAuth refresh, so an
//! expired token has to be replaced by hand.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, Provider, Report, Section, WEEK, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{count, invalid},
    },
};
use serde::Deserialize;

const URL: &str = "https://api.gitkraken.dev/v1/ai-tasks/usage";

pub(crate) struct Gitkraken;

static META: Meta = Meta::new("gitkraken", "GitKraken AI")
    .dashboard("https://gitkraken.dev/account#ai-usage")
    .settings(&[
        Setting::new(
            "token",
            &["GITKRAKEN_API_TOKEN"],
            "A GitKraken account session access token. Sign in at \
             https://gitkraken.dev/account#ai-usage, open Developer Tools > Network, \
             select the successful ai-tasks/usage request, and copy only the value after \
             \"Bearer \" in its Authorization header. Replace it when it expires.",
        ),
        Setting::new(
            "org_id",
            &["GITKRAKEN_ORG_ID"],
            "Optional organization ID: the gk-org-id header of the same request, to read \
             that organization's shared pool.",
        ),
    ]);

impl Service for Gitkraken {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let token = probe.setting("token")?;
        let mut request = Request::get(URL)
            .bearer(&token)
            .header("Client-Name", "herdr-gpui")
            .header("Client-Version", env!("CARGO_PKG_VERSION"))
            .header("User-Agent", "herdr-gpui");
        if let Some(organization) = probe
            .text_setting("org_id")
            .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace))
        {
            request = request.header("gk-org-id", organization);
        }
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let usage: Usage = json(body)?;
    if usage.error.is_some() {
        return Err(invalid());
    }
    let data = usage.data.ok_or_else(invalid)?;
    let personal = Quota::new(data.used, data.limit).ok_or_else(invalid)?;
    let resets_at = data
        .resets_on
        .and_then(|reset| Timestamp::Text(reset).time())
        .ok_or_else(invalid)?;
    // Organization data is optional: when malformed it is left out and the
    // personal quota still shows.
    let pool = data
        .organization
        .and_then(|organization| Quota::new(organization.used, organization.limit));
    let mut facts = vec![("Personal".to_owned(), personal.describe())];
    let mut windows = Vec::new();
    if let Some(used) = personal.percent() {
        windows.push(Window::new(Kind::Weekly, used, Some(resets_at), Some(WEEK)));
    }
    if let Some(pool) = &pool {
        facts.push(("Shared pool".into(), pool.describe()));
        if let Some(shared) = data
            .shared_used
            .filter(|shared| shared.is_finite() && *shared >= 0. && *shared <= pool.used)
        {
            facts.push(("Your shared usage".into(), credits(shared)));
            facts.push(("Rest of organization".into(), credits(pool.used - shared)));
        }
        if let Some(used) = pool.percent() {
            windows.push(Window::new(
                Kind::Named("Shared pool".into()),
                used,
                Some(resets_at),
                Some(WEEK),
            ));
        }
    }
    Ok(
        Report::new(Provider(&Gitkraken), Account::default(), windows).with_sections([
            Section::Facts {
                title: "Weekly usage".into(),
                facts,
            },
        ]),
    )
}

fn credits(value: f64) -> String {
    format!("{} credits", count(value))
}

/// A limit of zero is no allowance and -1 unlimited; neither has a percent.
struct Quota {
    used: f64,
    limit: f64,
}

impl Quota {
    fn new(used: Option<f64>, limit: Option<f64>) -> Option<Self> {
        let (used, limit) = (used?, limit?);
        let valid =
            used.is_finite() && used >= 0. && limit.is_finite() && (limit >= 0. || limit == -1.);
        valid.then_some(Self { used, limit })
    }

    fn percent(&self) -> Option<f64> {
        (self.limit > 0.).then(|| self.used / self.limit * 100.)
    }

    fn describe(&self) -> String {
        let used = count(self.used);
        if self.limit > 0. {
            format!("{used} / {} credits used", count(self.limit))
        } else if self.limit == -1. {
            format!("{used} credits used · Unlimited")
        } else {
            format!("{used} credits used · No allowance")
        }
    }
}

#[derive(Deserialize)]
struct Usage {
    data: Option<Data>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    used: Option<f64>,
    limit: Option<f64>,
    resets_on: Option<String>,
    organization: Option<Pool>,
    shared_used: Option<f64>,
}

#[derive(Deserialize)]
struct Pool {
    used: Option<f64>,
    limit: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn personal_and_pool_become_weekly_windows() {
        let body = r#"{"data":{"used":120,"limit":400,"resetsOn":"2026-10-05T00:00:00.000Z",
            "organization":{"used":900,"limit":3000},"sharedUsed":300},"error":null}"#;
        let report = parse(body).unwrap();
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Weekly);
        assert!((report.windows[0].used - 30.).abs() < 0.01);
        assert_eq!(report.windows[0].length, Some(WEEK));
        assert!(report.windows[0].resets_at.is_some());
        assert_eq!(report.windows[1].kind, Kind::Named("Shared pool".into()));
        assert!((report.windows[1].used - 30.).abs() < 0.01);
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        let labels: Vec<_> = facts.iter().map(|(label, _)| label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Personal",
                "Shared pool",
                "Your shared usage",
                "Rest of organization"
            ]
        );
        assert_eq!(facts[0].1, "120 / 400 credits used");
        assert_eq!(facts[3].1, "600 credits");
    }

    #[test]
    fn unlimited_has_no_window() {
        let body = r#"{"data":{"used":55.5,"limit":-1,"resetsOn":"2026-10-05T00:00:00Z"}}"#;
        let report = parse(body).unwrap();
        assert!(report.windows.is_empty());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0].1, "55.50 credits used · Unlimited");
    }

    #[test]
    fn malformed_personal_usage_fails() {
        assert!(
            parse(r#"{"data":{"used":1,"limit":-2,"resetsOn":"2026-10-05T00:00:00Z"}}"#).is_err()
        );
        assert!(parse(r#"{"data":{"used":1,"limit":2,"resetsOn":"soon"}}"#).is_err());
        assert!(parse(r#"{"data":null,"error":{"message":"x"}}"#).is_err());
    }
}
