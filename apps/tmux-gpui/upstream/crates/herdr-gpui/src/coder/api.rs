//! The slice of Coder's REST API that creates, finds, and starts workspaces,
//! and the rule for when a workspace is ready for `coder ssh`. Shapes follow
//! `codersdk`; unknown fields are ignored and unknown states never read as ready.

use super::{Error, Result, Settings, http, store};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_secs(2);
/// Template builds provision real machines; ten minutes covers slow clouds.
pub(crate) const BUILD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Bounded lists: the menu shows a picker, not an inventory.
const LIST_LIMIT: usize = 200;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct User {
    pub(crate) id: String,
    pub(crate) username: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct Template {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) organization_name: String,
    pub(crate) active_version_id: String,
    #[serde(default)]
    pub(crate) deprecated: bool,
}

impl Template {
    pub(crate) fn label(&self) -> &str {
        if self.display_name.is_empty() {
            &self.name
        } else {
            &self.display_name
        }
    }
}

/// `codersdk.Preset` has no JSON tags, so Coder sends Go field names.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct Preset {
    #[serde(rename = "ID")]
    pub(crate) id: String,
    #[serde(rename = "Name")]
    pub(crate) name: String,
    #[serde(rename = "Default", default)]
    pub(crate) default: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Workspace {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) template_name: String,
    pub(crate) latest_build: Build,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Build {
    #[serde(default)]
    pub(crate) transition: Transition,
    #[serde(default)]
    pub(crate) status: BuildStatus,
    #[serde(default)]
    pub(crate) job: Job,
    #[serde(default)]
    pub(crate) resources: Vec<Resource>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct Job {
    #[serde(default)]
    pub(crate) status: JobStatus,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Resource {
    #[serde(default)]
    pub(crate) agents: Option<Vec<Agent>>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Agent {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) status: AgentStatus,
    #[serde(default)]
    pub(crate) lifecycle_state: Lifecycle,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Transition {
    Start,
    Stop,
    Delete,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BuildStatus {
    Pending,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
    Canceling,
    Canceled,
    Deleting,
    Deleted,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobStatus {
    Pending,
    Running,
    Succeeded,
    Canceling,
    Canceled,
    Failed,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentStatus {
    Connecting,
    Connected,
    Disconnected,
    Timeout,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Lifecycle {
    Created,
    Starting,
    Ready,
    StartTimeout,
    StartError,
    ShuttingDown,
    ShutdownTimeout,
    ShutdownError,
    Off,
    #[default]
    #[serde(other)]
    Unknown,
}

/// Where a workspace is on its way to accepting `coder ssh`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Readiness {
    /// The agent accepts connections. `warning` names a startup script that
    /// failed or timed out: SSH still works, so the workspace is usable.
    Ready {
        agent: String,
        warning: Option<Lifecycle>,
    },
    /// A build is queued or running, or the agent is still starting.
    Building(BuildStatus),
    /// Stopped (for example by autostop); a start build brings it back.
    Stopped,
    /// The last build failed or the agent shut down; `reason` is Coder's text.
    Failed(String),
    Deleted,
}

impl Workspace {
    fn agents(&self) -> impl Iterator<Item = &Agent> {
        self.latest_build
            .resources
            .iter()
            .flat_map(|resource| resource.agents.iter().flatten())
    }

    pub(crate) fn readiness(&self) -> Readiness {
        let build = &self.latest_build;
        if matches!(build.job.status, JobStatus::Failed | JobStatus::Canceled)
            || matches!(build.status, BuildStatus::Failed | BuildStatus::Canceled)
        {
            return Readiness::Failed(
                build
                    .job
                    .error
                    .as_deref()
                    .map(|text| {
                        text.chars()
                            .map(|c| if c.is_control() { ' ' } else { c })
                            .take(300)
                            .collect()
                    })
                    .filter(|text: &String| !text.trim().is_empty())
                    .unwrap_or_else(|| "the workspace build did not finish".into()),
            );
        }
        match (build.transition, build.status) {
            (_, BuildStatus::Deleted | BuildStatus::Deleting) | (Transition::Delete, _) => {
                return Readiness::Deleted;
            }
            (Transition::Stop, BuildStatus::Stopped) => return Readiness::Stopped,
            (_, BuildStatus::Running) => {}
            (_, status) => return Readiness::Building(status),
        }
        let mut agents = self.agents().peekable();
        if agents.peek().is_none() {
            return Readiness::Failed("the template defines no workspace agent".into());
        }
        let mut shut_down = None;
        for agent in agents {
            if agent.status != AgentStatus::Connected {
                continue;
            }
            match agent.lifecycle_state {
                Lifecycle::Ready => {
                    return Readiness::Ready {
                        agent: agent.name.clone(),
                        warning: None,
                    };
                }
                warning @ (Lifecycle::StartTimeout | Lifecycle::StartError) => {
                    return Readiness::Ready {
                        agent: agent.name.clone(),
                        warning: Some(warning),
                    };
                }
                state @ (Lifecycle::ShuttingDown
                | Lifecycle::ShutdownTimeout
                | Lifecycle::ShutdownError
                | Lifecycle::Off) => shut_down = Some(state),
                _ => {}
            }
        }
        match shut_down {
            Some(state) => Readiness::Failed(format!("the workspace agent is {state:?}")),
            None => Readiness::Building(BuildStatus::Running),
        }
    }
}

#[derive(Serialize)]
struct CreateWorkspace<'a> {
    name: &'a str,
    template_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    template_version_preset_id: Option<&'a str>,
}

#[derive(Serialize)]
struct CreateBuild {
    transition: Transition,
}

#[derive(Deserialize)]
struct Workspaces {
    #[serde(default)]
    workspaces: Vec<Workspace>,
}

/// Identifiers are path segments; anything else never reaches a URL.
fn segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(Error::Field("Coder identifier"));
    }
    Ok(value)
}

/// Calls against one deployment, each with a current token.
pub(crate) struct Client<'a> {
    settings: &'a Settings,
    token: &'a SecretString,
}

impl<'a> Client<'a> {
    pub(crate) fn new(settings: &'a Settings, token: &'a SecretString) -> Self {
        Self { settings, token }
    }

    fn url(&self, path: &str) -> String {
        self.settings.endpoint(path)
    }

    pub(crate) fn me(&self) -> Result<User> {
        http::get("users_me", self.token, &self.url("/api/v2/users/me"))
    }

    pub(crate) fn templates(&self) -> Result<Vec<Template>> {
        let path = match &self.settings.organization {
            Some(org) => format!("/api/v2/organizations/{}/templates", segment(org)?),
            None => "/api/v2/templates".into(),
        };
        let mut templates: Vec<Template> = http::get("templates", self.token, &self.url(&path))?;
        templates.retain(|template| !template.deprecated);
        templates.truncate(LIST_LIMIT);
        templates.sort_by_key(|template| template.label().to_lowercase());
        Ok(templates)
    }

    pub(crate) fn presets(&self, template: &Template) -> Result<Vec<Preset>> {
        let path = format!(
            "/api/v2/templateversions/{}/presets",
            segment(&template.active_version_id)?
        );
        // Coder returns `null` rather than `[]` for a template without presets.
        let presets: Option<Vec<Preset>> = http::get("presets", self.token, &self.url(&path))?;
        let mut presets = presets.unwrap_or_default();
        presets.truncate(LIST_LIMIT);
        // The template's default preset is the suggested choice.
        presets.sort_by_key(|preset| !preset.default);
        Ok(presets)
    }

    pub(crate) fn workspaces(&self) -> Result<Vec<Workspace>> {
        let mut url = url::Url::parse(&self.url("/api/v2/workspaces"))
            .map_err(|_| Error::Url("coder.url"))?;
        url.query_pairs_mut()
            .append_pair("q", "owner:me")
            .append_pair("limit", &LIST_LIMIT.to_string());
        let mut list: Workspaces = http::get("workspaces", self.token, url.as_str())?;
        list.workspaces
            .retain(|workspace| workspace.readiness() != Readiness::Deleted);
        Ok(list.workspaces)
    }

    /// The workspace with `id`; one that no longer exists is `Error::Deleted`.
    pub(crate) fn workspace(&self, id: &str) -> Result<Workspace> {
        let path = format!("/api/v2/workspaces/{}", segment(id)?);
        http::get("workspace", self.token, &self.url(&path)).map_err(|error| match error {
            Error::Status(super::Status {
                code: 404 | 410, ..
            }) => Error::Deleted,
            error => error,
        })
    }

    pub(crate) fn create(
        &self,
        name: &str,
        template: &Template,
        preset: Option<&Preset>,
    ) -> Result<Workspace> {
        if !super::names::valid(name) {
            return Err(Error::Field("workspace name"));
        }
        let path = match &self.settings.organization {
            Some(org) => format!(
                "/api/v2/organizations/{}/members/me/workspaces",
                segment(org)?
            ),
            None => "/api/v2/users/me/workspaces".into(),
        };
        http::post(
            "create_workspace",
            self.token,
            &self.url(&path),
            &CreateWorkspace {
                name,
                template_id: segment(&template.id)?,
                template_version_preset_id: preset.map(|preset| preset.id.as_str()),
            },
        )
    }

    pub(crate) fn transition(&self, id: &str, transition: Transition) -> Result<()> {
        let path = format!("/api/v2/workspaces/{}/builds", segment(id)?);
        let _: serde_json::Value = http::post(
            "workspace_build",
            self.token,
            &self.url(&path),
            &CreateBuild { transition },
        )?;
        Ok(())
    }
}

/// What a wait reports while it polls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Progress {
    Starting,
    Building(BuildStatus),
}

/// Poll until `id` accepts `coder ssh`, starting it once if it is stopped.
/// Each poll asks `tokens` for a current token, so a long build survives
/// token expiry; production passes [`store::current_token`].
pub(crate) fn wait_ready(
    settings: &Settings,
    tokens: &impl Fn(bool) -> Result<SecretString>,
    id: &str,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(Progress),
) -> Result<(Workspace, String)> {
    let deadline = Instant::now() + BUILD_TIMEOUT;
    let mut started = false;
    loop {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        let workspace =
            store::with_token(tokens, |token| Client::new(settings, token).workspace(id))?;
        match workspace.readiness() {
            Readiness::Ready { agent, warning } => {
                if let Some(warning) = warning {
                    tracing::warn!(
                        category = "coder_workspace",
                        ?warning,
                        "Coder startup script did not finish cleanly"
                    );
                }
                return Ok((workspace, agent));
            }
            Readiness::Stopped if !started => {
                started = true;
                progress(Progress::Starting);
                store::with_token(tokens, |token| {
                    Client::new(settings, token).transition(id, Transition::Start)
                })?;
            }
            Readiness::Stopped => progress(Progress::Starting),
            Readiness::Building(status) => progress(Progress::Building(status)),
            Readiness::Failed(reason) => return Err(Error::Workspace(reason)),
            Readiness::Deleted => return Err(Error::Deleted),
        }
        if Instant::now() >= deadline {
            return Err(Error::BuildTimeout);
        }
        // Sleep in short steps so cancellation is observed promptly.
        let wake = Instant::now() + POLL;
        while Instant::now() < wake {
            if cancelled() {
                return Err(Error::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests;
