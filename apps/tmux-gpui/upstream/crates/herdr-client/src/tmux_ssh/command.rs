use super::{Error, RemoteDescriptor};
use std::process::Command;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget(String);
impl SshTarget {
    pub fn parse(value: &str) -> Result<Self, Error> {
        fn name(s: &str) -> bool {
            s.as_bytes()
                .first()
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        }
        let (user, host) = value
            .split_once('@')
            .map_or((None, value), |(u, h)| (Some(u), h));
        let host_valid = name(host)
            || host
                .strip_prefix('[')
                .and_then(|v| v.strip_suffix(']'))
                .is_some_and(|v| {
                    !v.is_empty() && v.bytes().all(|b| b.is_ascii_hexdigit() || b == b':')
                });
        if value.len() > 255 || user.is_some_and(|u| !name(u)) || !host_valid {
            return Err(Error::Target);
        }
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
const DISCOVER: &str = r#"export PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.npm-global/bin"; exec tmux-ide remote-daemon-info --json"#;
/// Read-only remote discovery. No shell profile, installer or daemon bootstrap.
pub fn discovery_command(target: &SshTarget) -> Command {
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ForkAfterAuthentication=no",
        "--",
        target.as_str(),
    ]);
    command.arg(format!("/bin/sh -c {}", shell_quote(DISCOVER)));
    command
}
/// Construction is not connection verification. The future transport must gate
/// credentials on each actual upstream connection, not merely probe this port once.
pub fn tunnel_command(
    target: &SshTarget,
    local_port: u16,
    descriptor: &RemoteDescriptor,
) -> Result<Command, Error> {
    if local_port == 0 {
        return Err(Error::Port);
    }
    let mut command = Command::new("ssh");
    command.args([
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ForkAfterAuthentication=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
    ]);
    command.arg(format!(
        "127.0.0.1:{local_port}:{}",
        descriptor.forward_target()
    ));
    command.args(["--", target.as_str()]);
    Ok(command)
}
#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;

/// `value` as one POSIX shell word.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
