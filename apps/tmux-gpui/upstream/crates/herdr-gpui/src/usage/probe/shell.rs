//! The remote side of a probe: one `/bin/sh` per host over SSH, holding
//! secrets as shell variables and running requests with `curl` there.
use super::{Held, LIMIT, Method, Output, Part, Request, Response, STEP_TIMEOUT, Secret, quote};
use crate::{Error, Result};
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
};
use std::{
    io::Write,
    process::{Child, ChildStdin},
    sync::mpsc,
    time::{Duration, Instant},
};

#[cfg(unix)]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Helpers defined once per remote session. `herdr_field` prints the string
/// or number at a JSON path from stdin, preferring a real parser and falling
/// back to matching the last key when the host has neither. Remote sessions
/// need an `ssh` child, which only Unix clients start.
#[cfg(unix)]
const PRELUDE: &str = r#"PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
herdr_field() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import json,sys
v=json.load(sys.stdin)
for k in sys.argv[1:]:
    v=v[int(k)] if isinstance(v,list) else v[k]
if isinstance(v,bool): v=str(v).lower()
if v is None or isinstance(v,(dict,list)): sys.exit(1)
sys.stdout.write(str(v))' "$@" 2>/dev/null
    elif command -v jq >/dev/null 2>&1; then
        herdr_path=
        for herdr_key in "$@"; do
            case "$herdr_key" in *[!0-9]*) herdr_path="$herdr_path[\"$herdr_key\"]";; *) herdr_path="$herdr_path[$herdr_key]";; esac
        done
        jq -j "$herdr_path // empty" 2>/dev/null
    else
        for herdr_last in "$@"; do :; done
        sed -n "s/.*\"$herdr_last\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -n 1 | tr -d '\n'
    fi
}
"#;

/// A `/bin/sh` on a remote host, fed one step at a time over SSH stdin. Each
/// step ends with a marker carrying its exit status, so steps can be read
/// back without closing the session.
pub(crate) struct Shell {
    child: Child,
    stdin: ChildStdin,
    output: mpsc::Receiver<std::io::Result<Vec<u8>>>,
    buffer: Vec<u8>,
    variables: usize,
    marker: String,
    macos: Option<bool>,
    broken: bool,
}

impl Drop for Shell {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Shell {
    #[cfg(unix)]
    pub fn connect(target: &str) -> Result<Self> {
        let mut command = herdr_client::script_command(target, "exec /bin/sh -s")?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        Self::start(command)
    }

    #[cfg(windows)]
    pub fn connect(_target: &str) -> Result<Self> {
        Err(Error::UsageUnsupported)
    }

    /// Any `sh` reading steps from stdin; SSH in production, a local shell
    /// in tests.
    #[cfg(unix)]
    pub fn start(mut command: Command) -> Result<Self> {
        let process = |source| Error::UsageProcess {
            operation: "start the remote usage shell",
            source,
        };
        let mut child = command.spawn().map_err(process)?;
        let (Some(stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(process(std::io::Error::other("no pipes")));
        };
        let (sender, output) = mpsc::sync_channel(64);
        let reader = thread::Builder::new()
            .name("herdr-usage-shell".into())
            .spawn(move || {
                let mut chunk = [0; 8192];
                loop {
                    match stdout.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            if sender.send(Ok(chunk[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(error) => {
                            let _ = sender.send(Err(error));
                            break;
                        }
                    }
                }
            });
        if let Err(source) = reader {
            let _ = child.kill();
            let _ = child.wait();
            return Err(process(source));
        }
        let mut shell = Self {
            child,
            stdin,
            output,
            buffer: Vec::new(),
            variables: 0,
            marker: format!("@@herdr-{}", uuid::Uuid::new_v4().simple()),
            macos: None,
            broken: false,
        };
        shell.write(PRELUDE)?;
        let ready = shell.run("true", CONNECT_TIMEOUT)?;
        if !ready.success {
            return Err(Error::UsageUnreachable);
        }
        Ok(shell)
    }

    fn write(&mut self, text: &str) -> Result<()> {
        self.stdin
            .write_all(text.as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|_| {
                self.broken = true;
                Error::UsageUnreachable
            })
    }

    pub(super) fn macos(&mut self) -> bool {
        if self.macos.is_none() {
            self.macos = Some(
                self.run("uname -s", STEP_TIMEOUT)
                    .is_ok_and(|output| output.stdout.trim() == "Darwin"),
            );
        }
        self.macos.unwrap_or(false)
    }

    /// Runs `step` and returns what it printed. A step that overruns breaks
    /// the session, since its output could still arrive later.
    pub fn run(&mut self, step: &str, timeout: Duration) -> Result<Output> {
        if self.broken {
            return Err(Error::UsageUnreachable);
        }
        let marker = self.marker.clone();
        self.write(&format!(
            "{{ {step}\n}} </dev/null; printf '\\n{marker} %s\\n' \"$?\"\n"
        ))?;
        let deadline = Instant::now() + timeout;
        let end = format!("\n{marker} ");
        loop {
            if let Some(start) = find(&self.buffer, end.as_bytes()) {
                let tail = start + end.len();
                if let Some(newline) = self.buffer[tail..].iter().position(|b| *b == b'\n') {
                    let status = String::from_utf8_lossy(&self.buffer[tail..tail + newline])
                        .trim()
                        .parse::<i32>()
                        .unwrap_or(1);
                    let stdout = String::from_utf8_lossy(&self.buffer[..start]).into_owned();
                    self.buffer.drain(..tail + newline + 1);
                    return Ok(Output {
                        success: status == 0,
                        stdout,
                    });
                }
            }
            if self.buffer.len() > LIMIT {
                self.broken = true;
                return Err(Error::UsageSize);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.output.recv_timeout(left) {
                Ok(Ok(chunk)) => self.buffer.extend_from_slice(&chunk),
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.broken = true;
                    return Err(Error::UsageUnreachable);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.broken = true;
                    return Err(Error::UsageTimeout);
                }
            }
        }
    }

    /// Assigns what `producer` prints to a new variable and hands back a
    /// reference to it; None when it printed nothing or failed.
    pub(super) fn capture(&mut self, producer: &str) -> Option<Secret> {
        self.variables += 1;
        let variable = format!("herdr_s{}", self.variables);
        let output = self
            .run(
                &format!("{variable}=$({producer} 2>/dev/null) && [ -n \"${variable}\" ]"),
                STEP_TIMEOUT,
            )
            .ok()?;
        output.success.then(|| Secret(Held::There(variable)))
    }

    /// `curl -K` reads the request from a here-document, so secrets expand
    /// inside the host's shell and never appear in an argument list. `flags`
    /// go before the config and `pipe` after it on the same line, as a
    /// here-document requires.
    fn curl(request: &Request, flags: &str, pipe: &str) -> Option<String> {
        if request.url.contains(['\n', '"']) {
            return None;
        }
        let mut config = format!("url = \"{}\"\n", escape(&request.url));
        if request.method == Method::Post {
            config.push_str("request = \"POST\"\n");
        }
        for (name, parts) in &request.headers {
            config.push_str(&format!(
                "header = \"{}: {}\"\n",
                escape(name),
                splice(parts)?
            ));
        }
        if let Some(body) = &request.body {
            config.push_str(&format!("data-raw = \"{}\"\n", splice(body)?));
        }
        let limit = request.timeout.as_secs().max(1);
        Some(format!(
            "curl -sS --max-time {limit} {flags} -K /dev/fd/3 3<<@@herdr-curl {pipe}\n{config}@@herdr-curl\n"
        ))
    }

    pub(super) fn http(&mut self, request: &Request) -> Result<Response> {
        let curl = Self::curl(request, "-w '\\n@@herdr-status %{http_code}'", "")
            .ok_or(Error::UsageMixedSecrets)?;
        let output = self.run(
            &format!("command -v curl >/dev/null 2>&1 || exit 127\n{curl}"),
            request.timeout + Duration::from_secs(5),
        )?;
        let Some((body, status)) = output.stdout.rsplit_once("\n@@herdr-status ") else {
            return Err(if output.stdout.is_empty() && !output.success {
                Error::UsageMissingCurl
            } else {
                Error::UsageConnect
            });
        };
        Ok(Response {
            status: status.trim().parse().unwrap_or(0),
            body: body.to_owned(),
        })
    }

    pub(super) fn exchange(&mut self, request: &Request, path: &[&str]) -> Result<Secret> {
        let keys = path
            .iter()
            .map(|key| quote(key))
            .collect::<Vec<_>>()
            .join(" ");
        let curl = Self::curl(request, "-f", &format!("| herdr_field {keys}"))
            .ok_or(Error::UsageMixedSecrets)?;
        self.variables += 1;
        let variable = format!("herdr_s{}", self.variables);
        let output = self.run(
            &format!("{variable}=$({curl}) && [ -n \"${variable}\" ]"),
            request.timeout + Duration::from_secs(5),
        )?;
        if output.success {
            Ok(Secret(Held::There(variable)))
        } else {
            Err(Error::UsageRejected)
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Text for a double-quoted curl config value, inside an unquoted
/// here-document: curl's escapes first, then the shell's.
fn escape(text: &str) -> String {
    text.replace('\\', "\\\\\\\\")
        .replace('"', "\\\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`")
        .replace('\n', "\\\\n")
}

fn splice(parts: &[Part]) -> Option<String> {
    let mut text = String::new();
    for part in parts {
        match part {
            Part::Text(value) => text.push_str(&escape(value)),
            Part::Secret(Secret(Held::There(variable))) => {
                text.push_str(&format!("${{{variable}}}"));
            }
            // This machine's secrets never go to the host.
            Part::Secret(Secret(Held::Here(_))) => return None,
        }
    }
    Some(text)
}
