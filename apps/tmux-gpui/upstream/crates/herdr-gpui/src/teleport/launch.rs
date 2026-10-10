//! What each pane runs, and how to run it again on the destination.

use super::snapshot::{AgentSession, Pane, ProcessInfo, SessionKind};

/// Agents Herdr's integrations report resumable sessions for. Resume commands
/// follow Herdr's own (`agent_resume::plan`); whether Teleport can also bring
/// the session to another host is [`AgentKind::carries`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentKind {
    Claude,
    Codex,
    Opencode,
    Pi,
    Omp,
    Copilot,
    Devin,
    Droid,
    Kimi,
    Mastracode,
    Hermes,
    Qodercli,
    Qwen,
    Kilo,
    Cursor,
    Antigravity,
    Grok,
    Letta,
}

/// The longest session id Herdr records.
const MAX_SESSION_ID: usize = 512;
/// The longest session file path Herdr records.
const MAX_SESSION_PATH: usize = 4096;

/// How many arguments follow a flag on an agent's command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arity {
    /// A switch.
    Zero,
    /// Exactly one value, unless given inline with `=`.
    One,
    /// One value when the next argument is not a flag.
    Optional,
    /// Every following argument up to the next flag.
    Many,
}

impl AgentKind {
    /// Every kind, in declaration order.
    pub(crate) const ALL: [Self; 18] = [
        Self::Claude,
        Self::Codex,
        Self::Opencode,
        Self::Pi,
        Self::Omp,
        Self::Copilot,
        Self::Devin,
        Self::Droid,
        Self::Kimi,
        Self::Mastracode,
        Self::Hermes,
        Self::Qodercli,
        Self::Qwen,
        Self::Kilo,
        Self::Cursor,
        Self::Antigravity,
        Self::Grok,
        Self::Letta,
    ];

    /// The kind for the agent name Herdr reports.
    pub(crate) fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "opencode" => Self::Opencode,
            "pi" => Self::Pi,
            "omp" => Self::Omp,
            "copilot" => Self::Copilot,
            "devin" => Self::Devin,
            "droid" => Self::Droid,
            "kimi" => Self::Kimi,
            "mastracode" => Self::Mastracode,
            "hermes" => Self::Hermes,
            "qodercli" => Self::Qodercli,
            "qwen" => Self::Qwen,
            "kilo" => Self::Kilo,
            "cursor" => Self::Cursor,
            "agy" => Self::Antigravity,
            "grok" => Self::Grok,
            "letta" => Self::Letta,
            _ => return None,
        })
    }

    /// The agent name Herdr reports.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
            Self::Omp => "omp",
            Self::Copilot => "copilot",
            Self::Devin => "devin",
            Self::Droid => "droid",
            Self::Kimi => "kimi",
            Self::Mastracode => "mastracode",
            Self::Hermes => "hermes",
            Self::Qodercli => "qodercli",
            Self::Qwen => "qwen",
            Self::Kilo => "kilo",
            Self::Cursor => "cursor",
            Self::Antigravity => "agy",
            Self::Grok => "grok",
            Self::Letta => "letta",
        }
    }

    /// The name of the Herdr integration that reports this agent's sessions.
    fn integration(self) -> &'static str {
        match self {
            Self::Antigravity => "antigravity_cli",
            _ => self.name(),
        }
    }

    /// The program that runs this agent. Teleport hosts are POSIX, so
    /// Cursor's is never Windows' `cursor-agent.cmd`.
    pub(crate) fn binary(self) -> &'static str {
        match self {
            Self::Cursor => "cursor-agent",
            _ => self.name(),
        }
    }

    /// Whether Teleport can bring this agent's session to another host: it
    /// knows where the agent keeps it, or the agent keeps it on a server.
    /// The rest resume through Herdr's own restore on the host that stores
    /// the session; where that storage lives is unconfirmed, so Teleport
    /// starts them afresh instead.
    pub(crate) fn carries(self) -> bool {
        matches!(
            self,
            Self::Claude
                | Self::Codex
                | Self::Opencode
                | Self::Pi
                | Self::Omp
                | Self::Copilot
                | Self::Letta
        )
    }

    /// Whether a reported session reference identifies a session this kind
    /// can resume. Only Herdr's own integrations are trusted to report one,
    /// and only with the reference kinds Herdr's restore accepts.
    fn accepts(self, session: &AgentSession) -> bool {
        session.source.strip_prefix("herdr:") == Some(self.integration())
            && session.agent == self.name()
            && match (self, session.kind) {
                (Self::Pi | Self::Omp, SessionKind::Path) => valid_path(&session.value),
                (_, SessionKind::Id) => self.valid_id(&session.value),
                (_, SessionKind::Path) => false,
            }
    }

    /// Ids are passed as one argument, never through a shell unquoted; they
    /// must still not read as a flag or carry control characters.
    fn valid_id(self, id: &str) -> bool {
        let plain = !id.is_empty()
            && id.len() <= MAX_SESSION_ID
            && !id.starts_with('-')
            && !id.chars().any(char::is_control);
        // Letta's default conversation is named by its agent.
        plain && (self != Self::Letta || id.strip_prefix("default:") != Some(""))
    }

    /// How many values follow `flag` on the original command line. Only
    /// agents whose flags are known keep any; the rest resume with none,
    /// as Herdr's restore does.
    fn arity(self, flag: &str) -> Option<Arity> {
        let one: &[&str] = match self {
            Self::Claude => &[
                "--model",
                "--permission-mode",
                "--add-dir",
                "--allowedTools",
                "--allowed-tools",
                "--disallowedTools",
                "--disallowed-tools",
                "--mcp-config",
                "--settings",
                "--append-system-prompt",
                "--system-prompt",
                "--agent",
                "--effort",
                "--fallback-model",
            ],
            Self::Codex => &[
                "-m",
                "--model",
                "-c",
                "--config",
                "-s",
                "--sandbox",
                "-a",
                "--ask-for-approval",
                "-p",
                "--profile",
                "--add-dir",
            ],
            Self::Opencode => &["-m", "--model", "--agent"],
            Self::Pi | Self::Omp => &["--model", "--provider", "--thinking"],
            // From `copilot --help` (1.0.8).
            Self::Copilot => &[
                "--add-dir",
                "--add-github-mcp-tool",
                "--add-github-mcp-toolset",
                "--additional-mcp-config",
                "--agent",
                "--disable-mcp-server",
                "--log-level",
                "--max-autopilot-continues",
                "--model",
                "--plugin-dir",
                "--reasoning-effort",
                "--stream",
            ],
            _ => &[],
        };
        let (optional, many): (&[&str], &[&str]) = match self {
            Self::Copilot => (
                &["--alt-screen", "--bash-env", "--mouse"],
                &[
                    "--allow-tool",
                    "--allow-url",
                    "--available-tools",
                    "--deny-tool",
                    "--deny-url",
                    "--excluded-tools",
                    "--secret-env-vars",
                ],
            ),
            _ => (&[], &[]),
        };
        if one.contains(&flag) {
            Some(Arity::One)
        } else if optional.contains(&flag) {
            Some(Arity::Optional)
        } else if many.contains(&flag) {
            Some(Arity::Many)
        } else if self.keeps_flags() {
            Some(Arity::Zero)
        } else {
            None
        }
    }

    fn keeps_flags(self) -> bool {
        matches!(
            self,
            Self::Claude | Self::Codex | Self::Opencode | Self::Pi | Self::Omp | Self::Copilot
        )
    }

    /// Flags naming a session, a working directory, or a one-shot mode, with
    /// the values they take; the resume command supplies its own.
    fn replaced(self, flag: &str) -> Option<Arity> {
        let (one, zero, optional): (&[&str], &[&str], &[&str]) = match self {
            Self::Claude => (
                &["--resume", "-r", "--session-id", "--fork-session"],
                &["--continue", "-c", "--print", "-p"],
                &[],
            ),
            Self::Codex => (&["-C", "--cd"], &[], &[]),
            Self::Opencode => (
                &["-s", "--session", "--port", "--hostname"],
                &["-c", "--continue", "--fork"],
                &[],
            ),
            Self::Pi | Self::Omp => (
                &["--session", "--resume", "-r", "--fork", "--session-dir"],
                &["-c", "--continue", "--no-session"],
                &[],
            ),
            Self::Copilot => (
                &[
                    "-i",
                    "--interactive",
                    "-p",
                    "--prompt",
                    "--config-dir",
                    "--log-dir",
                    "--output-format",
                ],
                &["--continue", "--acp", "-s", "--silent", "--share-gist"],
                &["--resume", "--share"],
            ),
            _ => (&[], &[], &[]),
        };
        if one.contains(&flag) {
            Some(Arity::One)
        } else if zero.contains(&flag) {
            Some(Arity::Zero)
        } else if optional.contains(&flag) {
            Some(Arity::Optional)
        } else {
            None
        }
    }

    /// The flags of an agent's original command line worth keeping: model
    /// and permission choices. Positionals are dropped, because they are an
    /// initial prompt or project directory that must not be replayed.
    pub(crate) fn kept_flags(self, argv: &[String]) -> Vec<String> {
        let mut kept = Vec::new();
        let mut args = argv.iter().skip(1).peekable();
        while let Some(arg) = args.next() {
            if !arg.starts_with('-') {
                continue;
            }
            let (name, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), false), |(name, _)| (name, true));
            let (keep, arity) = match self.replaced(name) {
                Some(arity) => (false, arity),
                None => match self.arity(name) {
                    Some(arity) => (true, arity),
                    None => continue,
                },
            };
            let mut values = Vec::new();
            if !inline {
                match arity {
                    Arity::Zero => {}
                    Arity::One => match args.next() {
                        Some(value) => values.push(value),
                        // A flag missing its value is not worth replaying.
                        None => continue,
                    },
                    Arity::Optional => values.extend(args.next_if(|next| !next.starts_with('-'))),
                    Arity::Many => {
                        while let Some(value) = args.next_if(|next| !next.starts_with('-')) {
                            values.push(value);
                        }
                    }
                }
            }
            if keep {
                kept.push(arg.clone());
                kept.extend(values.into_iter().cloned());
            }
        }
        kept
    }

    /// The command that reopens `reference` (an id, or the session file's
    /// destination path), with `flags` from the original command line.
    pub(crate) fn resume_argv(self, reference: &str, flags: &[String]) -> Vec<String> {
        let mut argv = vec![self.binary().to_owned()];
        let mut flag = |flag: &str| argv.extend([flag.to_owned(), reference.to_owned()]);
        match self {
            Self::Claude
            | Self::Devin
            | Self::Droid
            | Self::Hermes
            | Self::Qodercli
            | Self::Qwen
            | Self::Cursor
            | Self::Grok => flag("--resume"),
            Self::Opencode | Self::Pi | Self::Kimi | Self::Kilo => flag("--session"),
            Self::Mastracode => flag("--thread"),
            Self::Antigravity => flag("--conversation"),
            Self::Codex => argv.extend(["resume".to_owned(), reference.to_owned()]),
            // Their resume flags take an optional value, so it must be inline.
            Self::Copilot | Self::Omp => argv.push(format!("--resume={reference}")),
            Self::Letta => match reference.strip_prefix("default:") {
                Some(agent) => {
                    argv.extend(["--conversation", "default", "--agent", agent].map(str::to_owned))
                }
                None => flag("--conversation"),
            },
        }
        argv.extend(flags.iter().cloned());
        argv
    }
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= MAX_SESSION_PATH && !path.chars().any(char::is_control)
}

/// What a source pane is doing, and so what its destination pane will do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Work {
    /// An idle shell prompt; the new pane's shell is enough.
    Shell,
    /// A supported agent with a resumable session.
    Session {
        agent: AgentKind,
        session: AgentSession,
        flags: Vec<String>,
    },
    /// A detected agent without a session Teleport can move. `argv` starts
    /// the same agent afresh; a handoff note carries its context.
    Agent { name: String, argv: Vec<String> },
    /// Any other foreground program, run again with the same arguments.
    Command(Vec<String>),
}

impl Work {
    pub(crate) fn classify(pane: &Pane, process: &ProcessInfo) -> Self {
        let job = process.foreground_job();
        let argv = job.map(|job| job.argv.clone()).unwrap_or_default();
        if let Some(session) = &pane.agent_session
            && let Some(agent) = AgentKind::parse(&session.agent)
            && agent.carries()
            && agent.accepts(session)
        {
            return Self::Session {
                agent,
                session: session.clone(),
                flags: agent.kept_flags(&argv),
            };
        }
        if let Some(name) = pane.agent.as_ref().filter(|name| !name.is_empty()) {
            let argv = if argv.is_empty() {
                vec![name.clone()]
            } else {
                argv
            };
            return Self::Agent {
                name: name.clone(),
                argv,
            };
        }
        if argv.is_empty() {
            Self::Shell
        } else {
            Self::Command(argv)
        }
    }

    /// The program the destination must have, if any.
    pub(crate) fn program(&self) -> Option<&str> {
        match self {
            Self::Shell => None,
            Self::Session { agent, .. } => Some(agent.binary()),
            Self::Agent { argv, .. } | Self::Command(argv) => argv.first().map(|p| basename(p)),
        }
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `path` moved from under `from` to under `to`, if it lies under `from`.
pub(crate) fn remap(path: &str, from: &str, to: &str) -> Option<String> {
    let from = from.trim_end_matches('/');
    let rest = path.strip_prefix(from)?;
    (rest.is_empty() || rest.starts_with('/'))
        .then(|| format!("{}{rest}", to.trim_end_matches('/')))
}

/// Replace every occurrence of the checkout path `from` in `text`, where the
/// match ends at a path boundary (so `/w/feat` never rewrites `/w/feature`).
pub(crate) fn rewrite_paths(text: &[u8], from: &str, to: &str) -> Vec<u8> {
    let from = from.trim_end_matches('/').as_bytes();
    let to = to.trim_end_matches('/').as_bytes();
    if from.is_empty() || from == to {
        return text.to_vec();
    }
    let mut out = Vec::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        if text[index..].starts_with(from) {
            let next = text.get(index + from.len()).copied();
            let boundary = !next.is_some_and(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
            if boundary {
                out.extend_from_slice(to);
                index += from.len();
                continue;
            }
        }
        out.push(text[index]);
        index += 1;
    }
    out
}

/// A command line re-targeted at the destination: paths under the source
/// checkout move with it, and an absolute program outside the checkout is
/// found on the destination's `PATH` instead.
pub(crate) fn remap_argv(argv: &[String], from: &str, to: &str) -> Vec<String> {
    argv.iter()
        .enumerate()
        .map(|(index, arg)| {
            let moved =
                String::from_utf8_lossy(&rewrite_paths(arg.as_bytes(), from, to)).into_owned();
            if index == 0 && moved.starts_with('/') && remap(arg, from, to).is_none() {
                basename(&moved).to_owned()
            } else {
                moved
            }
        })
        .collect()
}

/// One POSIX shell command line for `argv`.
pub(crate) fn command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| {
            if !arg.is_empty()
                && arg
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_./=:,+@%".contains(&b))
            {
                arg.clone()
            } else {
                herdr_client::shell_quote(arg)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Claude Code's project directory name for `cwd`: every character that is
/// not an ASCII letter or digit becomes `-`, and names over 200 characters are
/// cut and suffixed with a base-36 hash of the full path.
pub(crate) fn claude_project_dir(cwd: &str) -> String {
    const LIMIT: usize = 200;
    let name: String = cwd
        .encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    if name.len() <= LIMIT {
        return name;
    }
    // Java-style string hash over UTF-16 units, as JavaScript computes it.
    let hash = cwd.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit))
    });
    format!(
        "{}-{}",
        &name[..LIMIT],
        base36(i64::from(hash).unsigned_abs())
    )
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

/// pi's session directory name for `cwd`.
pub(crate) fn pi_session_dir(cwd: &str) -> String {
    let trimmed = cwd.strip_prefix(['/', '\\']).unwrap_or(cwd);
    format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

/// Where the agent in the `index`th handed-off pane writes its note, relative
/// to the checkout. The note is an untracked file, so it travels with the
/// uncommitted changes.
pub(crate) fn handoff_path(index: usize) -> String {
    format!(".herdr/teleport/handoff-{}.md", index + 1)
}

/// The prompt that asks an agent to leave its context behind in the checkout.
pub(crate) fn handoff_prompt(path: &str) -> String {
    format!(
        "This work is moving to another machine. Write a handoff note to {path} \
         (create the directory) so another agent can continue seamlessly: the goal, what is \
         done, the current state including uncommitted changes, decisions and constraints, \
         open questions, and the exact next steps. Do not change anything else, then stop."
    )
}

pub(crate) fn handoff_resume_prompt(path: &str) -> String {
    format!("Read {path} and continue the work it describes.")
}

impl AgentKind {
    /// Whether [`AgentKind::start_argv`] knows how to give this agent a
    /// first prompt, so it can continue from a handoff note.
    pub(crate) fn takes_prompt(self) -> bool {
        matches!(
            self,
            Self::Claude | Self::Codex | Self::Opencode | Self::Pi | Self::Omp | Self::Copilot
        )
    }

    /// The command that starts this agent afresh, optionally with a first
    /// prompt when it [takes one](AgentKind::takes_prompt).
    pub(crate) fn start_argv(self, prompt: Option<&str>) -> Vec<String> {
        let mut argv = vec![self.binary().to_owned()];
        if let Some(prompt) = prompt.filter(|_| self.takes_prompt()) {
            match self {
                Self::Opencode => argv.push("--prompt".to_owned()),
                // Copilot's `-p` runs the prompt and exits.
                Self::Copilot => argv.push("-i".to_owned()),
                _ => {}
            }
            argv.push(prompt.to_owned());
        }
        argv
    }

    /// Agents a handoff may fall back to, most capable first.
    pub(crate) const FALLBACKS: [Self; 4] = [Self::Claude, Self::Codex, Self::Opencode, Self::Pi];
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
