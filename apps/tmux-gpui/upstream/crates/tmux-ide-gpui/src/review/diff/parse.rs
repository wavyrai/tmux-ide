//! `git diff` output, made with `a/` and `b/` prefixes, as files and their
//! numbered lines.
use super::{Body, Kind, Lines, Status};
use std::sync::Arc;

/// One file as the diff gave it. Its names are Git's, decoded but not
/// cleaned: they match the listing's, and are cleaned where they are shown.
#[derive(Debug)]
pub(super) struct Parsed {
    pub path: String,
    pub old_path: Option<String>,
    pub status: Status,
    pub body: Body,
}

/// A path from a `---`/`+++` line, the `diff --git` header or a rename
/// line, without its `a/`/`b/` prefix. Git quotes a name holding a tab,
/// newline, quote, backslash or control character, C-style, and ends an
/// unquoted one holding a space with a tab; both are undone.
pub(super) fn path(text: &str, prefix: &str) -> String {
    let text = text.trim_end_matches('\r');
    let name = match text
        .strip_prefix('"')
        .and_then(|text| text.strip_suffix('"'))
    {
        Some(quoted) => unquote(quoted),
        None => text.strip_suffix('\t').unwrap_or(text).to_owned(),
    };
    match name.strip_prefix(prefix) {
        Some(rest) => rest.to_owned(),
        None => name,
    }
}

/// Git's C-style escapes in a quoted name: `\t`, `\n`, `\"`, `\\`, the
/// other single-letter ones, and a byte as three octal digits.
fn unquote(quoted: &str) -> String {
    let mut bytes = Vec::with_capacity(quoted.len());
    let mut rest = quoted.as_bytes();
    while let [first, tail @ ..] = rest {
        rest = tail;
        if *first != b'\\' {
            bytes.push(*first);
            continue;
        }
        let [escape, tail @ ..] = rest else {
            bytes.push(b'\\');
            break;
        };
        rest = tail;
        let byte = match escape {
            b'a' => 0x07,
            b'b' => 0x08,
            b't' => b'\t',
            b'n' => b'\n',
            b'v' => 0x0b,
            b'f' => 0x0c,
            b'r' => b'\r',
            b'0'..=b'3' => match rest {
                [second @ b'0'..=b'7', third @ b'0'..=b'7', tail @ ..] => {
                    rest = tail;
                    ((escape - b'0') << 6) | ((second - b'0') << 3) | (third - b'0')
                }
                _ => *escape,
            },
            other => *other,
        };
        bytes.push(byte);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The new name in a `diff --git a/old b/new` header, quoted or not.
fn header_name(header: &str) -> String {
    let at = if header.ends_with('"') {
        header.rfind(" \"b/")
    } else {
        header.rfind(" b/")
    };
    path(at.map_or(header, |at| &header[at + 1..]), "b/")
}

/// The starts of `@@ -a,b +c,d @@`: before and after the change.
pub(crate) fn hunk_starts(header: &str) -> Option<(u32, u32)> {
    let mut parts = header.strip_prefix("@@ ")?.split(' ');
    let start = |part: Option<&str>, sign: char| -> Option<u32> {
        part?.strip_prefix(sign)?.split(',').next()?.parse().ok()
    };
    Some((start(parts.next(), '-')?, start(parts.next(), '+')?))
}

/// The file being read, until the next header.
struct Open {
    parsed: Parsed,
    lines: Lines,
    binary: bool,
    /// Where the next lines are numbered from, inside a hunk.
    hunk: Option<(u32, u32)>,
}

impl Open {
    fn close(self) -> Parsed {
        let mut parsed = self.parsed;
        parsed.body = if self.binary {
            Body::Binary
        } else {
            Body::Loaded(Arc::new(self.lines.finish()))
        };
        parsed
    }

    fn line(&mut self, raw: &str) {
        if raw.starts_with("@@ ") {
            self.hunk = hunk_starts(raw);
            self.lines.push(Kind::Hunk, None, None, raw);
            return;
        }
        let Some((old, new)) = self.hunk.as_mut() else {
            self.header(raw);
            return;
        };
        let (kind, text) = match raw.chars().next() {
            Some(' ') => (Kind::Context, &raw[1..]),
            Some('+') => (Kind::Added, &raw[1..]),
            Some('-') => (Kind::Removed, &raw[1..]),
            Some('\\') => (Kind::Meta, raw),
            _ => return,
        };
        let numbers = match kind {
            Kind::Context => (Some(*old), Some(*new)),
            Kind::Added => (None, Some(*new)),
            Kind::Removed => (Some(*old), None),
            _ => (None, None),
        };
        if self.lines.push(kind, numbers.0, numbers.1, text) {
            if numbers.0.is_some() {
                *old = old.saturating_add(1);
            }
            if numbers.1.is_some() {
                *new = new.saturating_add(1);
            }
        }
    }

    /// A line between the `diff --git` header and the first hunk.
    fn header(&mut self, raw: &str) {
        let parsed = &mut self.parsed;
        if let Some(name) = raw.strip_prefix("+++ ") {
            if name != "/dev/null" {
                parsed.path = path(name, "b/");
            }
        } else if raw.starts_with("new file mode") || raw.starts_with("copy from") {
            parsed.status = Status::Added;
        } else if raw.starts_with("deleted file mode") {
            parsed.status = Status::Deleted;
        } else if let Some(from) = raw.strip_prefix("rename from ") {
            parsed.status = Status::Renamed;
            parsed.old_path = Some(path(from, ""));
        } else if raw.starts_with("Binary files") || raw == "GIT binary patch" {
            self.binary = true;
        }
    }
}

/// The files of a diff, in its order.
pub(super) fn parse(text: &str) -> Vec<Parsed> {
    let mut files = Vec::new();
    let mut open: Option<Open> = None;
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        // Inside a hunk every content line starts with a space, `+`, `-` or
        // `\`, so a header line can only start a new file.
        if let Some(header) = raw.strip_prefix("diff --git ") {
            files.extend(open.take().map(Open::close));
            open = Some(Open {
                parsed: Parsed {
                    path: header_name(header),
                    old_path: None,
                    status: Status::Modified,
                    body: Body::Pending,
                },
                lines: Lines::default(),
                binary: false,
                hunk: None,
            });
            continue;
        }
        if let Some(open) = open.as_mut() {
            open.line(raw);
        }
    }
    files.extend(open.map(Open::close));
    files
}
