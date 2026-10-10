//! Recent pull requests and issues for one repository, and the branch each one
//! seeds. Remote text is untrusted: titles and branch names are cleaned and
//! length-bounded before they can reach a label or a daemon request.

use super::Origin;
use crate::{Error, pull_request::clean};
use serde_json::Value;

/// Items per list. The tabs are a picker, not a mirror of the repository, so a
/// query stays inside one page and one bounded response.
pub(super) const LIMIT: usize = 50;
/// Issue branches follow GitHub's own "create a branch" naming. The slug is
/// bounded so a long title cannot produce an unusable checkout directory.
const SLUG_LIMIT: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    PullRequest,
    Issue,
}

impl Kind {
    pub(crate) fn tab_label(self) -> &'static str {
        match self {
            Self::PullRequest => "PR",
            Self::Issue => "issues",
        }
    }

    pub(crate) fn empty_label(self) -> &'static str {
        match self {
            Self::PullRequest => "No open pull requests match.",
            Self::Issue => "No open issues match.",
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::PullRequest => "pullRequests",
            Self::Issue => "issues",
        }
    }
}

/// One listed pull request or issue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Item {
    pub kind: Kind,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    /// A pull request's head branch. An issue has none until one is created.
    pub head: Option<String>,
    /// Set when the head branch lives in a fork, naming its owner.
    pub fork_owner: Option<String>,
    pub draft: bool,
}

impl Item {
    /// The branch a new checkout for this item uses: a pull request's existing
    /// head branch, or the branch an issue's number and title name.
    pub(crate) fn branch(&self) -> String {
        match &self.head {
            Some(_) if self.fork_owner.is_some() => fork_branch(self.number),
            Some(head) => head.clone(),
            None => issue_branch(self.number, &self.title),
        }
    }

    /// Fork heads use GitHub's PR ref, isolated from origin's branch namespace.
    pub(crate) fn base_ref(&self) -> String {
        if self.fork_owner.is_some() {
            format!("refs/herdr/pull/{}/head", self.number)
        } else {
            format!("refs/remotes/origin/{}", self.branch())
        }
    }

    pub(super) fn fetch_refspec(&self) -> String {
        let source = if self.fork_owner.is_some() {
            format!("refs/pull/{}/head", self.number)
        } else {
            format!("refs/heads/{}", self.branch())
        };
        format!("+{source}:{}", self.base_ref())
    }

    /// What the picker's search matches against, lowercased once per item.
    pub(crate) fn search_key(&self) -> String {
        format!("#{} {} {}", self.number, self.title, self.author).to_lowercase()
    }

    pub(crate) fn label(&self) -> String {
        format!("#{} {}", self.number, self.title)
    }
}

/// The local branch a fork's pull request is checked out on. Its head branch
/// lives in another repository, so the name carries the number instead, and
/// no upstream is configured for it.
pub(crate) fn fork_branch(number: u64) -> String {
    format!("pr/{number}")
}

/// The pull request number a [`fork_branch`] name carries, if it is one.
pub(crate) fn fork_branch_number(branch: &str) -> Option<u64> {
    let digits = branch.strip_prefix("pr/")?;
    if digits.starts_with('0') || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// GitHub's branch name for an issue: the number, then a slug of the title.
pub(crate) fn issue_branch(number: u64, title: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
        if slug.len() >= SLUG_LIMIT {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        number.to_string()
    } else {
        format!("{number}-{slug}")
    }
}

/// Read one list out of a GraphQL response. A repository the token cannot see
/// comes back as a null node rather than an error, so absence is rejected here.
pub(super) fn parse(response: &Value, origin: &Origin, kind: Kind) -> crate::Result<Vec<Item>> {
    let nodes = response["data"]["repository"][kind.field()]["nodes"]
        .as_array()
        .ok_or(Error::PrRepository)?;
    Ok(nodes
        .iter()
        .take(LIMIT)
        .filter_map(|node| item(node, origin, kind))
        .collect())
}

fn item(node: &Value, origin: &Origin, kind: Kind) -> Option<Item> {
    let number = node["number"].as_u64().filter(|number| *number > 0)?;
    // A pull request without a usable head ref cannot seed a checkout, so it is
    // dropped rather than listed as a row that can only fail.
    let head = match kind {
        Kind::PullRequest => Some(branch_name(node["headRefName"].as_str()?)?),
        Kind::Issue => None,
    };
    let fork_owner = head.as_ref().and_then(|_| {
        let login = clean(
            node["headRepositoryOwner"]["login"]
                .as_str()
                .unwrap_or_default(),
        );
        (!login.eq_ignore_ascii_case(&origin.owner)).then_some(login)
    });
    Some(Item {
        kind,
        number,
        title: clean(node["title"].as_str().unwrap_or_default()),
        // Rebuilt from the repository that was asked for, so a response can
        // never point a row at another repository.
        url: format!(
            "https://github.com/{}/{}/{}/{number}",
            origin.owner,
            origin.repo,
            match kind {
                Kind::PullRequest => "pull",
                Kind::Issue => "issues",
            }
        ),
        author: clean(node["author"]["login"].as_str().unwrap_or_default()),
        head,
        fork_owner,
        draft: node["isDraft"] == true,
    })
}

/// A remote branch name this client is willing to put in a daemon request.
/// Git already forbids these shapes, so anything else is a hostile response.
pub(super) fn branch_name(value: &str) -> Option<String> {
    let name = value.trim();
    (!name.is_empty()
        && name.len() <= 255
        && !name.chars().any(|ch| ch.is_whitespace() || ch.is_control())
        && !name.starts_with('-')
        && !name.contains(".."))
    .then(|| name.to_owned())
}
