//! Where a browser tab's page comes from: the web, or a local file an agent
//! wrote; or, for a review tab, the checkout whose changes it shows. Pages cannot open `file:` addresses, so a local file is served
//! from its folder through a private scheme, and only from that folder.
use super::WebUrl;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[cfg(any(target_os = "macos", windows))]
/// The private scheme local pages load through. On Windows, WebView2 spells
/// it `http://herdr-preview.localhost/`.
pub(crate) const PREVIEW_SCHEME: &str = "herdr-preview";
#[cfg(any(target_os = "macos", windows, test))]
const PREVIEW_ORIGINS: [&str; 3] = [
    "herdr-preview://localhost/",
    "http://herdr-preview.localhost/",
    "https://herdr-preview.localhost/",
];

#[cfg(any(target_os = "macos", windows, test))]
/// Everything but unreserved characters is escaped in a path segment.
const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Location {
    Web {
        url: WebUrl,
    },
    Local {
        file: LocalFile,
    },
    /// A review of a checkout's changes, drawn by the app, never a page.
    Review {
        checkout: ReviewCheckout,
    },
}

/// The local checkout a review tab shows. Saved with the tabs, so it is
/// checked again whenever it is read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SavedReviewCheckout")]
pub(crate) struct ReviewCheckout {
    pub(crate) repo_key: String,
    pub(crate) branch: String,
    pub(crate) checkout: Option<String>,
}

#[derive(Deserialize)]
struct SavedReviewCheckout {
    repo_key: String,
    branch: String,
    checkout: Option<String>,
}

impl TryFrom<SavedReviewCheckout> for ReviewCheckout {
    type Error = crate::Error;

    fn try_from(saved: SavedReviewCheckout) -> crate::Result<Self> {
        let path = |text: &str| {
            !text.is_empty()
                && text.len() <= 4096
                && !text.chars().any(char::is_control)
                && Path::new(text).is_absolute()
        };
        let branch = !saved.branch.is_empty()
            && saved.branch.len() <= 1024
            && !saved.branch.chars().any(char::is_control);
        if !path(&saved.repo_key) || !branch || saved.checkout.as_deref().is_some_and(|c| !path(c))
        {
            return Err(crate::Error::InvalidReviewCheckout);
        }
        Ok(Self {
            repo_key: saved.repo_key,
            branch: saved.branch,
            checkout: saved.checkout,
        })
    }
}

/// A review is saved by repository, so only a checkout the daemon named one
/// for can be reviewed.
impl TryFrom<&crate::pull_request::Input> for ReviewCheckout {
    type Error = crate::Error;

    fn try_from(input: &crate::pull_request::Input) -> crate::Result<Self> {
        Ok(Self {
            repo_key: input.repo_key.clone().ok_or(crate::Error::PrMetadata)?,
            branch: input.branch.clone(),
            checkout: input.checkout.clone(),
        })
    }
}

impl From<&ReviewCheckout> for crate::pull_request::Input {
    fn from(checkout: &ReviewCheckout) -> Self {
        Self {
            checkout: checkout.checkout.clone(),
            repo_key: Some(checkout.repo_key.clone()),
            branch: checkout.branch.clone(),
        }
    }
}

impl Location {
    /// The address the page is loaded from.
    #[cfg(any(target_os = "macos", windows, test))]
    pub(crate) fn page_url(&self) -> String {
        match self {
            Self::Web { url } => url.as_str().to_owned(),
            Self::Local { file } => file.page_url(),
            // Never loaded: a review is drawn by the app.
            Self::Review { .. } => "about:blank".to_owned(),
        }
    }

    /// Whether a native page shows it, rather than the app drawing it.
    pub(crate) fn is_page(&self) -> bool {
        !matches!(self, Self::Review { .. })
    }

    /// What the address field and a prompt show for it.
    pub(crate) fn display(&self) -> String {
        match self {
            Self::Web { url } => url.as_str().to_owned(),
            Self::Local { file } => file.path().display().to_string(),
            Self::Review { checkout } => format!("Review of {}", checkout.branch),
        }
    }

    /// A tab's title before its page names itself.
    pub(crate) fn default_title(&self) -> String {
        match self {
            Self::Web { url } => url.host().to_owned(),
            Self::Local { file } => file.entry.rsplit('/').next().unwrap_or_default().to_owned(),
            Self::Review { checkout } => format!("Review \u{00b7} {}", checkout.branch),
        }
    }

    #[cfg(any(target_os = "macos", windows, test))]
    /// Where a page reported it went, relative to this tab: a local page
    /// stays in its folder, so another file there keeps the same root.
    pub(crate) fn visited(&self, reported: &str) -> Option<Self> {
        if let Some(entry) = PREVIEW_ORIGINS
            .iter()
            .find_map(|origin| reported.strip_prefix(origin))
        {
            let Self::Local { file } = self else {
                return None;
            };
            let entry = entry.split(['?', '#']).next().unwrap_or_default();
            let entry = decode_entry(entry)?;
            return Some(Self::Local {
                file: LocalFile {
                    root: file.root.clone(),
                    entry,
                },
            });
        }
        WebUrl::try_from(reported).ok().map(|url| Self::Web { url })
    }
}

/// A file inside a served folder. Only the folder's own files are served,
/// never a hidden one, and never from a folder holding the home directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SavedLocalFile")]
pub(crate) struct LocalFile {
    root: PathBuf,
    /// Relative to `root`, `/`-separated.
    entry: String,
}

#[derive(Deserialize)]
struct SavedLocalFile {
    root: PathBuf,
    entry: String,
}

impl TryFrom<SavedLocalFile> for LocalFile {
    type Error = crate::Error;

    fn try_from(saved: SavedLocalFile) -> crate::Result<Self> {
        let file = Self {
            root: saved.root,
            entry: saved.entry,
        };
        let home = crate::config::home().ok();
        file.check(home.as_deref())?;
        Ok(file)
    }
}

/// Plain names only: no `..`, no hidden files or folders, nothing empty.
fn plain_component(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
        && !name.chars().any(char::is_control)
}

#[cfg(any(target_os = "macos", windows, test))]
fn decode_entry(encoded: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in encoded.split('/') {
        let part = percent_encoding::percent_decode_str(part)
            .decode_utf8()
            .ok()?;
        if !plain_component(&part) {
            return None;
        }
        parts.push(part.into_owned());
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

impl LocalFile {
    /// The file at `path`, served from its folder. `path` must already be
    /// absolute and resolved; the caller's own process does that, so the UI
    /// never touches the disk here.
    pub(crate) fn new(path: &Path, home: Option<&Path>) -> crate::Result<Self> {
        let (Some(root), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
        else {
            return Err(crate::Error::InvalidLocalPage);
        };
        let file = Self {
            root: root.to_owned(),
            entry: name.to_owned(),
        };
        file.check(home)?;
        Ok(file)
    }

    fn check(&self, home: Option<&Path>) -> crate::Result<()> {
        let absolute = self.root.is_absolute()
            && self.root.components().all(|part| {
                matches!(
                    part,
                    Component::RootDir | Component::Prefix(_) | Component::Normal(_)
                )
            })
            && self
                .root
                .components()
                .any(|part| matches!(part, Component::Normal(_)));
        let normal = |part: Component<'_>| match part {
            Component::Normal(name) => name.to_str().is_some_and(|name| !name.starts_with('.')),
            _ => true,
        };
        // A folder holding the home directory would expose all of it.
        let exposes_home = home.is_some_and(|home| home.starts_with(&self.root));
        if !absolute
            || exposes_home
            || !self.root.components().all(normal)
            || !self.entry.split('/').all(plain_component)
        {
            return Err(crate::Error::InvalidLocalPage);
        }
        Ok(())
    }

    #[cfg(any(target_os = "macos", windows, test))]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn path(&self) -> PathBuf {
        self.entry
            .split('/')
            .fold(self.root.clone(), |path, part| path.join(part))
    }

    #[cfg(any(target_os = "macos", windows, test))]
    fn page_url(&self) -> String {
        let path: Vec<String> = self
            .entry
            .split('/')
            .map(|part| percent_encoding::utf8_percent_encode(part, SEGMENT).to_string())
            .collect();
        format!("{}{}", PREVIEW_ORIGINS[0], path.join("/"))
    }
}

#[cfg(any(target_os = "macos", windows, test))]
/// The file a preview request names under `root`, or `None` when the name
/// is not a plain relative path. The caller still resolves links on disk.
pub(crate) fn requested_file(root: &Path, request_path: &str) -> Option<PathBuf> {
    let entry = request_path.trim_start_matches('/');
    let entry = if entry.is_empty() || entry.ends_with('/') {
        format!("{entry}index.html")
    } else {
        entry.to_owned()
    };
    let entry = decode_entry(&entry)?;
    Some(
        entry
            .split('/')
            .fold(root.to_owned(), |path, part| path.join(part)),
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[cfg(unix)]
    fn file(path: &str) -> crate::Result<LocalFile> {
        LocalFile::new(Path::new(path), Some(Path::new("/Users/me")))
    }

    // Windows paths need a drive to be absolute.
    #[cfg(unix)]
    #[test]
    fn local_pages_are_served_from_a_private_folder() {
        let page = file("/Users/me/project/design/mockup v2.html").unwrap();
        assert_eq!(page.root(), Path::new("/Users/me/project/design"));
        let location = Location::Local { file: page };
        assert_eq!(
            location.page_url(),
            "herdr-preview://localhost/mockup%20v2.html"
        );
        assert_eq!(location.default_title(), "mockup v2.html");
        assert_eq!(
            location.display(),
            "/Users/me/project/design/mockup v2.html"
        );
        for refused in [
            "relative/page.html",
            "/Users/me/page.html",
            "/Users/page.html",
            "/page.html",
            "/Users/me/.secret/page.html",
            "/Users/me/project/.env",
            "/Users/me/project/../page.html",
        ] {
            assert!(file(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn requests_stay_inside_the_folder_and_skip_hidden_names() {
        let root = Path::new("/srv/site");
        assert_eq!(requested_file(root, "/").unwrap(), root.join("index.html"));
        assert_eq!(
            requested_file(root, "/assets/app%20x.css").unwrap(),
            root.join("assets").join("app x.css")
        );
        for refused in [
            "/../etc/passwd",
            "/%2e%2e/x",
            "/.git/config",
            "/a/../../b",
            "/a%2fb",
            "/a//b",
        ] {
            assert!(requested_file(root, refused).is_none(), "{refused}");
        }
    }

    // Windows paths need a drive to be absolute.
    #[cfg(unix)]
    #[test]
    fn navigation_within_a_local_folder_keeps_its_root() {
        let page = Location::Local {
            file: file("/Users/me/site/index.html").unwrap(),
        };
        for origin in PREVIEW_ORIGINS {
            let next = page.visited(&format!("{origin}docs/b.html#top")).unwrap();
            assert_eq!(next.display(), "/Users/me/site/docs/b.html");
        }
        assert!(
            page.visited("herdr-preview://localhost/.git/config")
                .is_none()
        );
        let web = page.visited("https://a.test/").unwrap();
        assert!(matches!(web, Location::Web { .. }));
        // A web page cannot claim a local file.
        let web = Location::Web {
            url: WebUrl::try_from("https://a.test/").unwrap(),
        };
        assert!(web.visited("herdr-preview://localhost/x.html").is_none());
    }

    // Windows paths need a drive to be absolute.
    #[cfg(unix)]
    #[test]
    fn saved_local_files_are_checked_again() {
        let saved = r#"{"kind":"local","file":{"root":"/","entry":"etc"}}"#;
        assert!(serde_json::from_str::<Location>(saved).is_err());
        let saved = r#"{"kind":"local","file":{"root":"/srv/site","entry":"index.html"}}"#;
        assert!(serde_json::from_str::<Location>(saved).is_ok());
    }
}
