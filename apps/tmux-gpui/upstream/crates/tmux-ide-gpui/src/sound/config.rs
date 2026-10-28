use crate::{Error, Result, config::daemon_config_path as config_path};
use herdr_client::protocol::SemanticNotificationSound as Sound;
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize)]
#[serde(default)]
struct Document {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    ui: Ui,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Ui {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    sound: SoundConfig,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    toast: Toast,
}

#[derive(Deserialize)]
#[serde(default)]
struct Toast {
    /// Herdr refuses a delay over an hour and keeps its default, so this does too.
    #[serde(deserialize_with = "delay")]
    delay_seconds: u64,
}

fn delay<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    Ok(crate::lenient::value(deserializer)?
        .filter(|delay: &u64| *delay <= 3600)
        .unwrap_or(1))
}
impl Default for Toast {
    fn default() -> Self {
        Self { delay_seconds: 1 }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AgentSetting {
    Default,
    On,
    Off,
}

#[derive(Deserialize)]
#[serde(default)]
pub(super) struct SoundConfig {
    #[serde(deserialize_with = "crate::lenient::or_true")]
    enabled: bool,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    path: Option<PathBuf>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    done_path: Option<PathBuf>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    request_path: Option<PathBuf>,
    #[serde(deserialize_with = "crate::lenient::entries")]
    agents: HashMap<String, AgentSetting>,
}

impl Default for SoundConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            path: None,
            done_path: None,
            request_path: None,
            agents: HashMap::new(),
        }
    }
}

impl SoundConfig {
    pub(super) fn allows(&self, agent: Option<&str>) -> bool {
        if !self.enabled {
            return false;
        }
        // Labels are a wire boundary. Unknown agents retain upstream's default.
        let mut label = agent.unwrap_or_default().trim().to_lowercase();
        for suffix in [".exe", ".cmd", ".bat", ".ps1", ".js"] {
            if label.ends_with(suffix) {
                label.truncate(label.len() - suffix.len());
                break;
            }
        }
        let label = label
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
            .unwrap_or_default();
        let key = match label {
            "claude" | "claude-code" => "claude",
            "cursor" | "cursor-agent" => "cursor",
            "devin" | "devin-cli" | "devin cli" => "devin",
            "agy" | "antigravity" | "antigravity-cli" => "agy",
            "cline" | ".cline" => "cline",
            "opencode" | "opencode2" | "open-code" => "open_code",
            "copilot" | "github-copilot" | "ghcs" => "github_copilot",
            "kimi" | "kimi-code" | "kimi code" => "kimi",
            "kiro" | "kiro-cli" => "kiro",
            "amp" | "amp-local" => "amp",
            "grok" | "grok-build" => "grok",
            "hermes" | "hermes-agent" => "hermes",
            "kilo" | "kilo-code" | "kilo code" => "kilo",
            "qodercli" | "qoderclicn" | "qoder" | "qodercn" => "qodercli",
            "qwen" | "qwen-code" | "qwen code" => "qwen",
            "letta" | "letta-code" | "letta code" => "letta",
            "muse" | "muse-code" | "muse-cli" => "muse",
            "pi" | "codex" | "gemini" | "droid" | "maki" => label,
            _ if label
                .strip_prefix("muse-bin-")
                .is_some_and(|s| s.starts_with(|c: char| c.is_ascii_digit())) =>
            {
                "muse"
            }
            _ => return true,
        };
        self.agents.get(key).copied().unwrap_or(if key == "droid" {
            AgentSetting::Off
        } else {
            AgentSetting::Default
        }) != AgentSetting::Off
    }
}

pub(super) struct Settings {
    pub sound: SoundConfig,
    delay: u64,
    root: PathBuf,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound: SoundConfig::default(),
            delay: 1,
            root: PathBuf::new(),
        }
    }
}

impl Settings {
    pub fn load() -> Result<Self> {
        Self::load_path(&config_path(|key| std::env::var_os(key)))
    }

    fn load_path(path: &Path) -> Result<Self> {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(Error::from(error).at_path(path)),
        };
        let mut text = String::new();
        file.take(1_048_577)
            .read_to_string(&mut text)
            .map_err(|error| Error::from(error).at_path(path))?;
        if text.len() > 1_048_576 {
            return Err(Error::SoundConfigSize.at_path(path));
        }
        Self::parse(&text, path).map_err(|error| error.at_path(path))
    }

    fn parse(text: &str, path: &Path) -> Result<Self> {
        let document: Document = toml::from_str(text)?;
        Ok(Self {
            sound: document.ui.sound,
            delay: document.ui.toast.delay_seconds,
            root: path.parent().unwrap_or_else(|| Path::new(".")).to_owned(),
        })
    }

    pub fn ui_delay(&self) -> u64 {
        self.delay
    }

    pub fn path_for(&self, sound: Sound) -> Option<PathBuf> {
        let path = match sound {
            Sound::Done => self.sound.done_path.as_ref(),
            Sound::Request => self.sound.request_path.as_ref(),
        }
        .or(self.sound.path.as_ref())?;
        Some(self.root.join(path))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
