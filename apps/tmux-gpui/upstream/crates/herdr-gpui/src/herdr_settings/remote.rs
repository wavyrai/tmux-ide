//! Herdr's `experimental.pane_history` on an SSH host. That host's daemon owns
//! its panes and reads its own `config.toml`, so the switch is a read-modify-
//! write of the remote file over one-shot scripts. Blocking: call only from a
//! background worker.

use super::{Error, Experimental, set};
use herdr_client::{ScriptHost, ScriptLimits, run_script, shell_quote};
use serde::Deserialize;
use std::{sync::atomic::AtomicBool, time::Duration};
use toml_edit::DocumentMut;

/// A remote edit embeds no file in a command line, but the whole file still
/// crosses SSH twice per save. Real configs are a few KiB.
const LIMIT: u64 = 64 * 1024;
const PRESENT: &str = "herdr-config:present\n";
const UNSAFE_EXIT: i32 = 65;
const CONFLICT_EXIT: i32 = 75;
const LIMITS: ScriptLimits = ScriptLimits {
    output: LIMIT + PRESENT.len() as u64,
    idle: Duration::from_secs(20),
};

/// The path Herdr's release build reads, as the SSH login environment
/// resolves it, matching the local `daemon_config_path`. A daemon started with
/// a different `HERDR_CONFIG_PATH` than SSH sessions get is not reachable.
const PATH: &str =
    r#"path=${HERDR_CONFIG_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml}"#;

/// One host's config as last read. Saving fails with `RemoteConflict` unless
/// the file still holds exactly this text.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct RemotePaneHistory {
    text: Option<String>,
    pub enabled: bool,
}

impl std::fmt::Debug for RemotePaneHistory {
    // The file may hold private settings unrelated to this switch.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemotePaneHistory")
            .field("exists", &self.text.is_some())
            .field("enabled", &self.enabled)
            .finish()
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Parsed {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    experimental: Experimental,
}

impl RemotePaneHistory {
    #[cfg(test)]
    pub(crate) fn parse_text(text: Option<String>) -> Result<Self, Error> {
        Self::parse(text)
    }

    fn parse(text: Option<String>) -> Result<Self, Error> {
        let parsed: Parsed = toml::from_str(text.as_deref().unwrap_or(""))?;
        Ok(Self {
            text,
            enabled: parsed.experimental.pane_history,
        })
    }

    pub(crate) fn load(host: ScriptHost<'_>, cancelled: &AtomicBool) -> crate::Result<Self> {
        Self::read(host, "", cancelled).map_err(crate::Error::from)
    }

    /// Writes the edit, then reads the file back, so the result is what the
    /// daemon will see on its next config reload.
    pub(crate) fn save(
        &self,
        host: ScriptHost<'_>,
        enabled: bool,
        cancelled: &AtomicBool,
    ) -> crate::Result<Self> {
        self.save_with(host, "", enabled, cancelled)
            .map_err(crate::Error::from)
    }

    /// `prefix` runs before each script; tests use it to point the scripts
    /// at a private path.
    fn save_with(
        &self,
        host: ScriptHost<'_>,
        prefix: &str,
        enabled: bool,
        cancelled: &AtomicBool,
    ) -> Result<Self, Error> {
        let mut document = self.text.as_deref().unwrap_or("").parse::<DocumentMut>()?;
        set(
            &mut document,
            &["experimental", "pane_history"],
            enabled.into(),
        )?;
        let text = document.to_string();
        if text.len() as u64 > LIMIT {
            return Err(Error::RemoteTooLarge);
        }
        let expected = self.text.as_deref().unwrap_or("");
        let mut input = Vec::with_capacity(expected.len() + text.len());
        input.extend_from_slice(expected.as_bytes());
        input.extend_from_slice(text.as_bytes());
        let script = write_script(self.text.as_ref().map(String::len));
        run(host, &format!("{prefix}{script}"), &input, cancelled)?;
        Self::read(host, prefix, cancelled)
    }

    fn read(host: ScriptHost<'_>, prefix: &str, cancelled: &AtomicBool) -> Result<Self, Error> {
        let script = format!("{prefix}{}", read_script());
        let output = run(host, &script, &[], cancelled)?;
        let text = match output.strip_prefix(PRESENT.as_bytes()) {
            Some(text) => Some(String::from_utf8(text.to_vec()).map_err(Error::RemoteUtf8)?),
            None if output.is_empty() => None,
            None => return Err(Error::RemoteOutput),
        };
        Self::parse(text)
    }
}

fn run(
    host: ScriptHost<'_>,
    script: &str,
    input: &[u8],
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, Error> {
    let mut output = Vec::new();
    match run_script(host, script, input, &mut output, LIMITS, cancelled) {
        Ok(_) => Ok(output),
        Err(herdr_client::Error::ScriptOutputLimit) => Err(Error::RemoteTooLarge),
        Err(herdr_client::Error::ScriptExit { status, .. })
            if status.code() == Some(CONFLICT_EXIT) =>
        {
            Err(Error::RemoteConflict)
        }
        Err(herdr_client::Error::ScriptExit { status, .. })
            if status.code() == Some(UNSAFE_EXIT) =>
        {
            Err(Error::RemoteUnsafePath)
        }
        Err(error) => Err(Error::Remote(error)),
    }
}

/// Prints nothing for a missing file, else a marker and the file. Symlinks and
/// non-regular files are refused, as the local editor refuses them.
fn read_script() -> String {
    format!(
        r#"{PATH}
if [ -L "$path" ]; then exit {UNSAFE_EXIT}; fi
if [ ! -e "$path" ]; then exit 0; fi
if [ ! -f "$path" ]; then exit {UNSAFE_EXIT}; fi
printf '%s' {present}
exec cat "$path""#,
        present = shell_quote(PRESENT),
    )
}

/// Stdin holds the expected current text (`expected` bytes, `None` for no
/// file) followed by the replacement. The replacement goes to a private
/// temporary file beside the config and is renamed over it only while the
/// config still holds the expected text. Another writer can still slip in
/// between that comparison and the rename; Herdr itself takes no lock to honor.
fn write_script(expected: Option<usize>) -> String {
    let check = match expected {
        None => format!(
            r#"if [ -e "$path" ] || [ -L "$path" ]; then exit {CONFLICT_EXIT}; fi
mv -f -- "$tmp" "$tmp.new" || exit 1"#
        ),
        Some(0) => format!(
            r#"if [ ! -f "$path" ] || [ -s "$path" ]; then exit {CONFLICT_EXIT}; fi
mv -f -- "$tmp" "$tmp.new" || exit 1"#
        ),
        // dd on a regular file reads whole blocks, so one block of exactly the
        // expected length splits the input without a byte-at-a-time copy.
        Some(length) => format!(
            r#"dd if="$tmp" of="$tmp.old" bs={length} count=1 2>/dev/null || exit 1
dd if="$tmp" of="$tmp.new" bs={length} skip=1 2>/dev/null || exit 1
if [ ! -f "$path" ] || ! cmp -s "$tmp.old" "$path"; then exit {CONFLICT_EXIT}; fi"#
        ),
    };
    format!(
        r#"umask 077
{PATH}
if [ -L "$path" ]; then exit {UNSAFE_EXIT}; fi
if [ -e "$path" ] && [ ! -f "$path" ]; then exit {UNSAFE_EXIT}; fi
dir=$(dirname -- "$path") || exit 1
mkdir -p -- "$dir" || exit 1
tmp=$(mktemp "$dir/.config.toml.XXXXXX") || exit 1
trap 'rm -f -- "$tmp" "$tmp.old" "$tmp.new"' EXIT
cat > "$tmp" || exit 1
{check}
mv -f -- "$tmp.new" "$path" || exit 1"#
    )
}

// The scripts run under the local `/bin/sh`, which `run_script` drives only on
// Linux and macOS.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests;
