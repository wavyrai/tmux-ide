//! Carry agent sessions between hosts in each agent's own storage format.
//!
//! Every transfer reads the session on the source host, rewrites the source
//! checkout path to the destination's inside it, and writes it where the agent
//! on the destination looks for it. Nothing here asks an agent to summarize:
//! the full history moves.

use super::{
    error::{Error, Result, Step},
    host::{Host, TRANSFER_IDLE, TRANSFER_OUTPUT},
    launch::{AgentKind, claude_project_dir, pi_session_dir, rewrite_paths},
    snapshot::{AgentSession, SessionKind},
};
use herdr_client::{ScriptLimits, shell_quote};
use std::{
    io::{self, Read},
    path::{Component, Path},
    sync::atomic::AtomicBool,
};

const TRANSFER: ScriptLimits = ScriptLimits {
    output: TRANSFER_OUTPUT,
    idle: TRANSFER_IDLE,
};

/// Exit status a source script uses when the session cannot be found.
const MISSING: i32 = 3;

/// Where the session is moving between.
pub(crate) struct Route<'a> {
    pub(crate) source: &'a Host,
    pub(crate) destination: &'a Host,
    /// Source and destination checkout roots, rewritten inside the session.
    pub(crate) from: &'a str,
    pub(crate) to: &'a str,
    /// The destination directory the agent will start in.
    pub(crate) cwd: &'a str,
}

/// Move `session` and return the reference its resume command takes.
pub(crate) fn move_session(
    agent: AgentKind,
    session: &AgentSession,
    route: &Route<'_>,
    cancelled: &AtomicBool,
) -> Result<String> {
    match agent {
        AgentKind::Claude => claude(session, route, cancelled),
        AgentKind::Codex => codex(session, route, cancelled),
        AgentKind::Opencode => opencode(session, route, cancelled),
        AgentKind::Pi | AgentKind::Omp => pi(agent, session, route, cancelled),
        AgentKind::Copilot => copilot(session, route, cancelled),
        // Letta keeps conversations on its server, which the destination
        // reaches with its own login; nothing moves.
        AgentKind::Letta => Ok(session.value.clone()),
        // Their storage is unconfirmed, so `Work::classify` never makes
        // their sessions movable.
        AgentKind::Devin
        | AgentKind::Droid
        | AgentKind::Kimi
        | AgentKind::Mastracode
        | AgentKind::Hermes
        | AgentKind::Qodercli
        | AgentKind::Qwen
        | AgentKind::Kilo
        | AgentKind::Cursor
        | AgentKind::Antigravity
        | AgentKind::Grok => Err(Error::SessionMissing {
            agent: agent.binary(),
        }),
    }
}

/// Session ids are spliced unquoted into source scripts as globs, file
/// names and command arguments; accept only plain id text that no command
/// can read as an option.
fn plain_id(session: &AgentSession) -> Option<&str> {
    let id = session.value.as_str();
    (!id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(id)
}

fn read_source(
    agent: AgentKind,
    route: &Route<'_>,
    body: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    match route.source.run(
        Step::Sessions,
        body,
        io::empty(),
        &mut output,
        TRANSFER,
        cancelled,
    ) {
        Ok(_) => Ok(output),
        Err(Error::Script {
            source: herdr_client::Error::ScriptExit { status, .. },
            ..
        }) if status.code() == Some(MISSING) => Err(Error::SessionMissing {
            agent: agent.binary(),
        }),
        Err(error) => Err(error),
    }
}

fn write_destination(
    route: &Route<'_>,
    body: &str,
    input: &[u8],
    cancelled: &AtomicBool,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    route.destination.run(
        Step::Sessions,
        body,
        input,
        &mut output,
        TRANSFER,
        cancelled,
    )?;
    Ok(output)
}

fn claude(session: &AgentSession, route: &Route<'_>, cancelled: &AtomicBool) -> Result<String> {
    let id = plain_id(session).ok_or(Error::SessionMissing { agent: "claude" })?;
    // The transcript sits in the directory named for the cwd Claude started
    // in, next to an optional directory of subagent transcripts and tool output.
    let read = format!(
        r#"base="${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects"
found=
for f in "$base"/*/{id}.jsonl; do if [ -f "$f" ]; then found=$f; break; fi; done
[ -n "$found" ] || exit {MISSING}
cd -- "$(dirname -- "$found")"
if [ -d {id} ]; then tar -cf - {id}.jsonl {id}; else tar -cf - {id}.jsonl; fi
"#
    );
    let archive = read_source(AgentKind::Claude, route, &read, cancelled)?;
    let archive = rewrite_archive(&archive, route.from, route.to)?;
    let write = format!(
        r#"d="${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects/"{dir}
mkdir -p -- "$d"
tar -xf - -C "$d"
"#,
        dir = shell_quote(&claude_project_dir(route.cwd))
    );
    write_destination(route, &write, &archive, cancelled)?;
    Ok(id.to_owned())
}

fn codex(session: &AgentSession, route: &Route<'_>, cancelled: &AtomicBool) -> Result<String> {
    let id = plain_id(session).ok_or(Error::SessionMissing { agent: "codex" })?;
    // Rollouts live under sessions/YYYY/MM/DD; `codex resume` scans for the id.
    let read = format!(
        r#"base="${{CODEX_HOME:-$HOME/.codex}}/sessions"
f=$(find "$base" -type f -name 'rollout-*-{id}.jsonl' 2>/dev/null | head -n 1)
[ -n "$f" ] || exit {MISSING}
printf '%s\n' "${{f#"$base"/}}"
cat -- "$f"
"#
    );
    let output = read_source(AgentKind::Codex, route, &read, cancelled)?;
    let split = output
        .iter()
        .position(|&b| b == b'\n')
        .ok_or(Error::SessionMissing { agent: "codex" })?;
    let relative = std::str::from_utf8(&output[..split])
        .ok()
        .filter(|path| safe_relative(path))
        .ok_or(Error::SessionMissing { agent: "codex" })?;
    let rollout = rewrite_paths(&output[split + 1..], route.from, route.to);
    let write = format!(
        r#"f="${{CODEX_HOME:-$HOME/.codex}}/sessions/"{relative}
mkdir -p -- "$(dirname -- "$f")"
cat > "$f"
"#,
        relative = shell_quote(relative)
    );
    write_destination(route, &write, &rollout, cancelled)?;
    Ok(id.to_owned())
}

fn opencode(session: &AgentSession, route: &Route<'_>, cancelled: &AtomicBool) -> Result<String> {
    let id = plain_id(session).ok_or(Error::SessionMissing { agent: "opencode" })?;
    // One SQLite database holds every session, so use opencode's own
    // export/import instead of copying storage files.
    let read = format!("opencode export {id} 2>/dev/null || exit {MISSING}\n");
    let exported = read_source(AgentKind::Opencode, route, &read, cancelled)?;
    let exported = rewrite_paths(&exported, route.from, route.to);
    let write = r#"t=$(mktemp "${TMPDIR:-/tmp}/herdr-teleport.XXXXXXXXXX")
trap 'rm -f "$t"' EXIT
cat > "$t"
opencode import "$t" >/dev/null 2>&1
"#;
    write_destination(route, write, &exported, cancelled)?;
    Ok(id.to_owned())
}

fn copilot(session: &AgentSession, route: &Route<'_>, cancelled: &AtomicBool) -> Result<String> {
    let id = plain_id(session).ok_or(Error::SessionMissing { agent: "copilot" })?;
    // Each session is one directory named by its id: the event log, the
    // workspace (with its cwd), checkpoints, and saved files.
    let read = format!(
        r#"cd -- "${{COPILOT_HOME:-$HOME/.copilot}}/session-state" 2>/dev/null || exit {MISSING}
[ -d {id} ] || exit {MISSING}
tar -cf - {id}
"#
    );
    let archive = read_source(AgentKind::Copilot, route, &read, cancelled)?;
    let archive = rewrite_archive(&archive, route.from, route.to)?;
    let write = r#"d="${COPILOT_HOME:-$HOME/.copilot}/session-state"
mkdir -p -- "$d"
tar -xf - -C "$d"
"#;
    write_destination(route, write, &archive, cancelled)?;
    Ok(id.to_owned())
}

fn pi(
    agent: AgentKind,
    session: &AgentSession,
    route: &Route<'_>,
    cancelled: &AtomicBool,
) -> Result<String> {
    let root = match agent {
        AgentKind::Omp => ".omp",
        _ => ".pi",
    };
    // pi reports the session file's path; an id is found by its file name.
    let locate = match session.kind {
        SessionKind::Path => {
            if session.value.chars().any(char::is_control) || !session.value.starts_with('/') {
                return Err(Error::SessionMissing {
                    agent: agent.binary(),
                });
            }
            format!(
                "f={}\n[ -f \"$f\" ] || exit {MISSING}\n",
                shell_quote(&session.value)
            )
        }
        SessionKind::Id => {
            let id = plain_id(session).ok_or(Error::SessionMissing {
                agent: agent.binary(),
            })?;
            format!(
                "f=$(find \"$HOME/{root}\" -type f -name '*{id}*.jsonl' 2>/dev/null | head -n 1)\n\
                 [ -n \"$f\" ] || exit {MISSING}\n"
            )
        }
    };
    let read = format!("{locate}basename -- \"$f\"\ncat -- \"$f\"\n");
    let output = read_source(agent, route, &read, cancelled)?;
    let split = output
        .iter()
        .position(|&b| b == b'\n')
        .ok_or(Error::SessionMissing {
            agent: agent.binary(),
        })?;
    let name = std::str::from_utf8(&output[..split])
        .ok()
        .filter(|name| safe_relative(name) && !name.contains('/'))
        .ok_or(Error::SessionMissing {
            agent: agent.binary(),
        })?;
    let file = rewrite_paths(&output[split + 1..], route.from, route.to);
    let write = format!(
        r#"d="$HOME/{root}/agent/sessions/"{dir}
mkdir -p -- "$d"
cat > "$d/"{name}
printf '%s' "$d/"{name}
"#,
        dir = shell_quote(&pi_session_dir(route.cwd)),
        name = shell_quote(name),
    );
    let path = write_destination(route, &write, &file, cancelled)?;
    String::from_utf8(path).map_err(|_| Error::SessionMissing {
        agent: agent.binary(),
    })
}

/// A relative path of plain components, safe to join under a directory.
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Re-pack a source tar with the checkout path rewritten in its text files.
/// Only regular files and directories with plain relative names survive, so
/// a hostile archive cannot write outside the destination directory.
fn rewrite_archive(archive: &[u8], from: &str, to: &str) -> Result<Vec<u8>> {
    let io_error = |error: io::Error| Error::Script {
        step: Step::Sessions,
        source: herdr_client::Error::ScriptIo(error),
    };
    let mut builder = tar::Builder::new(Vec::new());
    let mut reader = tar::Archive::new(archive);
    for entry in reader.entries().map_err(io_error)? {
        let mut entry = entry.map_err(io_error)?;
        let path = entry.path().map_err(io_error)?.into_owned();
        let Some(name) = path
            .to_str()
            .filter(|name| safe_relative(name.trim_end_matches('/')))
        else {
            continue;
        };
        let name = name.to_owned();
        let kind = entry.header().entry_type();
        let mut header = tar::Header::new_gnu();
        header.set_mode(if kind.is_dir() { 0o700 } else { 0o600 });
        header.set_mtime(entry.header().mtime().unwrap_or(0));
        if kind.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            builder
                .append_data(&mut header, &name, io::empty())
                .map_err(io_error)?;
        } else if kind.is_file() {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(io_error)?;
            let text = [".jsonl", ".json", ".yaml", ".md", ".txt"]
                .iter()
                .any(|extension| name.ends_with(extension));
            let bytes = if text {
                rewrite_paths(&bytes, from, to)
            } else {
                bytes
            };
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(bytes.len() as u64);
            builder
                .append_data(&mut header, &name, bytes.as_slice())
                .map_err(io_error)?;
        }
    }
    builder.into_inner().map_err(io_error)
}

// Host scripts need /bin/sh; Teleport is not offered on other clients.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "sessions_tests.rs"]
mod tests;
