//! First run (onboarding A1): a welcome surface in Home's place, which sets
//! Tmux IDE up with the existing managed setup and says what happened in
//! plain words; and What's new once per version (A5).
//!
//! Remembered in ~/.config/tmux-ide/gpui-onboarding.json, the same small,
//! versioned, atomically written file the app keeps for its other view
//! preferences (gpui-developer.json, the terminal font).
use super::{SnapshotView, browser, browser_ui::Selection};
use browser::local_setup::Phase;
use gpui::{prelude::*, *};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[path = "welcome/render.rs"]
mod render;
#[path = "welcome/whats_new.rs"]
pub(super) mod whats_new;

/// The managed setup's own deadline (herdr-client local_setup.rs).
pub(super) const SETUP_DEADLINE: Duration = Duration::from_secs(20);
pub(super) const INSTALL_COMMAND: &str =
    "curl -fsSL https://tmux-ide.com/install.sh | sh -s -- --native-alpha";
pub(super) const UPDATE_COMMAND: &str =
    "curl -fsSL https://tmux-ide.com/install.sh | sh -s -- --native-alpha --update";
pub(super) const HELP_URL: &str = "https://github.com/wavyrai/tmux-ide/issues";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    welcomed: bool,
    #[serde(default)]
    whats_new_seen: Option<String>,
}

/// What the app remembers, and the welcome's state for this run.
#[derive(Default)]
pub(super) struct State {
    started: bool,
    /// The saved file has been read (or found missing).
    pub ready: bool,
    path: Option<PathBuf>,
    /// The welcome was shown and closed, or this Mac was already set up.
    pub welcomed: bool,
    /// The last version whose What's new card was closed.
    pub whats_new_seen: Option<String>,
    /// This app's version (the bundle's), when it has one.
    pub version: Option<String>,
    /// First run was decided for this run.
    decided: bool,
    /// The welcome is in Home's place.
    pub open: bool,
    /// When this app last asked for setup, for the elapsed time.
    setup_started: Option<Instant>,
    /// The phase seen last, to notice a run that just stopped.
    last_phase: Option<Phase>,
    /// How long the run that stopped had been going.
    pub stopped_after: Option<Duration>,
    /// A one-second repaint is pending while setup runs.
    ticking: bool,
    /// The keyboard order of the welcome's buttons.
    pub(super) focus: Vec<FocusHandle>,
}

/// What first run means for this window, decided once per run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    /// Not yet known: the saved state or Home hasn't loaded.
    Wait,
    /// Setup is needed here: show the welcome.
    Show,
    /// This Mac is set up and Home is live: an existing user, never shown.
    AlreadySetUp,
    /// Welcomed before.
    Welcomed,
}

/// The first-run rule. The welcome shows only where setup is needed and it
/// was never closed; someone whose Mac is set up with Home live never sees
/// it (they open it from Commands if they want it).
pub(super) fn decide(
    ready: bool,
    welcomed: bool,
    connected: bool,
    setup: Option<Phase>,
    live: bool,
) -> Decision {
    if !ready {
        Decision::Wait
    } else if welcomed {
        Decision::Welcomed
    } else if !connected {
        Decision::Wait
    } else if setup.is_some() {
        Decision::Show
    } else if live {
        Decision::AlreadySetUp
    } else {
        Decision::Wait
    }
}

/// Where the welcome is: setting up (with the setup's phase), set up (with
/// the sessions already there), or waiting for Home.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Setup(Phase),
    Ready { sessions: usize },
    Waiting,
}
pub(super) fn stage(state: &browser::State, connected: bool) -> Stage {
    match state.local_setup.as_ref().filter(|_| connected) {
        Some(setup) => Stage::Setup(setup.phase),
        None if connected && state.home_phase == browser::HomePhase::Live => Stage::Ready {
            sessions: known_sessions(state).len(),
        },
        None => Stage::Waiting,
    }
}

/// How the welcome opens a session it lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Open {
    /// A session in Home's own list, by id.
    Session(String),
    /// A session of the machines' table, by its selection token.
    Fleet(String),
}
/// A session the welcome lists: its name, a short description and how to
/// open it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Known {
    pub label: String,
    pub detail: Option<String>,
    pub open: Open,
}
/// The sessions already there, the most recently active first: the
/// machines' table when Home has one, otherwise Home's own list.
pub(super) fn known_sessions(state: &browser::State) -> Vec<Known> {
    if let Some(fleet) = &state.fleet {
        let mut sessions: Vec<&browser::fleet::Session> = fleet
            .groups
            .iter()
            .flat_map(|g| g.sessions.iter())
            .filter(|s| s.selection.is_some())
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
        return sessions
            .into_iter()
            .map(|s| Known {
                label: s.name.clone(),
                detail: Some(match s.window_count {
                    Some(w) => format!(
                        "{w} {} · {} {}",
                        if w == 1 { "window" } else { "windows" },
                        s.pane_count,
                        if s.pane_count == 1 { "pane" } else { "panes" }
                    ),
                    None => format!(
                        "{} {}",
                        s.pane_count,
                        if s.pane_count == 1 { "pane" } else { "panes" }
                    ),
                }),
                open: Open::Fleet(s.selection.clone().unwrap_or_default()),
            })
            .collect();
    }
    state
        .sessions
        .iter()
        .map(|s| Known {
            label: s.label.clone(),
            detail: s.pane_count_label(),
            open: Open::Session(s.id.clone()),
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mark {
    Done,
    Pending,
    Running,
    Problem,
}
/// One line of the checklist, as the eye and VoiceOver read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Line {
    pub mark: Mark,
    pub title: String,
    pub detail: Option<String>,
    pub status: String,
}
fn line(mark: Mark, title: &str, detail: Option<&str>, status: &str) -> Line {
    Line {
        mark,
        title: title.into(),
        detail: detail.map(Into::into),
        status: status.into(),
    }
}
pub(super) const CLI_TITLE: &str = "tmux-ide command-line tool";
pub(super) const SERVICE_TITLE: &str = "Background service";
pub(super) const SERVICE_DETAIL: &str = "Keeps your sessions running when the app is closed.";
pub(super) const STARTING: &str = "Starting the background service…";
pub(super) const STARTING_DETAIL: &str = "This takes a few seconds.";
pub(super) const FAILED_TITLE: &str = "The background service didn't start";
pub(super) const FAILED_TIMEOUT: &str =
    "It stopped after 20 seconds without answering. Your files and sessions are fine.";
pub(super) const FAILED_EARLY: &str =
    "It stopped before it answered. Your files and sessions are fine.";
pub(super) const FAILED_OTHER: &str =
    "Something went wrong while starting it. Your files and sessions are fine.";
pub(super) const MISSING: &str =
    "Tmux IDE needs its command-line tool. Install it with one command, then come back here.";
pub(super) const MISMATCH: &str =
    "This version of the command-line tool doesn't match the app. Update both with one command.";
pub(super) const UNRECOGNIZED: &str =
    "The command-line tool's installation wasn't recognized. Install it again with one command.";

/// The checklist for `stage`. `elapsed` is how long setup has been running;
/// `stopped_after`, how long a run that stopped had run. Agents are left
/// out until the app can find them (onboarding A2).
pub(super) fn lines(
    stage: Stage,
    elapsed: Option<Duration>,
    stopped_after: Option<Duration>,
) -> Vec<Line> {
    let cli = match stage {
        Stage::Setup(Phase::Missing) => {
            line(Mark::Problem, CLI_TITLE, Some(MISSING), "Not installed")
        }
        Stage::Setup(Phase::Unsupported) => {
            line(Mark::Problem, CLI_TITLE, Some(MISMATCH), "Doesn't match")
        }
        Stage::Setup(Phase::Unrecognized) => line(
            Mark::Problem,
            CLI_TITLE,
            Some(UNRECOGNIZED),
            "Not recognized",
        ),
        Stage::Waiting => line(Mark::Pending, CLI_TITLE, None, "Checking…"),
        _ => line(Mark::Done, CLI_TITLE, None, "Installed"),
    };
    let service = match stage {
        Stage::Setup(Phase::Available) => line(
            Mark::Pending,
            SERVICE_TITLE,
            Some(SERVICE_DETAIL),
            "Not running",
        ),
        Stage::Setup(Phase::Running) => line(
            Mark::Running,
            STARTING,
            Some(STARTING_DETAIL),
            &elapsed.map_or(String::new(), |e| format!("{} s", e.as_secs())),
        ),
        Stage::Setup(Phase::StoppedWaiting) => {
            let ran_out =
                stopped_after.is_some_and(|ran| ran + Duration::from_millis(500) >= SETUP_DEADLINE);
            line(
                Mark::Problem,
                FAILED_TITLE,
                Some(if ran_out {
                    FAILED_TIMEOUT
                } else {
                    FAILED_EARLY
                }),
                "",
            )
        }
        Stage::Setup(Phase::Failed) => line(Mark::Problem, FAILED_TITLE, Some(FAILED_OTHER), ""),
        Stage::Setup(_) => line(
            Mark::Pending,
            SERVICE_TITLE,
            Some(SERVICE_DETAIL),
            "Not running",
        ),
        Stage::Ready { .. } => line(Mark::Done, SERVICE_TITLE, Some(SERVICE_DETAIL), "Running"),
        Stage::Waiting => line(
            Mark::Pending,
            SERVICE_TITLE,
            Some(SERVICE_DETAIL),
            "Checking…",
        ),
    };
    let mut lines = vec![cli, service];
    if let Stage::Ready { sessions } = stage
        && sessions > 0
    {
        lines.push(line(Mark::Done, &already(sessions), None, "Ready"));
    }
    lines
}
pub(super) fn already(sessions: usize) -> String {
    if sessions == 1 {
        "You already have 1 tmux session".into()
    } else {
        format!("You already have {sessions} tmux sessions")
    }
}

/// What a welcome button does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Act {
    SetUp,
    TryAgain,
    CopyDetails,
    CopyInstall,
    InstalledIt,
    CopyUpdate,
    CheckAgain,
    Open(Open),
    StartNew,
    Close,
}
/// One button: its words, what it does, and whether it can act now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Button {
    pub label: String,
    pub act: Act,
    pub enabled: bool,
}
fn button(label: &str, act: Act) -> Button {
    Button {
        label: label.into(),
        act,
        enabled: true,
    }
}
/// The secondary button (if any) and the primary one for `stage`; the first
/// session is the one Home lists first.
pub(super) fn buttons(stage: Stage, first: Option<&Known>) -> (Option<Button>, Button) {
    match stage {
        Stage::Setup(Phase::Available) => (None, button("Set up Tmux IDE", Act::SetUp)),
        Stage::Setup(Phase::Running) => (
            None,
            Button {
                enabled: false,
                ..button("Setting up…", Act::SetUp)
            },
        ),
        Stage::Setup(Phase::Failed | Phase::StoppedWaiting) => (
            Some(button("Copy details", Act::CopyDetails)),
            button("Try again", Act::TryAgain),
        ),
        Stage::Setup(Phase::Missing) => (
            Some(button("Copy install command", Act::CopyInstall)),
            button("I've installed it", Act::InstalledIt),
        ),
        Stage::Setup(Phase::Unsupported | Phase::Unrecognized) => (
            Some(button("Check again", Act::CheckAgain)),
            button("Copy update command", Act::CopyUpdate),
        ),
        Stage::Ready { sessions } if sessions > 0 => match first {
            Some(known) => (
                Some(button("Start somewhere new…", Act::StartNew)),
                button(
                    &format!("Open {}", known.label),
                    Act::Open(known.open.clone()),
                ),
            ),
            None => (None, button("New session…", Act::StartNew)),
        },
        Stage::Ready { .. } => (None, button("New session…", Act::StartNew)),
        Stage::Waiting => (
            None,
            Button {
                enabled: false,
                ..button("Checking…", Act::CheckAgain)
            },
        ),
    }
}
pub(super) const TITLE: &str = "Welcome to Tmux IDE";
pub(super) const READY_TITLE: &str = "You're set up";
pub(super) const LEDE: &str =
    "Your terminals and coding agents, side by side. They keep running when you close the window.";
/// Where to find the welcome again, until a Help menu exists.
pub(super) const SKIP_HINT: &str = "You can open it again from Commands: Welcome to Tmux IDE…";
pub(super) const STUCK: &str = "Still stuck? Run tmux-ide doctor in Terminal, or get help.";

fn path() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .filter(|p| p.is_absolute())
        .map(|p| p.join("tmux-ide/gpui-onboarding.json"))
}
fn read(path: &Path) -> io::Result<Saved> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(io::Error::other("onboarding state must be a file"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1025)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 {
        return Err(io::Error::other("onboarding state exceeds limit"));
    }
    let saved: Saved = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if saved.version != 1 {
        return Err(io::Error::other("unsupported onboarding state version"));
    }
    Ok(saved)
}
fn write(path: &Path, saved: &Saved) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing onboarding parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".gpui-onboarding-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(saved).map_err(io::Error::other)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    drop(file);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
impl State {
    fn load(path: Option<PathBuf>, version: Option<String>) -> Self {
        let saved = path
            .as_deref()
            .and_then(|p| read(p).ok())
            .unwrap_or_default();
        Self {
            started: true,
            ready: true,
            path,
            welcomed: saved.welcomed,
            whats_new_seen: saved.whats_new_seen,
            version,
            ..Default::default()
        }
    }
    /// A loaded state with no file, for the capture example's renders.
    #[cfg(feature = "visual-capture")]
    pub(super) fn preview(
        open: bool,
        welcomed: bool,
        version: Option<&str>,
        started: Option<Instant>,
        stopped_after: Option<Duration>,
    ) -> Self {
        Self {
            started: true,
            ready: true,
            welcomed,
            version: version.map(Into::into),
            decided: open || welcomed,
            open,
            setup_started: started,
            last_phase: started.map(|_| Phase::Running),
            stopped_after,
            ..Default::default()
        }
    }
    #[cfg(test)]
    pub(super) fn for_test(path: Option<PathBuf>, version: Option<&str>) -> Self {
        Self::load(path, version.map(Into::into))
    }
    fn saved(&self) -> Saved {
        Saved {
            version: 1,
            welcomed: self.welcomed,
            whats_new_seen: self.whats_new_seen.clone(),
        }
    }
}

impl SnapshotView {
    pub(super) fn load_welcome(&mut self, cx: &mut Context<Self>) {
        if self.welcome.started {
            return;
        }
        self.welcome.started = true;
        let task = cx
            .background_executor()
            .spawn(async { State::load(path(), super::diagnostics::app_version()) });
        cx.spawn(async move |view, cx| {
            let state = task.await;
            let _ = view.update(cx, |view, cx| {
                let open = view.welcome.open;
                view.welcome = state;
                view.welcome.open = open;
                cx.notify();
            });
        })
        .detach();
    }
    fn save_welcome(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.welcome.path.clone() else {
            return;
        };
        let saved = self.welcome.saved();
        // A failed save shows the welcome again next time, which is safe.
        cx.background_executor()
            .spawn(async move {
                let _ = write(&path, &saved);
            })
            .detach();
    }
    /// Decides first run once, and follows setup while the welcome is open:
    /// the elapsed time, a run that stopped, and Home becoming live.
    pub(super) fn observe_welcome(&mut self, cx: &mut Context<Self>) {
        let connected = self.browser_commands.is_some();
        let setup = self
            .browser_state
            .local_setup
            .as_ref()
            .filter(|_| connected)
            .map(|s| s.phase);
        let live = connected && self.browser_state.home_phase == browser::HomePhase::Live;
        if !self.welcome.decided {
            match decide(
                self.welcome.ready,
                self.welcome.welcomed,
                connected,
                setup,
                live,
            ) {
                Decision::Wait => {}
                Decision::Show => {
                    self.welcome.decided = true;
                    self.welcome.open = true;
                }
                Decision::AlreadySetUp => {
                    self.welcome.decided = true;
                    // An existing user: never welcomed, but What's new shows.
                    self.welcome.welcomed = true;
                    self.save_welcome(cx);
                }
                Decision::Welcomed => self.welcome.decided = true,
            }
        }
        let now = cx.background_executor().now();
        if setup == Some(Phase::Running) && self.welcome.setup_started.is_none() {
            self.welcome.setup_started = Some(now);
        }
        if matches!(setup, Some(Phase::Failed | Phase::StoppedWaiting))
            && self.welcome.last_phase == Some(Phase::Running)
        {
            self.welcome.stopped_after = self
                .welcome
                .setup_started
                .map(|started| now.saturating_duration_since(started));
            self.welcome.setup_started = None;
        }
        if setup != Some(Phase::Running) && setup != self.welcome.last_phase {
            self.welcome.setup_started = None;
        }
        self.welcome.last_phase = setup;
        // Set up while the welcome is open: remember it, so it never shows
        // again by itself, and let What's new wait for the next version.
        if self.welcome.open && live && !self.welcome.welcomed {
            self.welcome.welcomed = true;
            self.welcome.whats_new_seen = self.welcome.version.clone();
            self.save_welcome(cx);
        }
        if self.welcome.open && setup == Some(Phase::Running) && !self.welcome.ticking {
            self.welcome.ticking = true;
            cx.spawn(async move |view, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let _ = view.update(cx, |view, cx| {
                    view.welcome.ticking = false;
                    cx.notify();
                });
            })
            .detach();
        }
    }
    /// How long setup has been running, while it runs.
    pub(super) fn welcome_elapsed(&self, cx: &App) -> Option<Duration> {
        let started = self.welcome.setup_started?;
        Some(
            cx.background_executor()
                .now()
                .saturating_duration_since(started),
        )
    }
    /// Commands → "Welcome to Tmux IDE…": opens it whatever first run said.
    pub(super) fn open_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.welcome.decided = true;
        self.welcome.open = true;
        if self.browser_state.surface != browser::Surface::Home {
            self.select(Selection::Home, window, cx);
        }
        cx.notify();
    }
    /// Closes the welcome and remembers it, with this version's What's new.
    pub(super) fn close_welcome(&mut self, cx: &mut Context<Self>) {
        self.welcome.open = false;
        self.welcome.welcomed = true;
        if self.welcome.whats_new_seen.is_none() {
            self.welcome.whats_new_seen = self.welcome.version.clone();
        }
        self.save_welcome(cx);
        cx.notify();
    }
    pub(super) fn welcome_act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        let request = self.browser_request;
        match act {
            Act::SetUp | Act::TryAgain => {
                self.welcome.stopped_after = None;
                self.home_refresh(request, window, cx);
                if self
                    .browser_state
                    .local_setup
                    .as_ref()
                    .is_some_and(|s| s.phase == Phase::Running)
                {
                    self.welcome.setup_started = Some(cx.background_executor().now());
                    self.welcome.last_phase = Some(Phase::Running);
                }
            }
            Act::InstalledIt | Act::CheckAgain => self.home_refresh(request, window, cx),
            Act::CopyDetails => self.copy_diagnostics(window, cx),
            Act::CopyInstall => {
                cx.write_to_clipboard(ClipboardItem::new_string(INSTALL_COMMAND.into()))
            }
            Act::CopyUpdate => {
                cx.write_to_clipboard(ClipboardItem::new_string(UPDATE_COMMAND.into()))
            }
            Act::Open(Open::Session(id)) => {
                self.close_welcome(cx);
                self.home_select(request, &id, window, cx);
            }
            Act::Open(Open::Fleet(token)) => {
                self.close_welcome(cx);
                self.open_fleet_session(request, &token, window, cx);
            }
            Act::StartNew => {
                self.close_welcome(cx);
                self.open_local_session(request, window, cx);
            }
            Act::Close => self.close_welcome(cx),
        }
        cx.notify();
    }
}

#[cfg(test)]
#[path = "welcome/focus_tests.rs"]
mod focus_tests;
#[cfg(test)]
#[path = "welcome/tests.rs"]
mod tests;
