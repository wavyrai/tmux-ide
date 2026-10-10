//! Coder workspace names: 1-32 characters of `[a-z0-9]` in hyphen-separated runs.
//! Coder also accepts uppercase, but lowercase keeps names stable as SSH hosts.

pub(crate) const LIMIT: usize = 32;

pub(crate) fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= LIMIT
        && name.split('-').all(|run| {
            !run.is_empty() && run.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9'))
        })
}

/// Whether `name` can be an existing workspace's name. Coder accepts
/// uppercase in names it did not get from this app, so attaching one must too.
pub(crate) fn existing(name: &str) -> bool {
    valid(&name.to_ascii_lowercase())
}

/// A suggested name for a new workspace: the prefix, then the label slugged.
pub(crate) fn suggest(prefix: &str, label: &str) -> String {
    let mut name = prefix.to_owned();
    let mut pending = true;
    for c in label.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            if pending {
                name.push('-');
                pending = false;
            }
            name.push(c);
        } else {
            pending = true;
        }
        if name.len() >= LIMIT {
            break;
        }
    }
    name.truncate(LIMIT);
    name.trim_end_matches('-').to_owned()
}

/// A fresh name for a new workspace from `cloud::names::random`; always valid.
pub(crate) fn random(prefix: &str) -> String {
    let name = crate::cloud::names::random(prefix, LIMIT);
    if valid(&name) {
        name
    } else {
        suggest(prefix, &name)
    }
}

#[cfg(test)]
mod tests;
