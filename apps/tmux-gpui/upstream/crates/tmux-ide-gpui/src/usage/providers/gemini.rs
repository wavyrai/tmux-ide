//! Gemini CLI quotas, read with the CLI's own Google sign-in in
//! `~/.gemini/oauth_creds.json` from Google's Code Assist quota API. An
//! expired access token is refreshed with the refresh token in that file
//! and the Gemini CLI's OAuth client, taken from `client_id`/`client_secret`
//! (`GEMINI_OAUTH_CLIENT_ID`/`GEMINI_OAUTH_CLIENT_SECRET`) or, as CodexBar
//! does, from the installed CLI's `oauth2.js`. The refreshed token is used
//! once and never written back. The account is the CLI's active account in
//! `~/.gemini/google_accounts.json`; API-key and Vertex AI sign-ins have no
//! plan quota and are left out.
//!
//! Not ported: CodexBar reads the email and Workspace domain from the
//! `id_token` JWT, which would mean revealing a credential, so the email
//! comes from `google_accounts.json` and a Workspace account is recognised by
//! a non-Gmail address; and the consumer-tier migration guidance, which here
//! is the usual rejected sign-in.

use crate::{
    Error, Result,
    usage::{
        model::{Account, DAY, Kind, Provider, Report, Section, Window},
        probe::{HostPath, Part, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const CODE_ASSIST_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const PROJECTS_URL: &str = "https://cloudresourcemanager.googleapis.com/v1/projects";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// Finds the installed Gemini CLI's `oauth2.js` (or its bundle) from the
/// `gemini` binary and prints the OAuth client constants, which are public
/// values shipped in the package, not secrets.
const CLIENT_SCRIPT: &str = r#"g=$(command -v gemini) || exit 1
n=0
while [ -L "$g" ] && [ $n -lt 20 ]; do
  l=$(readlink "$g")
  case "$l" in /*) g=$l ;; *) g=$(dirname "$g")/$l ;; esac
  n=$((n+1))
done
p="OAUTH_CLIENT_(ID|SECRET) *= *[\"'][A-Za-z0-9._-]+[\"']"
c=dist/src/code_assist/oauth2.js
d=$(dirname "$g")
while [ -n "$d" ] && [ "$d" != / ]; do
  for f in "$d/node_modules/@google/gemini-cli-core/$c" \
    "$d/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/$c" \
    "$d/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/$c" \
    "$d/libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/$c"; do
    if [ -f "$f" ]; then grep -hoE "$p" "$f" | head -n 4; exit 0; fi
  done
  if [ -f "$d/package.json" ] && [ -d "$d/bundle" ]; then
    grep -rhoE --include='*.js' "$p" "$d/bundle" | head -n 4; exit 0
  fi
  d=$(dirname "$d")
done
exit 1"#;

pub(crate) struct Gemini;

static META: Meta = Meta::new("gemini", "Gemini")
    .dashboard("https://gemini.google.com")
    .status_page(
        "https://www.google.com/appsstatus/dashboard/products/npdyhgECDJ6tB66MxXyo/history",
    )
    .settings(&[
        Setting::new(
            "client_id",
            &["GEMINI_OAUTH_CLIENT_ID"],
            "The Gemini CLI's OAuth client id, used to refresh an expired sign-in. \
             Normally found in the installed CLI (OAUTH_CLIENT_ID in \
             @google/gemini-cli-core/dist/src/code_assist/oauth2.js); set it only when \
             the CLI is not on the host's PATH.",
        ),
        Setting::new(
            "client_secret",
            &["GEMINI_OAUTH_CLIENT_SECRET"],
            "The matching OAUTH_CLIENT_SECRET from the same file.",
        ),
    ]);

impl Service for Gemini {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let credentials = probe.file(&HostPath::home(".gemini/oauth_creds.json"))?;
        let settings = HostPath::home(".gemini/settings.json");
        let auth = probe
            .file_text(&settings, &["security", "auth", "selectedType"])
            .or_else(|| probe.file_text(&settings, &["selectedAuthType"]));
        if matches!(
            auth.as_deref(),
            Some("gemini-api-key" | "api-key" | "vertex-ai")
        ) {
            return None;
        }
        let email = probe.file_text(&HostPath::home(".gemini/google_accounts.json"), &["active"]);
        Some(read(probe, &credentials, email))
    }
}

fn read(probe: &mut Probe, credentials: &Secret, email: Option<String>) -> Result<Report> {
    let token = access_token(probe, credentials)?;
    let assist = probe
        .body(
            Request::post(CODE_ASSIST_URL)
                .bearer(&token)
                .json(r#"{"metadata":{"ideType":"GEMINI_CLI","pluginType":"GEMINI"}}"#),
        )
        .map(|body| parse_code_assist(&body))
        .unwrap_or_default();
    if assist.ineligible {
        return Err(Error::UsageNoPlan);
    }
    let project = match assist.project.clone() {
        Some(project) => Some(project),
        None => probe
            .body(Request::get(PROJECTS_URL).bearer(&token))
            .ok()
            .and_then(|body| gemini_project(&body)),
    };
    let body = match &project {
        Some(project) => serde_json::json!({ "project": project }).to_string(),
        None => "{}".into(),
    };
    let response = probe.http(Request::post(QUOTA_URL).bearer(&token).json(body))?;
    // Google answers the consumer-tier shutdown with a bare 403.
    let body = response.ok()?;
    parse(&body, email.clone(), assist.plan(email.as_deref()))
}

/// The stored access token while it is fresh, else one minted from the
/// refresh token.
fn access_token(probe: &mut Probe, credentials: &Secret) -> Result<Secret> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let fresh = probe
        .text(credentials, &["expiry_date"])
        .and_then(|millis| millis.parse::<f64>().ok())
        .is_none_or(|millis| millis / 1000. > now + 60.);
    if fresh && let Some(token) = probe.field(credentials, &["access_token"]) {
        return Ok(token);
    }
    let refresh = probe
        .field(credentials, &["refresh_token"])
        .ok_or(Error::UsageRejected)?;
    let (id, secret) = client(probe).ok_or(Error::UsageCommand(
        "find the Gemini CLI's OAuth client to refresh the sign-in",
    ))?;
    let request = Request::post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(vec![
            Part::Text(format!(
                "client_id={id}&client_secret={secret}&grant_type=refresh_token&refresh_token="
            )),
            Part::Secret(refresh),
        ]);
    probe.exchange(request, &["access_token"])
}

fn client(probe: &mut Probe) -> Option<(String, String)> {
    let configured = probe
        .text_setting("client_id")
        .zip(probe.text_setting("client_secret"))
        .filter(|(id, secret)| valid(id) && valid(secret));
    if configured.is_some() {
        return configured;
    }
    let output = probe
        .command("/bin/sh", &["-c", CLIENT_SCRIPT], Duration::from_secs(20))
        .ok()
        .filter(|output| output.success)?;
    client_from(&output.stdout)
}

/// `OAUTH_CLIENT_ID = '…'` and `OAUTH_CLIENT_SECRET = "…"` lines.
fn client_from(text: &str) -> Option<(String, String)> {
    let value = |name: &str| {
        text.lines().find_map(|line| {
            let rest = line.trim().strip_prefix(name)?.trim_start();
            let rest = rest.strip_prefix('=')?.trim();
            let value = rest.trim_matches(|c| c == '\'' || c == '"');
            valid(value).then(|| value.to_owned())
        })
    };
    Some((value("OAUTH_CLIENT_ID")?, value("OAUTH_CLIENT_SECRET")?))
}

/// Client values go into a form body unencoded, so only these characters pass.
fn valid(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CodeAssist {
    project: Option<String>,
    tier: Option<String>,
    paid: Option<String>,
    /// Google listed tiers the account cannot use and none it is on: it has
    /// no Code Assist plan, and the quota API refuses it.
    ineligible: bool,
}

impl CodeAssist {
    /// A named paid tier wins; a free tier on a non-Gmail account is
    /// Workspace, as CodexBar reads the `hd` claim.
    fn plan(&self, email: Option<&str>) -> Option<String> {
        if let Some(paid) = &self.paid {
            return Some(paid.clone());
        }
        let workspace =
            email
                .and_then(|email| email.rsplit_once('@'))
                .is_some_and(|(_, domain)| {
                    let domain = domain.to_lowercase();
                    domain != "gmail.com" && domain != "googlemail.com"
                });
        match self.tier.as_deref()? {
            "standard-tier" => Some("Paid".into()),
            "free-tier" if workspace => Some("Workspace".into()),
            "free-tier" => Some("Free".into()),
            "legacy-tier" => Some("Legacy".into()),
            _ => None,
        }
    }
}

fn parse_code_assist(body: &str) -> CodeAssist {
    let Ok(answer): Result<AssistAnswer> = json(body) else {
        return CodeAssist::default();
    };
    let project = match answer.cloudaicompanion_project {
        Some(ProjectField::Id(id)) => Some(id),
        Some(ProjectField::Object { id, project_id }) => id.or(project_id),
        None => None,
    }
    .map(|id| id.trim().to_owned())
    .filter(|id| !id.is_empty());
    CodeAssist {
        project,
        tier: answer
            .current_tier
            .as_ref()
            .and_then(|tier| tier.id.clone()),
        ineligible: !answer.ineligible_tiers.unwrap_or_default().is_empty()
            && answer.current_tier.is_none(),
        paid: answer
            .paid_tier
            .and_then(|tier| tier.name)
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty()),
    }
}

/// A Gemini API project: `gen-lang-client-…` or labelled generative-language.
fn gemini_project(body: &str) -> Option<String> {
    let answer: Projects = json(body).ok()?;
    answer.projects?.into_iter().find_map(|project| {
        let id = project.project_id?;
        let labelled = project
            .labels
            .is_some_and(|labels| labels.contains_key("generative-language"));
        (id.starts_with("gen-lang-client") || labelled).then_some(id)
    })
}

/// Each model keeps its lowest remaining share; Pro, Flash, and Flash Lite
/// models become the daily windows, as CodexBar groups them.
pub(crate) fn parse(body: &str, email: Option<String>, plan: Option<String>) -> Result<Report> {
    let answer: Quota = json(body)?;
    let mut models: Vec<(String, f64, Option<SystemTime>)> = Vec::new();
    for bucket in answer.buckets.unwrap_or_default() {
        let (Some(model), Some(fraction)) = (bucket.model_id, bucket.remaining_fraction) else {
            continue;
        };
        let reset = bucket.reset_time.as_ref().and_then(Timestamp::time);
        match models.iter().position(|(id, ..)| *id == model) {
            Some(index) if fraction < models[index].1 => models[index] = (model, fraction, reset),
            Some(_) => {}
            None => models.push((model, fraction, reset)),
        }
    }
    if models.is_empty() {
        return Err(invalid());
    }
    models.sort_by(|a, b| a.0.cmp(&b.0));
    let family = |id: &str| {
        let id = id.to_lowercase();
        if id.contains("flash-lite") {
            Some("Flash Lite")
        } else if id.contains("flash") {
            Some("Flash")
        } else if id.contains("pro") {
            Some("Pro")
        } else {
            None
        }
    };
    let windows = ["Pro", "Flash", "Flash Lite"]
        .into_iter()
        .filter_map(|name| {
            let (_, fraction, reset) = models
                .iter()
                .filter(|(id, ..)| family(id) == Some(name))
                .min_by(|a, b| a.1.total_cmp(&b.1))?;
            Some(Window::new(
                Kind::Named(name.into()),
                100. - fraction * 100.,
                *reset,
                Some(DAY),
            ))
        })
        .collect();
    let facts = models
        .iter()
        .map(|(id, fraction, _)| (id.clone(), format!("{}% left", (fraction * 100.).round())))
        .collect();
    Ok(
        Report::new(Provider(&Gemini), Account { email, plan }, windows).with_sections([
            Section::Facts {
                title: "Models".into(),
                facts,
            },
        ]),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssistAnswer {
    cloudaicompanion_project: Option<ProjectField>,
    current_tier: Option<Tier>,
    paid_tier: Option<Tier>,
    ineligible_tiers: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ProjectField {
    Id(String),
    Object {
        id: Option<String>,
        #[serde(rename = "projectId")]
        project_id: Option<String>,
    },
}

#[derive(Deserialize)]
struct Tier {
    id: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct Projects {
    projects: Option<Vec<Project>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    project_id: Option<String>,
    labels: Option<std::collections::HashMap<String, String>>,
}

#[derive(Deserialize)]
struct Quota {
    buckets: Option<Vec<Bucket>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    model_id: Option<String>,
    remaining_fraction: Option<f64>,
    reset_time: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn model_buckets_become_family_windows() {
        let body = r#"{"buckets": [
            {"modelId": "gemini-2.5-pro", "remainingFraction": 0.6, "resetTime": "2025-01-01T00:00:00Z"},
            {"modelId": "gemini-2.5-flash", "remainingFraction": 0.9, "resetTime": "2025-01-01T00:00:00Z"},
            {"modelId": "gemini-2.5-flash", "remainingFraction": 0.4, "resetTime": "2025-01-01T00:00:00Z", "tokenType": "OUTPUT"},
            {"modelId": "gemini-2.5-flash-lite", "remainingFraction": 0.8, "resetTime": "2025-01-01T00:00:00Z"}
        ]}"#;
        let report = parse(body, Some("me@gmail.com".into()), Some("Free".into())).unwrap();
        let used: Vec<_> = report
            .windows
            .iter()
            .map(|window| (window.kind.title().to_owned(), window.percent()))
            .collect();
        assert_eq!(
            used,
            [
                ("Flash".to_owned(), 60),
                ("Flash Lite".to_owned(), 20),
                ("Pro".to_owned(), 40),
            ]
        );
        assert!(
            report
                .windows
                .iter()
                .all(|window| window.length == Some(DAY))
        );
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_735_689_600))
        );
        assert_eq!(report.account.email.as_deref(), Some("me@gmail.com"));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("facts");
        };
        assert_eq!(facts.len(), 3);
        assert!(parse(r#"{"buckets": []}"#, None, None).is_err());
    }

    #[test]
    fn code_assist_tier_and_project() {
        let assist = parse_code_assist(
            r#"{"currentTier": {"id": "free-tier", "name": "free"},
                "cloudaicompanionProject": "cloudaicompanion-123"}"#,
        );
        assert_eq!(assist.project.as_deref(), Some("cloudaicompanion-123"));
        assert_eq!(assist.plan(Some("me@gmail.com")).as_deref(), Some("Free"));
        assert_eq!(
            assist.plan(Some("me@acme.com")).as_deref(),
            Some("Workspace")
        );
        let paid = parse_code_assist(
            r#"{"currentTier": {"id": "standard-tier"}, "paidTier": {"name": "Plus"},
                "cloudaicompanionProject": {"id": "proj-1"}}"#,
        );
        assert_eq!(paid.project.as_deref(), Some("proj-1"));
        assert_eq!(paid.plan(None).as_deref(), Some("Plus"));
        assert_eq!(parse_code_assist("not json"), CodeAssist::default());
        // Live shape for an account Google no longer offers a tier to.
        let ineligible = parse_code_assist(
            r#"{"allowedTiers":[{"id":"standard-tier","name":"Standard","isDefault":true}],
                "ineligibleTiers":[{"reasonCode":"UNSUPPORTED","tierId":"free-tier"}]}"#,
        );
        assert!(ineligible.ineligible);
        assert!(
            !parse_code_assist(r#"{"currentTier":{"id":"free-tier"},"ineligibleTiers":[{}]}"#)
                .ineligible
        );
    }

    #[test]
    fn project_discovery_and_client_lines() {
        let body = r#"{"projects": [{"projectId": "other"},
            {"projectId": "gen-lang-client-0123", "labels": {}}]}"#;
        assert_eq!(
            gemini_project(body).as_deref(),
            Some("gen-lang-client-0123")
        );
        let text = "OAUTH_CLIENT_ID = '681255809395-abc.apps.googleusercontent.com'\n\
                    OAUTH_CLIENT_SECRET = \"GOCSPX-xyz\"\n";
        assert_eq!(
            client_from(text),
            Some((
                "681255809395-abc.apps.googleusercontent.com".into(),
                "GOCSPX-xyz".into()
            ))
        );
        assert_eq!(client_from("OAUTH_CLIENT_ID = 'a'"), None);
    }
}
