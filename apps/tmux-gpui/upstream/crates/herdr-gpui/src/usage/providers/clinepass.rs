//! ClinePass subscription limits, read with a Cline API key from the config,
//! `CLINE_API_KEY`, or `CLINEPASS_API_KEY`, as CodexBar's bundled plugin does.
//! The endpoint reports five-hour, weekly, and monthly limits only; Cline's
//! pay-as-you-go balance is a separate API that CodexBar does not read.
//! Neither Cline nor CodexBar keeps a local sign-in that holds this key.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, Provider, Report, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;

const URL: &str = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";

pub(crate) struct Clinepass;

static META: Meta = Meta::new("clinepass", "ClinePass")
    .dashboard("https://app.cline.bot/dashboard/subscription?personal=true")
    .settings(&[Setting::new(
        "api_key",
        &["CLINE_API_KEY", "CLINEPASS_API_KEY"],
        "A Cline API key for the account with the ClinePass subscription. Create one at \
         https://app.cline.bot under Settings > API Keys.",
    )]);

impl Service for Clinepass {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        let request = Request::get(URL)
            .bearer(&key)
            .header("Accept", "application/json");
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let payload: Payload = json(body)?;
    if !payload.success {
        return Err(invalid());
    }
    let windows = payload
        .data
        .limits
        .into_iter()
        .filter_map(|limit| {
            let kind = match limit.kind.as_str() {
                "five_hour" => Kind::Session,
                "weekly" => Kind::Weekly,
                "monthly" => Kind::Monthly,
                _ => return None,
            };
            let length = kind.length();
            Some(Window::new(
                kind,
                limit.percent_used,
                limit.resets_at.as_ref().and_then(Timestamp::time),
                length,
            ))
        })
        .collect();
    Ok(Report::new(
        Provider(&Clinepass),
        Account::default(),
        windows,
    ))
}

#[derive(Deserialize)]
struct Payload {
    success: bool,
    data: Data,
}

#[derive(Deserialize)]
struct Data {
    limits: Vec<Limit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limit {
    #[serde(rename = "type")]
    kind: String,
    percent_used: f64,
    resets_at: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;
    use std::time::{Duration, SystemTime};

    #[test]
    fn parses_all_three_limits() {
        let report = parse(
            r#"{
              "data": {
                "limits": [
                  { "type": "five_hour", "percentUsed": 12.5, "resetsAt": "2026-07-16T10:20:30Z" },
                  { "type": "weekly", "percentUsed": 34, "resetsAt": "2026-07-20T00:00:00Z" },
                  { "type": "monthly", "percentUsed": 56.75, "resetsAt": "2026-08-01T00:00:00Z" }
                ]
              },
              "success": true
            }"#,
        )
        .unwrap();
        let kinds: Vec<_> = report.windows.iter().map(|w| w.kind.clone()).collect();
        assert_eq!(kinds, [Kind::Session, Kind::Weekly, Kind::Monthly]);
        assert_eq!(report.windows[0].used, 12.5);
        assert_eq!(report.windows[2].used, 56.75);
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_784_197_230))
        );
        assert_eq!(report.windows[1].length, Kind::Weekly.length());
    }

    #[test]
    fn skips_unknown_limits_and_missing_resets() {
        let report = parse(
            r#"{
              "success": true,
              "data": {
                "limits": [
                  { "type": "experimental_pool", "percentUsed": 77 },
                  { "type": "monthly", "percentUsed": 40, "resetsAt": null }
                ]
              }
            }"#,
        )
        .unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Monthly);
        assert_eq!(report.windows[0].resets_at, None);
    }

    #[test]
    fn rejects_unsuccessful_payload() {
        assert!(matches!(
            parse(r#"{"success": false, "data": {"limits": []}}"#),
            Err(Error::UsageJson(_))
        ));
    }
}
