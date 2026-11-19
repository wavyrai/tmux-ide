//! ssh's own one-line reason for a connection that failed, for the user to
//! read: rebuilt only from the forms ssh itself writes, so nothing else the
//! process wrote (the remote command's stderr, a banner) ever comes through.

/// What ssh said, when it said it in one of its own forms.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Said(Option<String>);

/// strerror texts ssh reports for a connect that failed (macOS and Linux).
const CONNECT_ERRORS: [&str; 7] = [
    "No route to host",
    "Connection refused",
    "Network is unreachable",
    "Operation timed out",
    "Connection timed out",
    "Host is down",
    "Connection reset by peer",
];
/// getaddrinfo's texts for a name that does not resolve (macOS and Linux).
const RESOLVE_ERRORS: [&str; 6] = [
    "nodename nor servname provided, or not known",
    "Name or service not known",
    "Temporary failure in name resolution",
    "No address associated with hostname",
    "Name does not resolve",
    "Try again",
];
/// Lines ssh writes whole.
const WHOLE: [&str; 4] = [
    "Host key verification failed.",
    "Connection timed out during banner exchange",
    "kex_exchange_identification: read: Connection reset by peer",
    "kex_exchange_identification: Connection closed by remote host",
];

impl Said {
    /// ssh's reason in `stderr`: a host key failure, else the methods it
    /// tried when authentication was refused, else the last line in one of
    /// ssh's forms.
    pub fn from_stderr(stderr: &[u8]) -> Self {
        let text = String::from_utf8_lossy(stderr);
        let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
        if lines.contains(&WHOLE[0]) {
            return Self(Some(WHOLE[0].into()));
        }
        if let Some(denied) = lines.iter().rev().find_map(|l| permission_denied(l)) {
            return Self(Some(denied));
        }
        // A closed connection is what ssh says last after its reason (a
        // jump host's "open failed"), so it counts only when alone.
        let last = |closed: bool| {
            lines
                .iter()
                .rev()
                .find(|l| ssh_line(l) && closed == is_closed(l))
                .map(|l| (*l).to_owned())
        };
        Self(last(false).or_else(|| last(true)))
    }
    pub fn line(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

fn host(value: &str) -> bool {
    (1..=255).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-%[]".contains(&b))
}
fn port(value: &str) -> bool {
    (1..=5).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
}
/// `<host> port <port>`.
fn host_port(value: &str) -> bool {
    value
        .split_once(" port ")
        .is_some_and(|(h, p)| host(h) && port(p))
}

fn is_closed(line: &str) -> bool {
    line.starts_with("Connection closed by ") || line.starts_with("Connection reset by ")
}

/// Whether `line` is, whole, one of ssh's own failure lines.
fn ssh_line(line: &str) -> bool {
    if WHOLE.contains(&line) {
        return true;
    }
    if let Some(rest) = line.strip_prefix("ssh: connect to host ") {
        return rest
            .split_once(": ")
            .is_some_and(|(at, error)| host_port(at) && CONNECT_ERRORS.contains(&error));
    }
    if let Some(rest) = line.strip_prefix("ssh: Could not resolve hostname ") {
        return rest
            .split_once(": ")
            .is_some_and(|(name, error)| host(name) && RESOLVE_ERRORS.contains(&error));
    }
    if let Some(rest) = line
        .strip_prefix("Connection closed by ")
        .or_else(|| line.strip_prefix("Connection reset by "))
    {
        return host_port(rest);
    }
    if let Some(rest) = line.strip_prefix("channel ") {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        return digits > 0
            && rest[digits..]
                .strip_prefix(": open failed: connect failed: ")
                .is_some_and(|error| CONNECT_ERRORS.contains(&error));
    }
    false
}

/// `[user@host: ]Permission denied (<methods>).`, rebuilt without the user
/// and host and without anything after it.
fn permission_denied(line: &str) -> Option<String> {
    const WORDS: &str = "Permission denied (";
    let at = line.find(WORDS)?;
    if at != 0 && !line[..at].ends_with(": ") {
        return None;
    }
    let rest = &line[at + WORDS.len()..];
    let (methods, _) = rest.split_once(").")?;
    (!methods.is_empty()
        && methods.len() <= 128
        && methods
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b",-".contains(&b)))
    .then(|| format!("{WORDS}{methods})."))
}

#[cfg(test)]
#[path = "said_tests.rs"]
mod tests;
