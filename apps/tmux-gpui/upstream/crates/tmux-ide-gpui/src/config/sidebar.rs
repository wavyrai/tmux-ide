//! Daemon `[ui.sidebar]` layouts and token rules.
use serde::Deserialize;
use std::{collections::BTreeMap, str::FromStr};

const MAX_ROWS: usize = 16;
const MAX_TOKENS_PER_ROW: usize = 16;
const MAX_RULES: usize = 16;
const MAX_CUSTOM_TOKEN_LEN: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SidebarConfigError {
    #[error("sidebar layouts may contain at most {MAX_ROWS} rows")]
    TooManyRows,
    #[error("sidebar rows may contain at most {MAX_TOKENS_PER_ROW} tokens")]
    TooManyTokens,
    #[error("sidebar tokens may contain at most {MAX_RULES} rules")]
    TooManyRules,
    #[error("unknown sidebar token `{0}`; custom tokens must start with `$`")]
    UnknownToken(String),
    #[error("invalid custom sidebar token `{0}`")]
    InvalidCustomToken(String),
    #[error("sidebar rules require a text-valued token")]
    RulesOnFixedToken,
    #[error("sidebar rule requires exactly one of equals, contains, starts_with, gt, lt")]
    RuleConditionCount,
    #[error("sidebar numeric rule threshold must be finite")]
    RuleThresholdNotFinite,
    #[error("ignore_case applies only to sidebar text conditions")]
    RuleIgnoreCaseOnNumber,
    #[error("sidebar token fg must be #RGB or #RRGGBB")]
    InvalidColor,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SidebarLayout {
    pub agents: AgentLayout,
    pub spaces: SpaceLayout,
}

impl SidebarLayout {
    /// Defaults when `[ui.sidebar]` is absent; unrelated tables are ignored.
    pub(super) fn from_daemon_config(table: &toml::Table) -> Result<Self, toml::de::Error> {
        let Some(sidebar) = table.get("ui").and_then(|ui| ui.get("sidebar")) else {
            return Ok(Self::default());
        };
        Deserialize::deserialize(sidebar.clone())
    }
}

pub type Rows<T> = Vec<Vec<ConfiguredToken<T>>>;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct AgentLayout {
    #[serde(deserialize_with = "bounded_rows")]
    pub rows: Rows<AgentToken>,
    #[serde(deserialize_with = "rows_by_agent")]
    pub rows_by_agent: BTreeMap<String, Rows<AgentToken>>,
    pub row_gap: u16,
}

impl AgentLayout {
    pub(crate) fn shows_status_text(&self, agent: Option<&str>) -> bool {
        self.rows_for(agent)
            .iter()
            .flatten()
            .any(|token| token.token == AgentToken::StateText)
    }

    pub fn rows_for(&self, canonical_agent: Option<&str>) -> &Rows<AgentToken> {
        canonical_agent
            .and_then(|agent| self.rows_by_agent.get(agent))
            .unwrap_or(&self.rows)
    }
}

impl Default for AgentLayout {
    fn default() -> Self {
        Self {
            rows: vec![
                plain([
                    AgentToken::StateIcon,
                    AgentToken::Machine,
                    AgentToken::Workspace,
                    AgentToken::Tab,
                ]),
                plain([AgentToken::Agent]),
            ],
            rows_by_agent: BTreeMap::new(),
            row_gap: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SpaceLayout {
    #[serde(deserialize_with = "bounded_rows")]
    pub rows: Rows<SpaceToken>,
    pub row_gap: u16,
}

impl Default for SpaceLayout {
    fn default() -> Self {
        Self {
            rows: vec![
                plain([SpaceToken::StateIcon, SpaceToken::Workspace]),
                plain([SpaceToken::Branch, SpaceToken::GitStatus]),
            ],
            row_gap: 0,
        }
    }
}

fn plain<T>(tokens: impl IntoIterator<Item = T>) -> Vec<ConfiguredToken<T>> {
    tokens.into_iter().map(ConfiguredToken::plain).collect()
}

fn check_rows<T>(rows: &Rows<T>) -> Result<(), SidebarConfigError> {
    if rows.len() > MAX_ROWS {
        return Err(SidebarConfigError::TooManyRows);
    }
    if rows.iter().any(|row| row.len() > MAX_TOKENS_PER_ROW) {
        return Err(SidebarConfigError::TooManyTokens);
    }
    Ok(())
}

fn bounded_rows<'de, D, T>(deserializer: D) -> Result<Rows<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    ConfiguredToken<T>: Deserialize<'de>,
{
    let rows = Rows::<T>::deserialize(deserializer)?;
    check_rows(&rows).map_err(serde::de::Error::custom)?;
    Ok(rows)
}

fn rows_by_agent<'de, D>(deserializer: D) -> Result<BTreeMap<String, Rows<AgentToken>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let rows_by_agent = BTreeMap::<String, Rows<AgentToken>>::deserialize(deserializer)?;
    for rows in rows_by_agent.values() {
        check_rows(rows).map_err(serde::de::Error::custom)?;
    }
    Ok(rows_by_agent)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredToken<T> {
    pub token: T,
    pub style: TokenStyle,
    pub rules: Vec<TokenRule>,
}

impl<T> ConfiguredToken<T> {
    pub fn plain(token: T) -> Self {
        Self {
            token,
            style: TokenStyle::default(),
            rules: Vec::new(),
        }
    }

    /// The style for a text value, or `None` when a matching rule hides it.
    /// The first matching rule wins and fills in what it leaves unset from the
    /// token's own style.
    pub fn style_for(&self, value: &str) -> Option<TokenStyle> {
        let mut numeric = None;
        for rule in &self.rules {
            if !rule.matches(value, &mut numeric) {
                continue;
            }
            if rule.hide {
                return None;
            }
            return Some(TokenStyle {
                fg: rule.style.fg.or(self.style.fg),
                bold: rule.style.bold.or(self.style.bold),
                dim: rule.style.dim.or(self.style.dim),
            });
        }
        Some(self.style)
    }
}

impl<'de, T> Deserialize<'de> for ConfiguredToken<T>
where
    T: FromStr<Err = SidebarConfigError>,
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged, deny_unknown_fields)]
        enum Raw {
            Name(String),
            Styled {
                token: String,
                fg: Option<TokenColor>,
                bold: Option<bool>,
                dim: Option<bool>,
                #[serde(default)]
                rules: Vec<TokenRule>,
            },
        }
        let (name, style, rules) = match Raw::deserialize(deserializer)? {
            Raw::Name(name) => (name, TokenStyle::default(), Vec::new()),
            Raw::Styled {
                token,
                fg,
                bold,
                dim,
                rules,
            } => (
                token,
                TokenStyle {
                    fg: fg.map(|color| color.0),
                    bold,
                    dim,
                },
                rules,
            ),
        };
        if rules.len() > MAX_RULES {
            return Err(serde::de::Error::custom(SidebarConfigError::TooManyRules));
        }
        let token = name.parse::<T>().map_err(serde::de::Error::custom)?;
        if !rules.is_empty() && matches!(name.as_str(), "state_icon" | "git_status") {
            return Err(serde::de::Error::custom(
                SidebarConfigError::RulesOnFixedToken,
            ));
        }
        Ok(Self {
            token,
            style,
            rules,
        })
    }
}

fn custom_token(name: &str) -> Result<String, SidebarConfigError> {
    let custom = name
        .strip_prefix('$')
        .ok_or_else(|| SidebarConfigError::UnknownToken(name.to_owned()))?;
    if custom.is_empty()
        || custom.len() > MAX_CUSTOM_TOKEN_LEN
        || !custom
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
    {
        return Err(SidebarConfigError::InvalidCustomToken(name.to_owned()));
    }
    Ok(custom.to_owned())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentToken {
    StateIcon,
    StateText,
    Machine,
    Workspace,
    Tab,
    Pane,
    Agent,
    TerminalTitle,
    TerminalTitleStripped,
    Custom(String),
}

impl FromStr for AgentToken {
    type Err = SidebarConfigError;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        Ok(match name {
            "state_icon" => Self::StateIcon,
            "state_text" => Self::StateText,
            "machine" => Self::Machine,
            "workspace" => Self::Workspace,
            "tab" => Self::Tab,
            "pane" => Self::Pane,
            "agent" => Self::Agent,
            "terminal_title" => Self::TerminalTitle,
            "terminal_title_stripped" => Self::TerminalTitleStripped,
            _ => Self::Custom(custom_token(name)?),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpaceToken {
    StateIcon,
    StateText,
    Workspace,
    Branch,
    GitStatus,
    Custom(String),
}

impl FromStr for SpaceToken {
    type Err = SidebarConfigError;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        Ok(match name {
            "state_icon" => Self::StateIcon,
            "state_text" => Self::StateText,
            "workspace" => Self::Workspace,
            "branch" => Self::Branch,
            "git_status" => Self::GitStatus,
            _ => Self::Custom(custom_token(name)?),
        })
    }
}

/// What a token or rule changes about the default style. `None` leaves the
/// kind's default alone; `Some(false)` removes an emphasis the default has.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenStyle {
    pub fg: Option<u32>,
    pub bold: Option<bool>,
    pub dim: Option<bool>,
}

/// `#RGB` or `#RRGGBB`, as upstream accepts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TokenColor(u32);

impl<'de> Deserialize<'de> for TokenColor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        parse_color(&value)
            .map(Self)
            .ok_or_else(|| serde::de::Error::custom(SidebarConfigError::InvalidColor))
    }
}

fn parse_color(value: &str) -> Option<u32> {
    let hex = value.strip_prefix('#')?;
    if !matches!(hex.len(), 3 | 6) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    gpui::Rgba::try_from(value)
        .ok()
        .map(|color| u32::from(color) >> 8)
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(try_from = "RawRule")]
pub struct TokenRule {
    condition: Condition,
    ignore_case: bool,
    style: TokenStyle,
    hide: bool,
}

// Thresholds are finite by construction, so equality is reflexive.
impl Eq for TokenRule {}

#[derive(Clone, Debug, PartialEq)]
enum Condition {
    Equals(String),
    Contains(String),
    StartsWith(String),
    GreaterThan(f64),
    LessThan(f64),
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawRule {
    equals: Option<String>,
    contains: Option<String>,
    starts_with: Option<String>,
    gt: Option<f64>,
    lt: Option<f64>,
    ignore_case: Option<bool>,
    fg: Option<TokenColor>,
    bold: Option<bool>,
    dim: Option<bool>,
    hide: Option<bool>,
}

impl TryFrom<RawRule> for TokenRule {
    type Error = SidebarConfigError;

    fn try_from(raw: RawRule) -> Result<Self, SidebarConfigError> {
        let mut conditions = [
            raw.equals.map(Condition::Equals),
            raw.contains.map(Condition::Contains),
            raw.starts_with.map(Condition::StartsWith),
            raw.gt.map(Condition::GreaterThan),
            raw.lt.map(Condition::LessThan),
        ]
        .into_iter()
        .flatten();
        let condition = conditions
            .next()
            .ok_or(SidebarConfigError::RuleConditionCount)?;
        if conditions.next().is_some() {
            return Err(SidebarConfigError::RuleConditionCount);
        }
        if let Condition::GreaterThan(value) | Condition::LessThan(value) = &condition {
            if !value.is_finite() {
                return Err(SidebarConfigError::RuleThresholdNotFinite);
            }
            if raw.ignore_case.is_some() {
                return Err(SidebarConfigError::RuleIgnoreCaseOnNumber);
            }
        }
        Ok(Self {
            condition,
            ignore_case: raw.ignore_case.unwrap_or(false),
            style: TokenStyle {
                fg: raw.fg.map(|color| color.0),
                bold: raw.bold,
                dim: raw.dim,
            },
            hide: raw.hide.unwrap_or(false),
        })
    }
}

impl TokenRule {
    /// `numeric` caches the value's parse across the rules of one token.
    fn matches(&self, value: &str, numeric: &mut Option<Option<f64>>) -> bool {
        match &self.condition {
            Condition::Equals(expected) if self.ignore_case => value.eq_ignore_ascii_case(expected),
            Condition::Equals(expected) => value == expected,
            Condition::StartsWith(expected) if self.ignore_case => value
                .as_bytes()
                .get(..expected.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(expected.as_bytes())),
            Condition::StartsWith(expected) => value.starts_with(expected.as_str()),
            Condition::Contains(expected) if self.ignore_case => {
                expected.is_empty()
                    || value
                        .as_bytes()
                        .windows(expected.len())
                        .any(|window| window.eq_ignore_ascii_case(expected.as_bytes()))
            }
            Condition::Contains(expected) => value.contains(expected.as_str()),
            Condition::GreaterThan(threshold) | Condition::LessThan(threshold) => {
                let parsed = numeric.get_or_insert_with(|| {
                    value
                        .parse::<f64>()
                        .ok()
                        .filter(|number| number.is_finite())
                });
                parsed.is_some_and(|number| match self.condition {
                    Condition::GreaterThan(_) => number > *threshold,
                    _ => number < *threshold,
                })
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn layout(text: &str) -> Result<SidebarLayout, toml::de::Error> {
        SidebarLayout::from_daemon_config(&text.parse().unwrap())
    }

    #[test]
    fn rejects_what_upstream_rejects() {
        for text in [
            "rows = [[\"bogus\"]]",
            "rows = [[\"$\"]]",
            "rows = [[\"$has space\"]]",
            &format!("rows = [[\"${}\"]]", "a".repeat(33)),
            &format!("rows = [{}]", "[\"agent\"],".repeat(17)),
            &format!("rows = [[{}]]", "\"agent\",".repeat(17)),
            "rows = [[{ token = \"agent\", fg = \"red\" }]]",
            "rows = [[{ token = \"agent\", size = 2 }]]",
            "rows = [[{ token = \"state_icon\", rules = [{ equals = \"x\" }] }]]",
            "rows = [[{ token = \"agent\", rules = [{ equals = \"x\", contains = \"y\" }] }]]",
            "rows = [[{ token = \"agent\", rules = [{ gt = 1, ignore_case = true }] }]]",
            "rows = [[{ token = \"agent\", rules = [{ gt = inf }] }]]",
            &format!(
                "rows = [[{{ token = \"agent\", rules = [{}] }}]]",
                "{ equals = \"x\" },".repeat(17)
            ),
        ] {
            assert!(
                layout(&format!("[ui.sidebar.agents]\n{text}")).is_err(),
                "accepted: {text}"
            );
        }
        assert!(layout("[ui.sidebar.spaces]\nrows = [[\"agent\"]]").is_err());
        assert!(
            layout("[ui.sidebar.spaces]\nrows = [[{ token = \"git_status\", rules = [{ equals = \"x\" }] }]]")
                .is_err()
        );
    }

    #[test]
    fn rules_match_like_upstream() {
        let rule = |text: &str| -> TokenRule { toml::from_str(text).unwrap() };
        for (condition, yes, no) in [
            ("equals = 'Local'", "Local", "Localhost"),
            ("contains = 'Local'", "myLocalbox", "remote"),
            ("starts_with = 'Local'", "Localhost", "myLocal"),
        ] {
            assert!(rule(condition).matches(yes, &mut None));
            assert!(!rule(condition).matches(no, &mut None));
            assert!(!rule(condition).matches(&yes.to_ascii_lowercase(), &mut None));
            let folded = rule(&format!("{condition}\nignore_case = true"));
            assert!(folded.matches(&yes.to_ascii_lowercase(), &mut None));
        }
        for condition in ["equals", "contains", "starts_with"] {
            let folded = rule(&format!("{condition} = 'ÉA'\nignore_case = true"));
            assert!(folded.matches("Éa", &mut None));
            assert!(!folded.matches("éa", &mut None));
        }
        assert!(rule("contains = ''\nignore_case = true").matches("", &mut None));
        for (condition, yes, no) in [
            ("gt = 80", ["90", "8.1e1", "+90"], "70"),
            ("lt = 80", ["70", "7.9e1", "-90"], "90"),
        ] {
            for value in yes {
                assert!(
                    rule(condition).matches(value, &mut None),
                    "{condition}: {value}"
                );
            }
            for value in [no, "80", "90%", " 90", "", "NaN", "inf", "1e999"] {
                assert!(
                    !rule(condition).matches(value, &mut None),
                    "{condition}: {value}"
                );
            }
        }
    }

    #[test]
    fn first_matching_rule_wins_and_fills_from_the_token_style() {
        let token: ConfiguredToken<AgentToken> = toml::from_str(
            r##"token = "machine"
fg = "#111111"
dim = true
rules = [{ equals = "Local", bold = true }, { starts_with = "L", fg = "#222222" }, { contains = "x", hide = true }]"##,
        )
        .unwrap();
        assert_eq!(
            token.style_for("Local"),
            Some(TokenStyle {
                fg: Some(0x111111),
                bold: Some(true),
                dim: Some(true)
            })
        );
        assert_eq!(token.style_for("Lab").unwrap().fg, Some(0x222222));
        assert_eq!(token.style_for("box"), None);
        assert_eq!(token.style_for("remote"), Some(token.style));
    }

    #[test]
    fn colors_take_both_hex_forms() {
        assert_eq!(parse_color("#abc"), Some(0xaabbcc));
        assert_eq!(parse_color("#A1b2C3"), Some(0xa1b2c3));
        for bad in ["abc", "#ab", "#abcd", "#ggg", "#1234567", "#"] {
            assert_eq!(parse_color(bad), None, "{bad}");
        }
    }
}
