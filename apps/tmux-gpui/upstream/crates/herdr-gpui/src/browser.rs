//! Browser tabs: web pages shown in place of the terminal, or beside it in
//! another editor group, next to a workspace's Herdr tabs. Herdr panes are always
//! terminals, so these tabs belong to this client alone; the daemon and its
//! other clients never see them. Pages are native web views drawn above the window, which is why the
//! window hides them whenever one of its own overlays is open.

#[cfg(any(target_os = "macos", windows, test))]
mod annotate;
// Linux builds show no pages, so there is nothing to annotate there.
#[cfg(any(target_os = "macos", windows))]
mod annotate_view;
mod feedback;
mod group_motion;
mod groups;
mod groups_view;
mod layouts;
mod location;
#[cfg(any(target_os = "macos", windows))]
mod native;
#[cfg(target_os = "macos")]
mod popup;
#[cfg(any(target_os = "macos", windows))]
mod preview;
#[cfg(target_os = "macos")]
mod snapshot;
mod store;
mod tab_appear;
mod tab_scroll;
mod view;
#[cfg(test)]
mod view_tests;

#[cfg(any(target_os = "macos", windows))]
pub(crate) use annotate_view::Annotations;
pub(crate) use feedback::{Batch, Feedback};
pub(crate) use group_motion::Fold;
#[cfg(test)]
pub(crate) use groups::GroupIds;
pub(crate) use groups::{GroupId, Pick, Shown, Slot};
pub(crate) use layouts::Layouts;
pub(crate) use location::{LocalFile, Location, ReviewCheckout};
#[cfg(any(target_os = "macos", windows))]
pub(crate) use native::Pages;
pub(crate) use store::{Scope, Store, Tab, TabId};
pub(crate) use tab_appear::{Leaving, Listed};
pub(crate) use tab_scroll::{Thumb, ThumbDrag};
pub(crate) use view::{Browser, scope};

/// Whether this build can show a page inside the window. Elsewhere a browser
/// tab request opens the system browser instead.
pub(crate) const EMBEDDED: bool = cfg!(any(target_os = "macos", windows));

const MAX_URL_BYTES: usize = 8192;

/// An address a browser tab may show: http or https with a host, bounded,
/// and free of whitespace and control characters. Anything that reaches a
/// page, from a terminal link, an agent, or the address field, is parsed into
/// this first.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct WebUrl(url::Url);

impl WebUrl {
    pub(crate) fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub(crate) fn host(&self) -> &str {
        self.0.host_str().unwrap_or_default()
    }

    /// What someone typed into the address field: a bare host such as
    /// `localhost:3000` or `example.com/docs` gets a scheme, local hosts plain
    /// http and everything else https.
    pub(crate) fn from_typed(text: &str) -> crate::Result<Self> {
        let text = text.trim();
        if let Ok(url) = Self::try_from(text) {
            return Ok(url);
        }
        if text.contains("://") {
            return Err(crate::Error::InvalidBrowserUrl);
        }
        let host = text.split(['/', ':', '?', '#']).next().unwrap_or_default();
        let local =
            matches!(host, "localhost" | "127.0.0.1" | "[::1]") || host.ends_with(".localhost");
        let scheme = if local { "http" } else { "https" };
        Self::try_from(format!("{scheme}://{text}").as_str())
    }
}

impl TryFrom<&str> for WebUrl {
    type Error = crate::Error;

    fn try_from(value: &str) -> crate::Result<Self> {
        if value.len() > MAX_URL_BYTES || value.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(crate::Error::InvalidBrowserUrl);
        }
        let url = url::Url::parse(value).map_err(|_| crate::Error::InvalidBrowserUrl)?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
            return Err(crate::Error::InvalidBrowserUrl);
        }
        // Serialization can lengthen an address, for example by
        // percent-encoding, so the bound applies to what a page is given too.
        if url.as_str().len() > MAX_URL_BYTES {
            return Err(crate::Error::InvalidBrowserUrl);
        }
        Ok(Self(url))
    }
}

impl TryFrom<String> for WebUrl {
    type Error = crate::Error;

    fn try_from(value: String) -> crate::Result<Self> {
        Self::try_from(value.as_str())
    }
}

impl From<WebUrl> for String {
    fn from(url: WebUrl) -> Self {
        url.0.into()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn only_bounded_web_addresses_with_a_host_are_accepted() {
        for valid in [
            "http://localhost:3000/",
            "https://example.com/a?b#c",
            "https://[::1]:8080/",
        ] {
            assert!(WebUrl::try_from(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "vscode://open",
            "https://",
            "https://a.test/\nb",
            "https://a.test/ b",
            "not a url",
        ] {
            assert!(
                matches!(
                    WebUrl::try_from(invalid),
                    Err(crate::Error::InvalidBrowserUrl)
                ),
                "{invalid}"
            );
        }
        let long = format!("https://a.test/{}", "x".repeat(MAX_URL_BYTES));
        assert!(WebUrl::try_from(long.as_str()).is_err());
    }

    #[test]
    fn typed_addresses_gain_a_scheme() {
        let typed = |text| WebUrl::from_typed(text).map(|url| url.as_str().to_owned());
        assert_eq!(typed("localhost:3000").unwrap(), "http://localhost:3000/");
        assert_eq!(typed("app.localhost/x").unwrap(), "http://app.localhost/x");
        assert_eq!(
            typed(" example.com/docs ").unwrap(),
            "https://example.com/docs"
        );
        assert_eq!(typed("http://a.test").unwrap(), "http://a.test/");
        assert!(typed("file:///etc/passwd").is_err());
        assert!(typed("ftp://a.test").is_err());
        assert!(typed("").is_err());
    }

    #[test]
    fn saved_addresses_are_validated_when_read() {
        assert!(serde_json::from_str::<WebUrl>(r#""https://a.test/""#).is_ok());
        assert!(serde_json::from_str::<WebUrl>(r#""file:///etc/passwd""#).is_err());
    }
}
