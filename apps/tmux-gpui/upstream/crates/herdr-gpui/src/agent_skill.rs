//! The agent skill that tells agents about browser tabs and page notes.
//! Agents only use what they know about, so the app offers once to install
//! it where Claude Code and other agents look for skills, and, once the user
//! agrees, keeps it current on every start: the skill names this app's
//! executable, which moves when the app does. Only files the app wrote,
//! recognized by their marker, are ever rewritten or removed.
use crate::state_file;
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const SKILL: &str = include_str!("../../../skills/herdr-gpui-browser/SKILL.md");
/// Marks a skill file this app manages.
const MARKER: &str = "<!-- herdr-gpui-managed-skill v1";
const NAME: &str = "herdr-gpui-browser";
/// Agent configuration directories under the home directory, whose
/// `skills/` subdirectory agents read.
const ROOTS: [&str; 2] = [".claude", ".agents"];

/// A path as one shell word.
fn shell_word(path: &str) -> String {
    if !path.is_empty()
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
    {
        path.to_owned()
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

/// How agents run `executable`. A macOS app bundle puts nothing on `PATH`,
/// so they are told exactly which file to run.
pub(crate) fn command(executable: Option<&Path>) -> String {
    executable
        .and_then(Path::to_str)
        .map_or_else(|| "herdr-gpui".to_owned(), shell_word)
}

/// The skill, naming `executable` in its commands.
pub(crate) fn text(executable: Option<&Path>) -> String {
    if executable.and_then(Path::to_str).is_none() {
        return SKILL.to_owned();
    }
    SKILL.replace(
        "herdr-gpui browser",
        &format!("{} browser", command(executable)),
    )
}

fn managed(contents: &str) -> bool {
    contents.contains(MARKER)
}

fn file(root: &Path) -> PathBuf {
    root.join("skills").join(NAME).join("SKILL.md")
}

fn install_error(path: &Path) -> impl FnOnce(std::io::Error) -> crate::Error + '_ {
    move |source| crate::Error::SkillInstall {
        path: path.to_owned(),
        source,
    }
}

/// Writes `text` into each agent directory that exists under `home`. A file
/// the user wrote there under the same name is left alone. Returns where the
/// skill now is. Blocking; run off the UI thread.
pub(crate) fn install(home: &Path, text: &str) -> crate::Result<Vec<PathBuf>> {
    let mut placed = Vec::new();
    for root in ROOTS.map(|root| home.join(root)) {
        if !root.is_dir() {
            continue;
        }
        let path = file(&root);
        match std::fs::read_to_string(&path) {
            Ok(current) if current == text => {}
            Ok(current) if !managed(&current) => continue,
            Ok(_) => std::fs::write(&path, text).map_err(install_error(&path))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(install_error(&path))?;
                }
                std::fs::write(&path, text).map_err(install_error(&path))?;
            }
            Err(error) => return Err(install_error(&path)(error)),
        }
        placed.push(path);
    }
    if placed.is_empty() {
        return Err(crate::Error::SkillInstall {
            path: home.join(ROOTS[0]),
            source: std::io::ErrorKind::NotFound.into(),
        });
    }
    Ok(placed)
}

/// Removes the skill files this app wrote under `home`, and their folders
/// when nothing else is in them. Blocking; run off the UI thread.
pub(crate) fn remove(home: &Path) -> crate::Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    for root in ROOTS.map(|root| home.join(root)) {
        let path = file(&root);
        let Ok(current) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !managed(&current) {
            continue;
        }
        std::fs::remove_file(&path).map_err(install_error(&path))?;
        if let Some(dir) = path.parent() {
            // Only succeeds when the folder is empty, which is the intent.
            let _ = std::fs::remove_dir(dir);
        }
        removed.push(path);
    }
    Ok(removed)
}

/// Whether any agent directory exists to install into.
fn agents_present(home: &Path) -> bool {
    ROOTS.iter().any(|root| home.join(root).is_dir())
}

/// What the user chose when asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Choice {
    Installed,
    Declined,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    choice: Choice,
}

/// The app's answer about the skill, and whether to ask for one.
#[derive(Default)]
pub(crate) struct AgentSkill {
    choice: Option<Choice>,
    /// Asked at most once per run, by the first window ready to.
    ask: bool,
    path: Option<PathBuf>,
}

impl Global for AgentSkill {}

impl AgentSkill {
    fn path() -> Option<PathBuf> {
        crate::preferences::state_dir().map(|dir| dir.join("agent-skill.json"))
    }

    /// Called before starting GPUI. Only a release build asks or keeps the
    /// skill current: a development build would point agents at itself.
    pub(crate) fn load() -> Self {
        let path = Self::path();
        let choice = path
            .as_deref()
            .and_then(|path| match state_file::read(path, 4096) {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(%error, "Cannot read the agent skill choice");
                    None
                }
            })
            .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
            .map(|saved| saved.choice);
        let home = crate::config::home().ok();
        let ask =
            crate::RELEASE_BUILD && choice.is_none() && home.as_deref().is_some_and(agents_present);
        Self { choice, ask, path }
    }

    /// An app that has not been asked yet, saving nowhere.
    #[cfg(test)]
    pub(crate) fn unasked() -> Self {
        Self {
            choice: None,
            ask: true,
            path: None,
        }
    }

    pub(crate) fn install_global(self, cx: &mut App) {
        let refresh = crate::RELEASE_BUILD && self.choice == Some(Choice::Installed);
        cx.set_global(self);
        if refresh {
            refresh_installed(cx);
        }
    }

    pub(crate) fn choice(cx: &App) -> Option<Choice> {
        cx.try_global::<Self>().and_then(|skill| skill.choice)
    }

    /// Whether this window should ask now; claims the question so no other
    /// window asks too.
    pub(crate) fn take_ask(cx: &mut App) -> bool {
        let ask = cx.try_global::<Self>().is_some_and(|skill| skill.ask);
        if ask {
            cx.global_mut::<Self>().ask = false;
        }
        ask
    }

    /// Records the user's answer, saved off the UI thread.
    pub(crate) fn choose(choice: Choice, cx: &mut App) {
        if !cx.has_global::<Self>() {
            cx.set_global(Self::default());
        }
        let skill = cx.global_mut::<Self>();
        skill.choice = Some(choice);
        skill.ask = false;
        let Some(path) = skill.path.clone() else {
            return;
        };
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = state_file::write(&path, &Saved { choice }) {
                    tracing::warn!(%error, "Cannot save the agent skill choice");
                }
            })
            .detach();
    }
}

/// Rewrites the installed skill if this app's text or location changed.
fn refresh_installed(cx: &mut App) {
    let Ok(home) = crate::config::home() else {
        return;
    };
    cx.background_executor()
        .spawn(async move {
            let text = text(std::env::current_exe().ok().as_deref());
            if let Err(error) = install(&home, &text) {
                tracing::warn!(%error, "Cannot refresh the agent skill");
            }
        })
        .detach();
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn the_skill_is_marked_and_names_this_executable() {
        assert!(SKILL.starts_with("---\nname: herdr-gpui-browser\n"));
        assert!(managed(SKILL));
        assert!(SKILL.contains("herdr-gpui browser open"));
        assert_eq!(text(None), SKILL);
        let bundled = text(Some(Path::new(
            "/Applications/Herdr.app/Contents/MacOS/Herdr",
        )));
        assert!(bundled.contains("/Applications/Herdr.app/Contents/MacOS/Herdr browser open"));
        assert!(!bundled.contains("herdr-gpui browser"));
        let spaced = text(Some(Path::new("/Users/a b/it's/Herdr")));
        assert!(spaced.contains(r"'/Users/a b/it'\''s/Herdr' browser open"));
    }

    #[test]
    fn installing_keeps_to_existing_agent_directories_and_the_users_own_files() {
        let home = tempfile::tempdir().unwrap();
        assert!(matches!(
            install(home.path(), SKILL),
            Err(crate::Error::SkillInstall { .. })
        ));
        assert!(!agents_present(home.path()));
        std::fs::create_dir(home.path().join(".agents")).unwrap();
        std::fs::create_dir(home.path().join(".claude")).unwrap();
        // A skill of the same name the user wrote is theirs.
        let own = file(&home.path().join(".claude"));
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        std::fs::write(&own, "my own skill").unwrap();
        let placed = install(home.path(), SKILL).unwrap();
        assert_eq!(placed, [file(&home.path().join(".agents"))]);
        assert_eq!(std::fs::read_to_string(&placed[0]).unwrap(), SKILL);
        assert_eq!(std::fs::read_to_string(&own).unwrap(), "my own skill");

        // A newer text replaces the managed copy; the same text is a no-op.
        let newer = format!("{SKILL}\nNew section\n");
        install(home.path(), &newer).unwrap();
        assert_eq!(std::fs::read_to_string(&placed[0]).unwrap(), newer);

        // Removing takes only the managed copy and its now-empty folder.
        assert_eq!(remove(home.path()).unwrap(), placed);
        assert!(!placed[0].parent().unwrap().exists());
        assert_eq!(std::fs::read_to_string(&own).unwrap(), "my own skill");
        assert!(remove(home.path()).unwrap().is_empty());
    }

    #[test]
    fn choices_are_saved_as_json() {
        let text = serde_json::to_string(&Saved {
            choice: Choice::Declined,
        })
        .unwrap();
        assert_eq!(text, r#"{"choice":"declined"}"#);
        let saved: Saved = serde_json::from_str(r#"{"choice":"installed"}"#).unwrap();
        assert_eq!(saved.choice, Choice::Installed);
    }

    #[gpui::test]
    fn the_offer_is_made_once_and_closing_it_means_not_now(cx: &mut gpui::TestAppContext) {
        use crate::sidebar::layout_tests::fixture_window;
        cx.update(|cx| cx.set_global(AgentSkill::unasked()));
        let (view, cx) = cx.add_window_view(fixture_window);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.active = true;
                view.offer_browser_skill(window, cx);
                assert_eq!(view.menu.page, Some(crate::menu::Page::AgentSkill));
                // Another window, or a later tick, does not ask again.
                view.dismiss_menu(window, cx);
                view.offer_browser_skill(window, cx);
                assert_eq!(view.menu.page, None);
            });
            assert_eq!(AgentSkill::choice(cx), Some(Choice::Declined));
        });
    }
}
