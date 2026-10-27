//! Azure OpenAI deployment check, with an API key, resource endpoint, and
//! deployment name from the config or CodexBar's `AZURE_OPENAI_*` variables.
//! Azure exposes no spend or quota to an API key, so like CodexBar this only
//! proves the deployment answers: each refresh sends one real, potentially
//! billable `ping` chat completion (at most 64 completion tokens on the v1
//! API, 1 on dated versions) and shows the model that answered. Azure spend
//! needs Azure Resource Manager credentials, which CodexBar does not read
//! either. There is no local sign-in to detect.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Provider, Report, Section},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
    },
};
use serde::Deserialize;

const DEFAULT_VERSION: &str = "2024-10-21";
/// The v1 budget includes reasoning tokens, so a reasoning deployment needs
/// room to answer at all.
const V1_COMPLETION_TOKENS: u32 = 64;

pub(crate) struct Azureopenai;

static META: Meta = Meta::new("azureopenai", "Azure OpenAI")
    .icon("icons/agent-codex.svg")
    .dashboard("https://ai.azure.com")
    .status_page("https://azure.status.microsoft/en-us/status")
    .settings(&[
        Setting::new(
            "api_key",
            &["AZURE_OPENAI_API_KEY"],
            "An Azure OpenAI resource key: in the Azure portal open the Azure OpenAI \
             resource, then Resource Management > Keys and Endpoint, and copy KEY 1.",
        ),
        Setting::new(
            "endpoint",
            &["AZURE_OPENAI_ENDPOINT"],
            "The resource endpoint from the same Keys and Endpoint page, e.g. \
             https://my-resource.openai.azure.com. Only HTTPS is accepted.",
        ),
        Setting::new(
            "deployment",
            &["AZURE_OPENAI_DEPLOYMENT_NAME"],
            "The deployment name to check, as listed under Deployments in Azure AI \
             Foundry (https://ai.azure.com), e.g. chat-prod.",
        ),
        Setting::new(
            "api_version",
            &["AZURE_OPENAI_API_VERSION"],
            "Optional. \"v1\" for the OpenAI-compatible v1 API, or a dated API version. \
             Defaults to 2024-10-21.",
        ),
    ]);

impl Service for Azureopenai {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        let endpoint = probe
            .text_setting("endpoint")
            .filter(|value| !value.is_empty());
        let deployment = probe
            .text_setting("deployment")
            .filter(|value| !value.is_empty());
        let (Some(endpoint), Some(deployment)) = (endpoint, deployment) else {
            return Some(Err(Error::UsageNotSignedIn));
        };
        let version = probe
            .text_setting("api_version")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_VERSION.to_owned());
        let Some(target) = Target::new(&endpoint, &deployment, &version) else {
            return Some(Err(Error::UsageNotSignedIn));
        };
        let request = Request::post(target.url.clone())
            .secret_header("api-key", "", &key)
            .header("Accept", "application/json")
            .json(target.body());
        Some(probe.body(request).and_then(|body| parse(&body, &target)))
    }
}

/// Where the check goes and what it names, none of it secret.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Target {
    url: String,
    host: String,
    deployment: String,
    version: String,
}

impl Target {
    /// None for an endpoint that is not plain HTTPS, since the key would be
    /// sent to it: `http://`, user info, or encoded host delimiters.
    pub(crate) fn new(endpoint: &str, deployment: &str, version: &str) -> Option<Self> {
        let endpoint = endpoint.trim();
        let deployment = deployment.trim();
        let version = version.trim();
        if deployment.is_empty() || version.is_empty() {
            return None;
        }
        let raw = if endpoint.contains("://") {
            endpoint.to_owned()
        } else {
            format!("https://{endpoint}")
        };
        let authority = raw.split("://").nth(1)?.split(['/', '?', '#']).next()?;
        if authority.contains(['@', '%', '\\']) {
            return None;
        }
        let mut url = url::Url::parse(&raw).ok()?;
        if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
            return None;
        }
        url.set_query(None);
        url.set_fragment(None);
        let v1 = version.eq_ignore_ascii_case("v1");
        let expected: &[&str] = if v1 { &["openai", "v1"] } else { &["openai"] };
        let existing: Vec<String> = url
            .path_segments()
            .map(|segments| {
                segments
                    .filter(|segment| !segment.is_empty())
                    .map(str::to_ascii_lowercase)
                    .collect()
            })
            .unwrap_or_default();
        // An endpoint that already ends in `/openai` (or `/openai/v1`) keeps
        // it rather than repeating it.
        let shared = (0..=existing.len().min(expected.len()))
            .rev()
            .find(|&count| {
                existing[existing.len() - count..]
                    .iter()
                    .zip(&expected[..count])
                    .all(|(have, want)| have == want)
            })
            .unwrap_or(0);
        {
            let mut segments = url.path_segments_mut().ok()?;
            segments.pop_if_empty();
            segments.extend(&expected[shared..]);
            if !v1 {
                segments.extend(["deployments", deployment]);
            }
            segments.extend(["chat", "completions"]);
        }
        if !v1 {
            url.query_pairs_mut().append_pair("api-version", version);
        }
        Some(Self {
            host: url.host_str().unwrap_or_default().to_owned(),
            url: url.into(),
            deployment: deployment.to_owned(),
            version: if v1 { "v1".into() } else { version.to_owned() },
        })
    }

    fn body(&self) -> String {
        let messages = serde_json::json!([{ "role": "user", "content": "ping" }]);
        let body = if self.version == "v1" {
            serde_json::json!({
                "messages": messages,
                "model": self.deployment,
                "max_completion_tokens": V1_COMPLETION_TOKENS,
            })
        } else {
            serde_json::json!({ "messages": messages, "max_tokens": 1 })
        };
        body.to_string()
    }
}

pub(crate) fn parse(body: &str, target: &Target) -> Result<Report> {
    let completion: Completion = json(body)?;
    let mut facts = vec![
        ("Resource".to_owned(), target.host.clone()),
        ("Deployment".to_owned(), target.deployment.clone()),
    ];
    if let Some(model) = completion.model.filter(|model| !model.trim().is_empty()) {
        facts.push(("Model".into(), model.trim().to_owned()));
    }
    facts.push(("API version".into(), target.version.clone()));
    let account = Account {
        email: None,
        plan: Some(format!("Deployment: {}", target.deployment)),
    };
    Ok(
        Report::new(Provider(&Azureopenai), account, Vec::new()).with_sections([Section::Facts {
            title: "Deployment reachable".into(),
            facts,
        }]),
    )
}

#[derive(Deserialize)]
struct Completion {
    model: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn dated_version_uses_deployment_path() {
        let target = Target::new("resource.openai.azure.com", "chat-prod", "2024-10-21").unwrap();
        assert_eq!(
            target.url,
            "https://resource.openai.azure.com/openai/deployments/chat-prod/chat/completions\
             ?api-version=2024-10-21"
        );
        assert!(target.body().contains("\"max_tokens\":1"));
    }

    #[test]
    fn v1_keeps_an_existing_openai_suffix() {
        let target = Target::new("https://resource.openai.azure.com/openai/", "gpt", "V1").unwrap();
        assert_eq!(
            target.url,
            "https://resource.openai.azure.com/openai/v1/chat/completions"
        );
        assert!(target.body().contains("\"model\":\"gpt\""));
        assert!(target.body().contains("\"max_completion_tokens\":64"));
    }

    #[test]
    fn refuses_unsafe_endpoints() {
        assert_eq!(
            Target::new("http://resource.openai.azure.com", "d", "v1"),
            None
        );
        assert_eq!(Target::new("https://user@evil.example", "d", "v1"), None);
        assert_eq!(Target::new("https://evil.example%2f@x", "d", "v1"), None);
    }

    #[test]
    fn reports_the_answering_model() {
        let target = Target::new("resource.openai.azure.com", "chat-prod", "2024-10-21").unwrap();
        let report = parse(
            r#"{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4o-2024-08-06","choices":[]}"#,
            &target,
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(
            report.account.plan.as_deref(),
            Some("Deployment: chat-prod")
        );
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert!(facts.contains(&("Model".into(), "gpt-4o-2024-08-06".into())));
        assert!(facts.contains(&("Resource".into(), "resource.openai.azure.com".into())));
    }
}
