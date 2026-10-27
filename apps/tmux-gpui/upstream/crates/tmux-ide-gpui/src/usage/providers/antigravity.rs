//! Antigravity quotas from the `agy` CLI's own usage report,
//! `agy -p /usage --output-format json`, which needs agy 1.1.11 or later and
//! an `agy` signed in on the probed host (its data lives under
//! `$GEMINI_CLI_HOME`, else `~/.gemini`). The report's Gemini and Claude/GPT
//! groups give a 5-hour and a weekly window each. The report sends no model
//! prompt and prints no credentials; it runs in a fresh empty directory so no
//! project is loaded. A signed-out `agy` opens a browser to sign in instead,
//! so the report runs only when the config asks for Antigravity, never for a
//! merely detected install.
//!
//! Not ported: the Antigravity app's and IDE's local language server and the
//! `agy` HTTPS server (process and port discovery, CSRF tokens, and loopback
//! self-signed TLS, none of which the probe offers); Google OAuth for
//! accounts CodexBar signs in itself (an interactive login with the app's
//! OAuth client); and the local SQLite conversation history.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, Provider, Report, SESSION, WEEK, Window},
        probe::{HostPath, Probe},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::Duration;

/// Runs `$1` in a private empty directory and removes it afterwards.
const REPORT_SCRIPT: &str = r#"d=$(mktemp -d) || exit 1
cd "$d" || exit 1
"$1" -p /usage --output-format json --print-timeout 90s
s=$?
cd / && rmdir "$d" 2>/dev/null
exit $s"#;
/// Earlier builds could send `/usage` to the model as a prompt.
const MINIMUM: (u64, u64, u64) = (1, 1, 11);

pub(crate) struct Antigravity;

static META: Meta = Meta::new("antigravity", "Antigravity")
    .status_page(
        "https://www.google.com/appsstatus/dashboard/products/npdyhgECDJ6tB66MxXyo/history",
    )
    .settings(&[Setting::new(
        "cli_path",
        &["ANTIGRAVITY_CLI_PATH"],
        "The agy executable on the probed host when it is not on the PATH (install it \
         with `brew install --cask antigravity-cli`, run `agy` once, and sign in). agy \
         runs only when this is set or antigravity is in show_providers, as a \
         signed-out agy opens a browser to sign in.",
    )]);

impl Service for Antigravity {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let configured = probe
            .text_setting("cli_path")
            .filter(|path| !path.is_empty());
        if configured.is_none() && !probe.requested() {
            return None;
        }
        let data = |rest: &str| HostPath::env_or("GEMINI_CLI_HOME", ".gemini", rest);
        let used = probe.exists(&data("antigravity-cli")) || probe.exists(&data("antigravity"));
        if configured.is_none() && !used {
            return None;
        }
        let program = configured.unwrap_or_else(|| "agy".into());
        let version = probe
            .command(&program, &["--version"], Duration::from_secs(5))
            .ok()
            .filter(|output| output.success)?;
        if parse_version(&version.stdout).is_none_or(|version| version < MINIMUM) {
            return Some(Err(Error::UsageCommand(
                "agy 1.1.11 or later is needed for usage reports",
            )));
        }
        Some(
            probe
                .command(
                    "/bin/sh",
                    &["-c", REPORT_SCRIPT, "agy-usage", program.as_str()],
                    Duration::from_secs(100),
                )
                .and_then(|output| {
                    if output.success {
                        parse(&output.stdout)
                    } else {
                        Err(Error::UsageCommand(
                            "agy could not report usage; run agy to sign in",
                        ))
                    }
                }),
        )
    }
}

/// A plain `major.minor.patch`; anything else is unknown.
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.trim();
    let text = text
        .rsplit(' ')
        .next()
        .unwrap_or(text)
        .trim_start_matches('v');
    let mut parts = text.split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let report: CliReport = json(body.trim())?;
    if report.status != "SUCCESS" || report.command.name != "usage" {
        return Err(Error::UsageCommand(
            "agy could not report usage; run agy to sign in",
        ));
    }
    let windows: Vec<Window> = report
        .command
        .data
        .groups
        .unwrap_or_default()
        .into_iter()
        .flat_map(|group| {
            let title = group_title(group.display_name.or(group.name));
            group
                .buckets
                .unwrap_or_default()
                .into_iter()
                .filter_map(move |bucket| bucket.window(&title))
        })
        .collect();
    if windows.is_empty() {
        return Err(invalid());
    }
    Ok(Report::new(
        Provider(&Antigravity),
        Account::default(),
        windows,
    ))
}

fn group_title(name: Option<String>) -> String {
    let name = name.unwrap_or_default().trim().to_owned();
    let lower = name.to_lowercase();
    if lower.contains("gemini") {
        "Gemini".into()
    } else if lower.contains("claude") || lower.contains("gpt") {
        "Claude/GPT".into()
    } else if name.is_empty() {
        "Quota".into()
    } else {
        name
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cadence {
    Session,
    Weekly,
    Other,
}

#[derive(Deserialize)]
struct CliReport {
    status: String,
    command: Command,
}

#[derive(Deserialize)]
struct Command {
    name: String,
    data: Summary,
}

#[derive(Deserialize)]
struct Summary {
    groups: Option<Vec<Group>>,
}

#[derive(Deserialize)]
struct Group {
    #[serde(alias = "displayName")]
    display_name: Option<String>,
    name: Option<String>,
    buckets: Option<Vec<Bucket>>,
}

#[derive(Deserialize)]
struct Bucket {
    #[serde(alias = "bucketId")]
    bucket_id: Option<String>,
    id: Option<String>,
    #[serde(alias = "displayName")]
    display_name: Option<String>,
    name: Option<String>,
    window: Option<String>,
    disabled: Option<bool>,
    #[serde(alias = "remainingFraction")]
    remaining_fraction: Option<f64>,
    remaining: Option<Remaining>,
    #[serde(alias = "resetTime")]
    reset_time: Option<Timestamp>,
}

/// `{"remainingFraction": 0.5}` or the protobuf oneof form
/// `{"case": "remainingFraction", "value": 0.5}`.
#[derive(Deserialize)]
struct Remaining {
    #[serde(alias = "remaining_fraction")]
    #[serde(rename = "remainingFraction")]
    remaining_fraction: Option<f64>,
    case: Option<String>,
    value: Option<f64>,
}

impl Remaining {
    fn fraction(&self) -> Option<f64> {
        self.remaining_fraction.or_else(|| {
            (self.case.as_deref() == Some("remainingFraction"))
                .then_some(self.value)
                .flatten()
        })
    }
}

impl Bucket {
    fn window(self, group: &str) -> Option<Window> {
        if self.disabled == Some(true) {
            return None;
        }
        let fraction = self
            .remaining_fraction
            .or_else(|| self.remaining.as_ref().and_then(Remaining::fraction))
            .filter(|fraction| fraction.is_finite())?;
        let id = self
            .bucket_id
            .or(self.id)
            .filter(|id| !id.trim().is_empty())?;
        let name = self.display_name.or(self.name);
        let cadence = [Some(id.as_str()), name.as_deref(), self.window.as_deref()]
            .into_iter()
            .flatten()
            .map(cadence)
            .find(|cadence| *cadence != Cadence::Other)
            .unwrap_or(Cadence::Other);
        let (kind, length) = match cadence {
            Cadence::Session => (format!("{group} 5-hour"), Some(SESSION)),
            Cadence::Weekly => (format!("{group} weekly"), Some(WEEK)),
            Cadence::Other => (format!("{group} {}", name.unwrap_or(id)), None),
        };
        Some(Window::new(
            Kind::Named(kind),
            100. - fraction.clamp(0., 1.) * 100.,
            self.reset_time.as_ref().and_then(Timestamp::time),
            length,
        ))
    }
}

/// `gemini-5h`, `5h`, `session`, `weekly`, or `…-weekly`.
fn cadence(raw: &str) -> Cadence {
    const SESSION_NAMES: [&str; 5] = ["session", "5h", "5-hour", "five hour", "five-hour"];
    let normalized = raw.trim().to_lowercase().replace('_', "-");
    let mut candidates = vec![normalized.clone()];
    if let Some(stem) = normalized.strip_suffix(" limit") {
        candidates.push(stem.to_owned());
    }
    let matches = |alias: &str| {
        candidates
            .iter()
            .any(|candidate| candidate == alias || candidate.ends_with(&format!("-{alias}")))
    };
    if SESSION_NAMES.into_iter().any(matches) {
        Cadence::Session
    } else if matches("weekly") {
        Cadence::Weekly
    } else {
        Cadence::Other
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    const REPORT: &str = r#"{
      "conversation_id": "",
      "status": "SUCCESS",
      "response": "Synthetic quota report",
      "duration_seconds": 0,
      "num_turns": 0,
      "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
      "command": {
        "name": "usage",
        "data": {
          "description": "Models share limits",
          "groups": [
            {"name": "Gemini Models", "description": "Gemini models", "buckets": [
              {"id": "gemini-weekly", "name": "Weekly Limit Remaining", "description": "Weekly limit",
               "window": "weekly", "remaining_fraction": 0.86, "reset_time": "2026-09-17T18:40:27Z"},
              {"id": "gemini-5h", "name": "Five Hour Limit Remaining", "description": "5-hour limit",
               "window": "5h", "remaining_fraction": 0.95, "reset_time": "2026-09-13T03:48:04Z"}
            ]},
            {"name": "Claude and GPT models", "description": "3p models", "buckets": [
              {"id": "3p-weekly", "name": "Weekly Limit Remaining", "window": "weekly",
               "remaining_fraction": 0.89, "reset_time": "2026-09-17T02:38:46Z"},
              {"id": "3p-5h", "name": "Five Hour Limit Remaining", "window": "5h",
               "remaining_fraction": 1.0, "reset_time": "2026-09-13T05:29:19Z"},
              {"id": "3p-image", "name": "Images", "disabled": true, "remaining_fraction": 0.1}
            ]}
          ]
        }
      }
    }"#;

    #[test]
    fn groups_become_session_and_weekly_windows() {
        let report = parse(REPORT).unwrap();
        let used: Vec<_> = report
            .windows
            .iter()
            .map(|window| {
                (
                    window.kind.title().to_owned(),
                    window.percent(),
                    window.length,
                )
            })
            .collect();
        assert_eq!(
            used,
            [
                ("Claude/GPT 5-hour".to_owned(), 0, Some(SESSION)),
                ("Claude/GPT weekly".to_owned(), 11, Some(WEEK)),
                ("Gemini 5-hour".to_owned(), 5, Some(SESSION)),
                ("Gemini weekly".to_owned(), 14, Some(WEEK)),
            ]
        );
        assert_eq!(
            report.windows[3].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_789_670_427))
        );
    }

    #[test]
    fn failed_report_and_versions() {
        let failed = r#"{"status": "ERROR", "command": {"name": "usage", "data": {}}}"#;
        assert!(matches!(parse(failed), Err(Error::UsageCommand(_))));
        assert_eq!(parse_version("1.2.3\n"), Some((1, 2, 3)));
        assert_eq!(parse_version("agy 1.1.11"), Some((1, 1, 11)));
        assert_eq!(parse_version("1.2"), None);
        assert!(parse_version("1.1.10").is_some_and(|version| version < MINIMUM));
    }

    #[test]
    fn oneof_remaining_and_camel_case() {
        let bucket: Bucket = serde_json::from_str(
            r#"{"bucketId": "gemini-5h", "displayName": "5-hour",
                "remaining": {"case": "remainingFraction", "value": 0.25}}"#,
        )
        .unwrap();
        let window = bucket.window("Gemini").unwrap();
        assert_eq!(window.kind, Kind::Named("Gemini 5-hour".into()));
        assert_eq!(window.percent(), 75);
    }
}
