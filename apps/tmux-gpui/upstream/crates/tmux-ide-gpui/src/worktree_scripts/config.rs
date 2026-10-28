//! A repository's `.herdr/worktree.toml`, read from a checkout on the
//! endpoint's host.
//!
//! The file is repository content, so it is untrusted data: reading and
//! parsing it never runs anything. Its digest is what the user trusts.

use super::ScriptKind;
use herdr_client::{ConnectTarget, ScriptHost, ScriptLimits, run_script, shell_quote};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    path::Path,
    sync::atomic::AtomicBool,
    time::Duration,
};

/// Where the scripts live, relative to a checkout.
pub(crate) const PATH: &str = ".herdr/worktree.toml";
/// Larger files are refused rather than truncated.
pub(crate) const MAX_BYTES: u64 = 64 * 1024;
/// What the remote reader prints before the file, so an empty file is told
/// apart from a missing one.
const PRESENT: &[u8] = b"present\n";
const REMOTE_IDLE: Duration = Duration::from_secs(30);

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    scripts: Scripts,
}

/// The `[scripts]` table. Unknown keys are refused, so a misspelled script
/// is reported instead of silently never running.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Scripts {
    setup: Option<String>,
    run: Option<String>,
    archive: Option<String>,
}

impl Scripts {
    /// The script for `kind`, when it has anything to run.
    pub(crate) fn get(&self, kind: ScriptKind) -> Option<&str> {
        match kind {
            ScriptKind::Setup => self.setup.as_deref(),
            ScriptKind::Run => self.run.as_deref(),
            ScriptKind::Archive => self.archive.as_deref(),
        }
        .filter(|script| !script.trim().is_empty())
    }
}

/// A parsed file and the digest trust is granted to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Config {
    pub(crate) scripts: Scripts,
    /// SHA-256 of the file's bytes, in lowercase hex.
    pub(crate) digest: String,
}

impl Config {
    pub(crate) fn parse(bytes: &[u8]) -> crate::Result<Self> {
        if bytes.len() as u64 > MAX_BYTES {
            return Err(crate::Error::WorktreeScriptsSize { limit: MAX_BYTES });
        }
        let text = std::str::from_utf8(bytes).map_err(crate::Error::WorktreeScriptsEncoding)?;
        let file: File = toml::from_str(text).map_err(crate::Error::WorktreeScriptsParse)?;
        // Scripts travel to the pane as environment values, which cannot hold NUL.
        if [ScriptKind::Setup, ScriptKind::Run, ScriptKind::Archive]
            .into_iter()
            .filter_map(|kind| file.scripts.get(kind))
            .any(|script| script.contains('\0'))
        {
            return Err(crate::Error::WorktreeScriptsNul);
        }
        let digest = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Self {
            scripts: file.scripts,
            digest,
        })
    }
}

/// Read and parse the file in `checkout` on `target`'s host. `None` when the
/// repository has none. Blocking: call only on a background executor.
///
/// Local, named-session, and socket endpoints share this machine's files; an
/// SSH endpoint's checkout is read with `cat` over the endpoint's SSH policy.
/// A WSL distribution or a cloud machine has no script host here yet, so it
/// is refused rather than guessed at.
pub(crate) fn read(
    target: &ConnectTarget,
    checkout: &str,
    cancelled: &AtomicBool,
) -> crate::Result<Option<Config>> {
    let bytes = match target {
        ConnectTarget::Ssh { target, .. } => read_remote(target, checkout, cancelled)?,
        ConnectTarget::Local | ConnectTarget::Session { .. } | ConnectTarget::Socket(_) => {
            read_local(&Path::new(checkout).join(PATH))?
        }
        ConnectTarget::Wsl { .. } => return Err(crate::Error::WorktreeScriptsUnsupportedHost),
        #[cfg(feature = "cloud")]
        ConnectTarget::Cloud { .. } => return Err(crate::Error::WorktreeScriptsUnsupportedHost),
    };
    bytes.as_deref().map(Config::parse).transpose()
}

fn read_local(path: &Path) -> crate::Result<Option<Vec<u8>>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(crate::Error::WorktreeScriptsRead(error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(crate::Error::WorktreeScriptsRead)?;
    Ok(Some(bytes))
}

fn read_remote(
    target: &str,
    checkout: &str,
    cancelled: &AtomicBool,
) -> crate::Result<Option<Vec<u8>>> {
    let path = format!("{}/{PATH}", checkout.trim_end_matches('/'));
    let body = format!(
        "p={}\nif [ -f \"$p\" ]; then printf 'present\\n'; cat -- \"$p\"; fi\n",
        shell_quote(&path)
    );
    let mut output = Vec::new();
    run_script(
        ScriptHost::Ssh(target),
        &body,
        io::empty(),
        &mut output,
        ScriptLimits {
            // One byte past the limit, so an oversized file is reported as such.
            output: PRESENT.len() as u64 + MAX_BYTES + 1,
            idle: REMOTE_IDLE,
        },
        cancelled,
    )
    .map_err(crate::Error::WorktreeScriptsRemote)?;
    Ok(remote_bytes(output))
}

/// The file's bytes from the remote reader's output, `None` when it was absent.
fn remote_bytes(mut output: Vec<u8>) -> Option<Vec<u8>> {
    output.starts_with(PRESENT).then(|| {
        output.drain(..PRESENT.len());
        output
    })
}

#[cfg(test)]
mod tests;
