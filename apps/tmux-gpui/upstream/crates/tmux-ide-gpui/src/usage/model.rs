//! Plan usage in the terms the status bar and its panel show: which agent,
//! which account, which limit windows, how much of each is used, when each
//! resets, and whatever else the agent's service reports.

use super::service::Service;
use herdr_client::ConnectTarget;
use std::{
    any::Any,
    sync::Arc,
    time::{Duration, SystemTime},
};

/// The machine whose agent sign-ins are read. A remote host is asked over SSH,
/// so its own credentials are used and never leave it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Host {
    Local,
    Ssh(String),
    /// A WSL distribution. Nothing is read from one yet: its files are not this
    /// machine's, and no shell is opened into it for these probes.
    Wsl(String),
}

impl Host {
    /// The host whose sign-ins a device's usage comes from, or `None` for a
    /// cloud machine: it is reached only through its provider's command, and reading
    /// this machine's sign-ins instead would misreport them as the workspace's.
    pub(crate) fn of(target: &ConnectTarget) -> Option<Self> {
        match target {
            ConnectTarget::Ssh { target, .. } => Some(Self::Ssh(target.clone())),
            ConnectTarget::Wsl { distro, .. } => Some(Self::Wsl(distro.clone())),
            #[cfg(feature = "cloud")]
            ConnectTarget::Cloud { .. } => None,
            ConnectTarget::Local | ConnectTarget::Session { .. } | ConnectTarget::Socket(_) => {
                Some(Self::Local)
            }
        }
    }
}

/// A registered provider. Only [`super::registry`] makes one, so each value
/// is a real [`Service`]; two are equal when their ids are.
#[derive(Clone, Copy)]
pub(crate) struct Provider(pub(super) &'static dyn Service);

impl Provider {
    pub fn service(self) -> &'static dyn Service {
        self.0
    }

    pub fn id(self) -> &'static str {
        self.0.meta().id
    }

    pub fn name(self) -> &'static str {
        self.0.meta().name
    }

    pub fn icon(self) -> &'static str {
        self.0.meta().icon_path()
    }
}

impl PartialEq for Provider {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}

impl Eq for Provider {}

impl std::hash::Hash for Provider {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.id().hash(state);
    }
}

impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Provider({})", self.id())
    }
}

/// Which limit a window measures. A named window is one the service names
/// itself, such as a weekly limit scoped to one model.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Session,
    Daily,
    Weekly,
    Monthly,
    Named(String),
}

impl Kind {
    pub fn title(&self) -> &str {
        match self {
            Self::Session => "Session",
            Self::Daily => "Daily",
            Self::Weekly => "Weekly",
            Self::Monthly => "Monthly",
            Self::Named(name) => name,
        }
    }

    /// How long the window usually runs, for judging its pace.
    pub fn length(&self) -> Option<Duration> {
        match self {
            Self::Session => Some(SESSION),
            Self::Daily => Some(DAY),
            Self::Weekly => Some(WEEK),
            Self::Monthly => Some(MONTH),
            Self::Named(_) => None,
        }
    }
}

pub(crate) const DAY: Duration = Duration::from_secs(86_400);
/// A calendar month varies; thirty days is close enough for a pace.
pub(crate) const MONTH: Duration = Duration::from_secs(30 * 86_400);
pub(crate) const SESSION: Duration = Duration::from_secs(5 * 3600);
pub(crate) const WEEK: Duration = Duration::from_secs(7 * 86_400);

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Window {
    pub kind: Kind,
    /// Percent of the window used, clamped to 0..=100.
    pub used: f32,
    pub resets_at: Option<SystemTime>,
    /// How long the window lasts, when known, so its pace can be judged.
    pub length: Option<Duration>,
}

/// How a window's use compares with an even spend across it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Pace {
    /// Percent an even spend would have used by now.
    pub expected: f32,
    /// When the window runs out at the rate used so far, if before it resets.
    pub runs_out: Option<Duration>,
}

impl Window {
    pub fn new(
        kind: Kind,
        used: f64,
        resets_at: Option<SystemTime>,
        length: Option<Duration>,
    ) -> Self {
        Self {
            kind,
            used: used.clamp(0., 100.) as f32,
            resets_at,
            length,
        }
    }

    pub fn percent(&self) -> u32 {
        self.used.round() as u32
    }

    pub fn left(&self) -> u32 {
        100 - self.percent().min(100)
    }

    pub fn resets_in(&self, now: SystemTime) -> Option<Duration> {
        self.resets_at
            .map(|at| at.duration_since(now).unwrap_or_default())
    }

    /// `3% used 2h 53m`: the time left names a session or weekly window, and
    /// a model window is named instead, as the service does.
    pub fn label(&self, now: SystemTime) -> String {
        let suffix = match (&self.kind, self.resets_in(now)) {
            (Kind::Named(name), _) => name.clone(),
            (_, Some(left)) => countdown(left),
            (Kind::Session, None) => "5h".into(),
            (Kind::Daily, None) => "day".into(),
            (Kind::Weekly, None) => "wk".into(),
            (Kind::Monthly, None) => "mo".into(),
        };
        format!("{}% used {suffix}", self.percent())
    }

    /// Nothing until a hundredth of the window has passed: an early estimate
    /// swings too far to be useful.
    pub fn pace(&self, now: SystemTime) -> Option<Pace> {
        let length = self.length?;
        let left = self.resets_at?.duration_since(now).ok()?;
        let elapsed = length.checked_sub(left)?;
        if elapsed < length / 100 {
            return None;
        }
        let expected = (elapsed.as_secs_f64() / length.as_secs_f64() * 100.) as f32;
        let runs_out = (self.used > 0.)
            .then(|| {
                let rate = f64::from(self.used) / elapsed.as_secs_f64();
                Duration::from_secs_f64(f64::from(100. - self.used) / rate)
            })
            .filter(|full| *full < left);
        Some(Pace { expected, runs_out })
    }
}

impl Pace {
    /// `11% in reserve · Lasts until reset`, as CodexBar puts it.
    pub fn describe(&self, used: f32) -> String {
        let margin = self.expected - used;
        let standing = if margin >= 0.5 {
            format!("{}% in reserve", margin.round())
        } else if margin <= -0.5 {
            format!("{}% in deficit", (-margin).round())
        } else {
            "On pace".into()
        };
        let outlook = self.runs_out.map_or_else(
            || "Lasts until reset".into(),
            |left| format!("Runs out in {}", countdown(left)),
        );
        format!("{standing} · {outlook}")
    }
}

/// How alarming a window is, from the share of it already used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Severity {
    Normal,
    Warning,
    Critical,
}

impl From<f32> for Severity {
    fn from(used: f32) -> Self {
        if used >= 80. {
            Self::Critical
        } else if used >= 60. {
            Self::Warning
        } else {
            Self::Normal
        }
    }
}

/// Who is signed in, as far as the sign-in and the service say.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Account {
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// Anything else a service reports, in shapes the panel knows how to draw, so
/// a new provider adds detail without touching the panel.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Section {
    /// A further limit that is not part of the headline windows.
    Limit(Window),
    /// Label and value pairs under a heading.
    Facts {
        title: String,
        facts: Vec<(String, String)>,
    },
    /// Shares of one whole, such as which surfaces spent a weekly limit.
    Shares {
        title: String,
        shares: Vec<(String, f32)>,
    },
}

/// Money or credits left, or spent, in the unit the service counts in.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Balance {
    pub label: String,
    pub amount: f64,
    pub unit: Unit,
    /// What the amount is out of, when the service says, e.g. a monthly budget.
    pub total: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Unit {
    /// An ISO 4217 code such as `USD`.
    Currency(String),
    /// A count of the service's own units, named as it names them.
    Count(String),
}

impl Balance {
    pub fn new(label: impl Into<String>, amount: f64, unit: Unit) -> Self {
        Self {
            label: label.into(),
            amount,
            unit,
            total: None,
        }
    }

    pub fn out_of(mut self, total: f64) -> Self {
        self.total = Some(total);
        self
    }

    /// `$12.30`, `12.30 EUR`, or `1,250 credits`.
    pub fn amount_text(&self) -> String {
        amount_text(self.amount, &self.unit)
    }

    pub fn text(&self) -> String {
        match self.total {
            Some(total) => format!(
                "{} of {}",
                self.amount_text(),
                amount_text(total, &self.unit)
            ),
            None => self.amount_text(),
        }
    }
}

fn amount_text(amount: f64, unit: &Unit) -> String {
    match unit {
        Unit::Currency(code) if code == "USD" => format!("${amount:.2}"),
        Unit::Currency(code) => format!("{amount:.2} {code}"),
        Unit::Count(name) => {
            let whole = amount.round();
            let text = if (amount - whole).abs() < 0.005 {
                group(whole as i64)
            } else {
                format!("{amount:.2}")
            };
            format!("{text} {name}")
        }
    }
}

/// `1250000` as `1,250,000`.
pub(crate) fn group(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
        out.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A provider's own data for its own [`Service::render`], beyond what the
/// shared fields carry. It crosses from the worker thread, so it is shared.
pub(crate) type Detail = Arc<dyn Any + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Report {
    pub provider: Provider,
    pub account: Account,
    /// Session, then weekly, then model windows.
    pub windows: Vec<Window>,
    pub balances: Vec<Balance>,
    pub sections: Vec<Section>,
    pub detail: Option<Detail>,
}

impl std::fmt::Debug for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Report")
            .field("provider", &self.provider)
            .field("account", &self.account)
            .field("windows", &self.windows)
            .field("balances", &self.balances)
            .field("sections", &self.sections)
            .field("detail", &self.detail.is_some())
            .finish()
    }
}

/// Provider detail is opaque, so two reports match when everything shown
/// through the shared fields does.
impl PartialEq for Report {
    fn eq(&self, other: &Self) -> bool {
        self.provider == other.provider
            && self.account == other.account
            && self.windows == other.windows
            && self.balances == other.balances
            && self.sections == other.sections
    }
}

impl Report {
    pub fn new(provider: Provider, account: Account, mut windows: Vec<Window>) -> Self {
        windows.sort_by(|a, b| a.kind.cmp(&b.kind));
        Self {
            provider,
            account,
            windows,
            balances: Vec::new(),
            sections: Vec::new(),
            detail: None,
        }
    }

    pub fn with_sections(mut self, sections: impl IntoIterator<Item = Section>) -> Self {
        self.sections.extend(sections);
        self
    }

    pub fn with_balances(mut self, balances: impl IntoIterator<Item = Balance>) -> Self {
        self.balances.extend(balances);
        self
    }

    pub fn with_detail(mut self, detail: impl Any + Send + Sync) -> Self {
        self.detail = Some(Arc::new(detail));
        self
    }

    /// The provider's own data, if it stored this type.
    pub fn detail<T: Any>(&self) -> Option<&T> {
        self.detail.as_deref()?.downcast_ref()
    }

    /// The window closest to its limit, which the meter shows.
    pub fn tightest(&self) -> Option<&Window> {
        self.windows.iter().max_by(|a, b| a.used.total_cmp(&b.used))
    }
}

/// `47m`, `2h 53m`, `4d 11h`: the coarsest two units that still say when.
pub(crate) fn countdown(left: Duration) -> String {
    let minutes = left.as_secs().div_ceil(60);
    let (days, hours, minutes) = (minutes / 1440, minutes / 60 % 24, minutes % 60);
    match (days, hours) {
        (0, 0) => format!("{minutes}m"),
        (0, _) => format!("{hours}h {minutes}m"),
        _ => format!("{days}d {hours}h"),
    }
}

/// `pro` to `Pro`, `max` to `Max`: plan identifiers read as names.
pub(crate) fn title_case(word: &str) -> String {
    let mut chars = word.trim().chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
