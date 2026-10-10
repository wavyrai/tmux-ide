//! Vertex AI quota use, read with gcloud's Application Default Credentials
//! (`gcloud auth application-default login`) as CodexBar does: the user
//! credentials in `$GOOGLE_APPLICATION_CREDENTIALS` or
//! `$CLOUDSDK_CONFIG/application_default_credentials.json` are exchanged for
//! an access token (the file is never rewritten), and Cloud Monitoring's
//! `serviceruntime.googleapis.com/quota/{allocation/usage,limit}` series for
//! `aiplatform.googleapis.com` over the last day give the quota closest to
//! its limit. The project is gcloud's active configuration's, else the
//! `project` setting.
//!
//! CodexBar computes this peak but shows only the gcloud identity; this
//! shows the peak as a window. The email comes from Google's userinfo
//! endpoint rather than by decoding the credentials' ID token.
//!
//! Not ported: service-account credentials, which CodexBar turns into a
//! token by running `gcloud auth application-default print-access-token`,
//! a command that prints the token, or which would need request signing.
//! Token costs from Claude Code's logs are not read either.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, Provider, Report, Section, Window},
        probe::{HostPath, Part, Probe, Request, Secret},
        service::{Meta, Service, Setting, json, number},
    },
};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const MONITORING_URL: &str = "https://monitoring.googleapis.com/v3/projects";
const USAGE_FILTER: &str = "metric.type=\"serviceruntime.googleapis.com/quota/allocation/usage\" \
    AND resource.type=\"consumer_quota\" AND resource.label.service=\"aiplatform.googleapis.com\"";
const LIMIT_FILTER: &str = "metric.type=\"serviceruntime.googleapis.com/quota/limit\" \
    AND resource.type=\"consumer_quota\" AND resource.label.service=\"aiplatform.googleapis.com\"";
/// Pages followed per series before giving up on the rest.
const MAX_PAGES: usize = 5;

pub(crate) struct Vertexai;

static META: Meta = Meta::new("vertexai", "Vertex AI")
    .dashboard("https://console.cloud.google.com/vertex-ai")
    .status_page("https://status.cloud.google.com")
    .settings(&[Setting::new(
        "project",
        &[
            "GOOGLE_CLOUD_PROJECT",
            "GCLOUD_PROJECT",
            "CLOUDSDK_CORE_PROJECT",
        ],
        "The Google Cloud project id whose Vertex AI quotas to read, when gcloud has none \
         set (`gcloud config set project PROJECT_ID`). Sign in with `gcloud auth \
         application-default login`; the account needs Cloud Monitoring read access \
         (roles/monitoring.viewer) on the project.",
    )]);

impl Service for Vertexai {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let path = if probe.env("GOOGLE_APPLICATION_CREDENTIALS").is_some() {
            HostPath::env_or(
                "GOOGLE_APPLICATION_CREDENTIALS",
                ".config/gcloud/application_default_credentials.json",
                "",
            )
        } else {
            HostPath::env_or(
                "CLOUDSDK_CONFIG",
                ".config/gcloud",
                "application_default_credentials.json",
            )
        };
        let credentials = probe.file(&path)?;
        let client_id = probe.field(&credentials, &["client_id"])?;
        let client_secret = probe.field(&credentials, &["client_secret"])?;
        let refresh_token = probe.field(&credentials, &["refresh_token"])?;
        let project = project(probe);
        Some(fetch(
            probe,
            &client_id,
            &client_secret,
            &refresh_token,
            project,
        ))
    }
}

fn fetch(
    probe: &mut Probe,
    client_id: &Secret,
    client_secret: &Secret,
    refresh_token: &Secret,
    project: Option<String>,
) -> Result<Report> {
    let refresh = Request::post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(vec![
            Part::Text("client_id=".into()),
            Part::Secret(client_id.clone()),
            Part::Text("&client_secret=".into()),
            Part::Secret(client_secret.clone()),
            Part::Text("&refresh_token=".into()),
            Part::Secret(refresh_token.clone()),
            Part::Text("&grant_type=refresh_token".into()),
        ]);
    let token = probe.exchange(refresh, &["access_token"])?;
    let email = probe
        .http(Request::get(USERINFO_URL).bearer(&token))
        .and_then(|response| response.json::<UserInfo>())
        .ok()
        .and_then(|info| info.email);
    let Some(project) = project else {
        return Ok(report(email, None, None));
    };
    let usage = series(probe, &token, &project, USAGE_FILTER)?;
    let limits = series(probe, &token, &project, LIMIT_FILTER)?;
    Ok(report(email, Some(project), peak(&usage, &limits)))
}

/// gcloud's active configuration names the project, as `project = …`.
fn project(probe: &mut Probe) -> Option<String> {
    let active = probe
        .read(&HostPath::env_or(
            "CLOUDSDK_CONFIG",
            ".config/gcloud",
            "active_config",
        ))
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .unwrap_or_else(|| "default".into());
    probe
        .read(&HostPath::env_or(
            "CLOUDSDK_CONFIG",
            ".config/gcloud",
            format!("configurations/config_{active}"),
        ))
        .and_then(|config| config_project(&config))
        .or_else(|| probe.text_setting("project"))
        // It becomes a URL path segment; project ids are letters, digits,
        // dashes, and for domain-scoped projects `example.com:name`.
        .filter(|project| {
            !project.is_empty()
                && project
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':'))
        })
}

fn config_project(config: &str) -> Option<String> {
    config.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "project")
            .then(|| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn series(probe: &mut Probe, token: &Secret, project: &str, filter: &str) -> Result<Vec<Series>> {
    let end = chrono::Utc::now();
    let start = end - chrono::TimeDelta::hours(24);
    let stamp =
        |at: chrono::DateTime<chrono::Utc>| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut found = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut params = vec![
            ("filter", filter.to_owned()),
            ("interval.startTime", stamp(start)),
            ("interval.endTime", stamp(end)),
            ("aggregation.alignmentPeriod", "3600s".to_owned()),
            ("aggregation.perSeriesAligner", "ALIGN_MAX".to_owned()),
            ("view", "FULL".to_owned()),
        ];
        if let Some(page) = &page_token {
            params.push(("pageToken", page.clone()));
        }
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&params)
            .finish();
        let url = format!("{MONITORING_URL}/{project}/timeSeries?{query}");
        let page: Page = probe
            .body(Request::get(url).bearer(token))
            .and_then(|body| json(&body))?;
        found.extend(page.time_series);
        page_token = page.next_page_token.filter(|token| !token.is_empty());
        if page_token.is_none() {
            break;
        }
    }
    Ok(found)
}

pub(crate) fn report(email: Option<String>, project: Option<String>, peak: Option<f64>) -> Report {
    let windows = peak
        .map(|peak| Window::new(Kind::Named("Peak quota".into()), peak, None, None))
        .into_iter()
        .collect();
    let facts = vec![(
        "Project".to_owned(),
        project.unwrap_or_else(|| "Not set: run `gcloud config set project PROJECT_ID`".into()),
    )];
    Report::new(
        Provider(&Vertexai),
        Account {
            email,
            plan: Some("gcloud".into()),
        },
        windows,
    )
    .with_sections([Section::Facts {
        title: "Google Cloud".into(),
        facts,
    }])
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct QuotaKey {
    metric: String,
    limit: String,
    location: String,
}

/// The highest share of any quota limit used in the last day, matching each
/// usage series to its limit by quota metric, limit name, and location.
fn peak(usage: &[Series], limits: &[Series]) -> Option<f64> {
    let usage = aggregate(usage);
    let limits = aggregate(limits);
    usage
        .iter()
        .filter_map(|(key, used)| {
            let limit = limits
                .get(key)
                .copied()
                .filter(|limit| *limit > 0.)
                .or_else(|| {
                    if !key.limit.is_empty() {
                        return None;
                    }
                    let mut candidates = limits.iter().filter(|(candidate, limit)| {
                        **limit > 0.
                            && candidate.metric == key.metric
                            && candidate.location == key.location
                    });
                    let (_, limit) = candidates.next()?;
                    candidates.next().is_none().then_some(*limit)
                })?;
            Some(used / limit * 100.)
        })
        .reduce(f64::max)
}

fn aggregate(series: &[Series]) -> BTreeMap<QuotaKey, f64> {
    let mut buckets = BTreeMap::new();
    for entry in series {
        let Some(metric) = entry
            .metric
            .labels
            .get("quota_metric")
            .or_else(|| entry.resource.labels.get("quota_id"))
            .filter(|metric| !metric.is_empty())
        else {
            continue;
        };
        let Some(value) = entry
            .points
            .iter()
            .filter_map(|point| point.value.double_value.or(point.value.int64_value))
            .reduce(f64::max)
        else {
            continue;
        };
        let key = QuotaKey {
            metric: metric.clone(),
            limit: entry
                .metric
                .labels
                .get("limit_name")
                .cloned()
                .unwrap_or_default(),
            location: entry
                .resource
                .labels
                .get("location")
                .cloned()
                .unwrap_or_else(|| "global".into()),
        };
        let bucket = buckets.entry(key).or_insert(0_f64);
        *bucket = bucket.max(value);
    }
    buckets
}

#[derive(Deserialize)]
struct UserInfo {
    email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(default)]
    time_series: Vec<Series>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct Series {
    #[serde(default)]
    metric: Labels,
    #[serde(default)]
    resource: Labels,
    #[serde(default)]
    points: Vec<Point>,
}

#[derive(Default, Deserialize)]
struct Labels {
    #[serde(default)]
    labels: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Point {
    value: PointValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PointValue {
    double_value: Option<f64>,
    /// Cloud Monitoring sends 64-bit integers as strings.
    #[serde(default, deserialize_with = "number")]
    int64_value: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const USAGE: &str = r#"{"timeSeries":[
      {"metric":{"type":"serviceruntime.googleapis.com/quota/allocation/usage",
        "labels":{"quota_metric":"aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model","limit_name":"per_minute"}},
       "resource":{"type":"consumer_quota","labels":{"location":"us-central1","service":"aiplatform.googleapis.com"}},
       "points":[{"value":{"int64Value":"12"}},{"value":{"int64Value":"30"}}]},
      {"metric":{"labels":{"quota_metric":"aiplatform.googleapis.com/online_prediction_requests"}},
       "resource":{"labels":{"location":"europe-west4"}},
       "points":[{"value":{"doubleValue":5}}]}
    ],"nextPageToken":""}"#;

    const LIMITS: &str = r#"{"timeSeries":[
      {"metric":{"labels":{"quota_metric":"aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model","limit_name":"per_minute"}},
       "resource":{"labels":{"location":"us-central1"}},
       "points":[{"value":{"int64Value":"200"}}]},
      {"metric":{"labels":{"quota_metric":"aiplatform.googleapis.com/online_prediction_requests","limit_name":"per_day"}},
       "resource":{"labels":{"location":"europe-west4"}},
       "points":[{"value":{"int64Value":"10"}}]}
    ]}"#;

    #[test]
    fn peaks_at_the_quota_closest_to_its_limit() {
        let usage: Page = json(USAGE).unwrap();
        let limits: Page = json(LIMITS).unwrap();
        assert_eq!(usage.next_page_token.as_deref(), Some(""));
        // 30 of 200, and 5 of the only limit for the same metric and place.
        let peak = peak(&usage.time_series, &limits.time_series).unwrap();
        assert!((peak - 50.).abs() < 1e-9);

        let report = report(
            Some("dev@example.com".into()),
            Some("my-project".into()),
            Some(peak),
        );
        assert_eq!(report.account.email.as_deref(), Some("dev@example.com"));
        assert_eq!(report.windows[0].kind, Kind::Named("Peak quota".into()));
        assert_eq!(report.windows[0].percent(), 50);
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Google Cloud".into(),
                facts: vec![("Project".into(), "my-project".into())],
            }]
        );
    }

    #[test]
    fn no_matching_limit_means_no_window() {
        let usage: Page = json(USAGE).unwrap();
        assert_eq!(peak(&usage.time_series, &[]), None);
        assert!(report(None, None, None).windows.is_empty());
    }

    #[test]
    fn reads_the_project_from_the_gcloud_config() {
        let config = "[core]\naccount = dev@example.com\nproject = my-project\n\n[compute]\nregion = us-central1\n";
        assert_eq!(config_project(config).as_deref(), Some("my-project"));
        assert_eq!(config_project("[core]\naccount = x\n"), None);
    }
}
