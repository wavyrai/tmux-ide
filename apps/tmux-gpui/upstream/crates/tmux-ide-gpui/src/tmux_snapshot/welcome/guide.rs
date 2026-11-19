//! The setup guide (onboarding, phase 1): Set up, Look and Keys in Home's
//! place, behind a step rail, with Skip, Back and Continue. Every choice is
//! saved when it is made; Esc closes it at any step. Machines and Agents are
//! later phases and join the rail when they are built.
use super::*;
use crate::tmux_snapshot::appearance::{System, native};

/// `reached` for someone who has seen every step (and every version 1
/// welcomed user).
pub(in crate::tmux_snapshot) const ALL_REACHED: u8 = 5;

/// What the saved file keeps of the guide (version 2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Progress {
    /// The furthest step reached, by its place in the five-step guide
    /// (1 Set up, 3 Look, 5 Keys); 0 before the guide first opens.
    pub reached: u8,
    /// Closed from its last step.
    pub finished: bool,
    /// Went on with setup unfinished ("Continue without it").
    pub setup_skipped: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Step {
    #[default]
    SetUp,
    Look,
    Keys,
}
impl Step {
    pub const ALL: [Step; 3] = [Step::SetUp, Step::Look, Step::Keys];
    pub fn name(self) -> &'static str {
        match self {
            Step::SetUp => "Set up",
            Step::Look => "Look",
            Step::Keys => "Keys",
        }
    }
    /// Its place in the five-step guide the design lays out, Machines
    /// second and Agents fourth, so `reached` keeps its meaning as they land.
    pub fn place(self) -> u8 {
        match self {
            Step::SetUp => 1,
            Step::Look => 3,
            Step::Keys => 5,
        }
    }
    pub fn index(self) -> usize {
        Step::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }
    fn next(self) -> Option<Step> {
        Step::ALL.get(self.index() + 1).copied()
    }
    fn back(self) -> Option<Step> {
        self.index().checked_sub(1).map(|i| Step::ALL[i])
    }
}

/// Look's segmented control: Match macOS, or the light or dark themes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Filter {
    System,
    Light,
    Dark,
}
impl Filter {
    pub const ALL: [Filter; 3] = [Filter::System, Filter::Light, Filter::Dark];
    pub fn label(self) -> &'static str {
        match self {
            Filter::System => "Match macOS",
            Filter::Light => "Light",
            Filter::Dark => "Dark",
        }
    }
    fn mode(self) -> &'static str {
        match self {
            Filter::System => "system",
            Filter::Light => "light",
            Filter::Dark => "dark",
        }
    }
}

/// The catalog's preset `id`, if there is one.
pub(in crate::tmux_snapshot) fn preset(id: &str) -> Option<&'static native::Preset> {
    native::catalog().iter().find(|p| p.id == id)
}
/// The segment a theme belongs under.
pub(in crate::tmux_snapshot) fn filter_of(id: &str) -> Filter {
    match preset(id).map(|p| p.mode.as_str()) {
        Some("light") => Filter::Light,
        Some("dark") => Filter::Dark,
        _ => Filter::System,
    }
}
/// The themes listed under Light or Dark (and Match macOS's two sides).
pub(in crate::tmux_snapshot) fn themes(filter: Filter) -> Vec<&'static native::Preset> {
    native::catalog()
        .iter()
        .filter(|p| p.mode == filter.mode())
        .collect()
}
/// What choosing `filter` selects: nothing when the theme in use is already
/// under it, so Dark → Light → Dark comes back to your theme; otherwise the
/// one last picked under it this run, or Match macOS's theme for that side.
pub(in crate::tmux_snapshot) fn on_filter(
    filter: Filter,
    selected: &str,
    pair: (&str, &str),
    remembered: &[Option<String>; 2],
) -> Option<String> {
    if filter_of(selected) == filter {
        return None;
    }
    Some(match filter {
        Filter::System => "system".into(),
        Filter::Light => remembered[0].clone().unwrap_or_else(|| pair.0.into()),
        Filter::Dark => remembered[1].clone().unwrap_or_else(|| pair.1.into()),
    })
}

/// What a guide control does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Act {
    Go(Step),
    Back,
    Next,
    Skip,
    ContinueWithout,
    Filter(Filter),
    Theme(String),
    ThemeFor(System, String),
    FontSize(i8),
    CursorMotion(bool),
    Opaque(bool),
    Tick(usize),
}

/// The guide's keyboard stops, by slot in `State.focus`. Set up keeps the
/// welcome's first three (secondary, primary, skip).
pub(in crate::tmux_snapshot) mod slot {
    pub const SECONDARY: usize = 0;
    pub const PRIMARY: usize = 1;
    pub const SKIP: usize = 2;
    pub const BACK: usize = 3;
    pub const NEXT: usize = 4;
    pub const RAIL: usize = 5;
    pub const SEGMENT: usize = 8;
    pub const GRID: usize = 9;
    pub const GRID_DARK: usize = 10;
    pub const FONT_DOWN: usize = 11;
    pub const FONT_UP: usize = 12;
    pub const CURSOR: usize = 13;
    pub const OPAQUE: usize = 14;
    pub const COUNT: usize = 15;
}

/// How a stop answers Return and Space. Return on a stop that isn't a
/// button means Continue, as a default button does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Kind {
    /// Return and Space press it.
    Press,
    /// Space flips it.
    Switch,
    /// Arrows move inside it.
    Group,
}

/// The guide's step and what this run remembers.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Guide {
    pub step: Step,
    pub reached: u8,
    pub finished: bool,
    pub setup_skipped: bool,
    /// Look's segment as last chosen; until then, the theme's own.
    pub filter: Option<Filter>,
    /// The theme last picked under Light and under Dark this run.
    pub remembered: [Option<String>; 2],
    /// The Keys step's rows pressed so far.
    pub tried: [bool; 8],
    /// The step changed: its first stop takes the keyboard next render.
    pub moved: bool,
    /// Opened from Commands: every step can be visited at once.
    pub reopened: bool,
    /// A theme change that could not be sent.
    pub note: Option<&'static str>,
}
impl Guide {
    pub(super) fn from_progress(progress: Progress) -> Self {
        Self {
            reached: progress.reached,
            finished: progress.finished,
            setup_skipped: progress.setup_skipped,
            ..Default::default()
        }
    }
    pub(super) fn progress(&self) -> Progress {
        Progress {
            reached: self.reached,
            finished: self.finished,
            setup_skipped: self.setup_skipped,
        }
    }
    /// Back to the first step, as Commands opens it.
    pub(super) fn restart(&mut self) {
        self.step = Step::SetUp;
        self.moved = true;
        self.filter = None;
        self.tried = Default::default();
        self.note = None;
        self.reached = self.reached.max(Step::SetUp.place());
    }
    /// A rail step can be clicked once reached, and every step when the
    /// guide is opened from Commands.
    pub fn enabled(&self, step: Step) -> bool {
        self.reopened || step.place() <= self.reached
    }
    fn go(&mut self, step: Step) {
        self.moved = self.step != step || self.moved;
        self.step = step;
        self.reached = self.reached.max(step.place());
    }
}

impl SnapshotView {
    pub(super) fn guide_act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        let guide = &mut self.welcome.guide;
        match act {
            Act::Go(step) => {
                if guide.enabled(step) {
                    guide.go(step);
                    self.save_welcome(cx);
                }
            }
            Act::Next => match guide.step.next() {
                Some(step) => {
                    guide.go(step);
                    self.save_welcome(cx);
                }
                None => self.start_using(window, cx),
            },
            Act::Back => {
                if let Some(step) = guide.step.back() {
                    guide.go(step);
                }
            }
            Act::Skip => self.close_welcome(cx),
            Act::ContinueWithout => {
                guide.setup_skipped = true;
                guide.go(Step::Look);
                self.save_welcome(cx);
            }
            Act::Filter(filter) => {
                guide.filter = Some(filter);
                // The theme in use is the one to come back to under its
                // own segment.
                if let Some(selected) = self.browser_state.appearance.as_ref().map(|a| &a.selected)
                {
                    match filter_of(selected) {
                        Filter::Light => guide.remembered[0] = Some(selected.clone()),
                        Filter::Dark => guide.remembered[1] = Some(selected.clone()),
                        Filter::System => {}
                    }
                }
                let target = self.browser_state.appearance.as_ref().and_then(|a| {
                    on_filter(
                        filter,
                        &a.selected,
                        (&a.light, &a.dark),
                        &self.welcome.guide.remembered,
                    )
                });
                if let Some(id) = target {
                    self.send_theme(browser::Command::Theme { id });
                }
            }
            Act::Theme(id) => {
                match filter_of(&id) {
                    Filter::Light => guide.remembered[0] = Some(id.clone()),
                    Filter::Dark => guide.remembered[1] = Some(id.clone()),
                    Filter::System => {}
                }
                self.send_theme(browser::Command::Theme { id });
            }
            Act::ThemeFor(side, id) => self.send_theme(browser::Command::ThemeFor { side, id }),
            Act::FontSize(delta) => {
                self.choose_terminal_font(super::super::terminal_font::Choice::Size(delta), cx)
            }
            Act::CursorMotion(on) => self.set_cursor_motion(on, cx),
            Act::Opaque(on) => self.set_opaque_window(on, cx),
            Act::Tick(row) => {
                if let Some(tried) = guide.tried.get_mut(row) {
                    *tried = true;
                }
            }
        }
        cx.notify();
    }
    /// Queues a theme change for the appearance owner; the publication that
    /// comes back is what moves the selection (and says if saving failed).
    fn send_theme(&mut self, command: browser::Command) {
        let sent = self
            .browser_commands
            .as_ref()
            .is_some_and(|tx| tx.try_send(command).is_ok());
        self.welcome.guide.note = (!sent).then_some("Theme change unavailable — try again");
    }
    /// The guide's last button: the most recent session, or New session…
    /// when there is none; just Home while setup isn't done.
    fn start_using(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.welcome.guide.finished = true;
        let connected = self.browser_commands.is_some();
        let next = match stage(&self.browser_state, connected) {
            Stage::Ready { .. } => Some(
                known_sessions(&self.browser_state)
                    .first()
                    .map_or(super::Act::StartNew, |known| {
                        super::Act::Open(known.open.clone())
                    }),
            ),
            _ => None,
        };
        match next {
            Some(act) => self.welcome_act(act, window, cx),
            None => self.close_welcome(cx),
        }
    }
    /// The guide's keyboard: Tab and Shift-Tab move between its stops,
    /// Return and Space press, arrows move inside a group, Esc closes. On
    /// the Keys step a key it lists ticks its row and goes no further.
    pub(super) fn guide_key(
        &mut self,
        event: &KeyDownEvent,
        order: &[(usize, super::Act, Kind)],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        if event.is_held {
            return;
        }
        if self.welcome.guide.step == Step::Keys
            && let Some(row) = guide_keys::row_for(key)
        {
            self.guide_act(Act::Tick(row), window, cx);
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if key.modifiers.platform || key.modifiers.control || key.modifiers.alt {
            return;
        }
        let at = order
            .iter()
            .position(|(slot, _, _)| self.welcome.focus[*slot].is_focused(window));
        let next = order
            .iter()
            .find(|(slot, _, _)| *slot == slot::NEXT)
            .map(|(_, act, _)| act.clone());
        match key.key.as_str() {
            "tab" if !order.is_empty() => {
                let to = match (at, key.modifiers.shift) {
                    (None, false) => 0,
                    (None, true) => order.len() - 1,
                    (Some(i), false) => (i + 1) % order.len(),
                    (Some(i), true) => (i + order.len() - 1) % order.len(),
                };
                self.welcome.focus[order[to].0].clone().focus(window, cx);
            }
            "escape" => self.close_welcome(cx),
            "enter" | "space" => {
                let enter = key.key == "enter";
                match at.map(|i| &order[i]) {
                    Some((_, act, Kind::Press)) => {
                        let act = act.clone();
                        self.press(act, window, cx);
                    }
                    Some((_, act, Kind::Switch)) if !enter => {
                        let act = act.clone();
                        self.press(act, window, cx);
                    }
                    _ if enter => match next {
                        Some(act) => self.press(act, window, cx),
                        None => return,
                    },
                    _ => return,
                }
            }
            "left" | "right" | "up" | "down" => {
                let Some((slot, _, Kind::Group)) = at.map(|i| &order[i]) else {
                    return;
                };
                let Some(act) = self.look_arrow(*slot, key.key.as_str()) else {
                    return;
                };
                self.guide_act(act, window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
    }
    fn press(&mut self, act: super::Act, window: &mut Window, cx: &mut Context<Self>) {
        self.welcome_act(act, window, cx);
    }
}
