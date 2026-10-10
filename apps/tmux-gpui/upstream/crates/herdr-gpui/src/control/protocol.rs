//! The control socket's messages: one JSON request line, one JSON response
//! line, then the connection closes.
use serde::{Deserialize, Serialize};

/// Bounds a request and a response alike. A response can carry a batch of
/// notes, each with a bounded snippet of the page.
#[cfg(unix)]
pub(crate) const MAX_MESSAGE: usize = 256 * 1024;
/// The longest `browser feedback --wait`, in seconds.
pub(crate) const MAX_WAIT_SECONDS: u64 = 600;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub(crate) enum Request {
    #[serde(rename = "browser.open")]
    Open(BrowserOpen),
    #[serde(rename = "browser.reload")]
    Reload(Caller),
    #[serde(rename = "browser.feedback")]
    Feedback(FeedbackRequest),
}

/// What a tab shows: a web address, or a local file by absolute path, which
/// the caller resolved on its side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Page {
    Url(String),
    File(String),
}

/// Who is asking: the Herdr pane, workspace, and daemon the caller runs in.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Caller {
    /// The caller's `HERDR_PANE_ID`, which notes on its pages go back to.
    #[serde(default)]
    pub pane_id: Option<String>,
    /// The Herdr workspace to open the tab in, normally the caller's own
    /// `HERDR_WORKSPACE_ID`. Absent, the tab opens in the workspace the
    /// frontmost window shows.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// The client socket of the caller's daemon, which tells two local
    /// sessions' identical workspace IDs apart.
    #[serde(default)]
    pub daemon_socket: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BrowserOpen {
    pub page: Page,
    pub caller: Caller,
    /// Whether the window switches to the tab.
    pub focus: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FeedbackRequest {
    pub pane_id: String,
    /// How long to wait for notes when none are waiting, at most
    /// `MAX_WAIT_SECONDS`.
    pub wait_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpenedIn {
    /// A browser tab inside the window.
    Tab,
    /// The system browser, on a platform whose build cannot show pages.
    SystemBrowser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    InvalidUrl,
    NoWindow,
    WorkspaceNotFound,
    TabLimit,
    Busy,
    Timeout,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum Response {
    Opened {
        opened_in: OpenedIn,
        workspace_id: Option<String>,
    },
    Reloaded {
        tabs: usize,
    },
    /// Notes the user sent to the caller, or `None` when there are none.
    Feedback {
        text: Option<String>,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

#[cfg(any(unix, test))]
impl Response {
    pub(crate) fn error(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::Error {
            code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn requests_have_a_stable_wire_form() {
        let request = Request::Open(BrowserOpen {
            page: Page::Url("http://localhost:3000/".into()),
            caller: Caller {
                pane_id: Some("w_1:p1".into()),
                workspace_id: Some("w_1".into()),
                daemon_socket: None,
            },
            focus: true,
        });
        let text = serde_json::to_string(&request).unwrap();
        assert_eq!(
            text,
            r#"{"method":"browser.open","page":{"url":"http://localhost:3000/"},"caller":{"pane_id":"w_1:p1","workspace_id":"w_1","daemon_socket":null},"focus":true}"#
        );
        assert_eq!(serde_json::from_str::<Request>(&text).unwrap(), request);
        let minimal: Request = serde_json::from_str(
            r#"{"method":"browser.open","page":{"file":"/srv/a.html"},"caller":{},"focus":false}"#,
        )
        .unwrap();
        assert!(matches!(
            minimal,
            Request::Open(BrowserOpen {
                page: Page::File(_),
                caller: Caller { pane_id: None, .. },
                ..
            })
        ));
        let feedback: Request = serde_json::from_str(
            r#"{"method":"browser.feedback","pane_id":"w_1:p1","wait_seconds":30}"#,
        )
        .unwrap();
        assert_eq!(
            feedback,
            Request::Feedback(FeedbackRequest {
                pane_id: "w_1:p1".into(),
                wait_seconds: 30
            })
        );
        let reload: Request =
            serde_json::from_str(r#"{"method":"browser.reload","pane_id":"w_1:p1"}"#).unwrap();
        assert!(matches!(
            reload,
            Request::Reload(Caller {
                pane_id: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn unknown_methods_and_fields_are_rejected() {
        for invalid in [
            r#"{"method":"browser.eval","page":{"url":"https://a.test"},"caller":{},"focus":true}"#,
            r#"{"method":"browser.open","page":{"url":"https://a.test"},"caller":{},"focus":true,"extra":1}"#,
            r#"{"method":"browser.open","page":{"script":"x"},"caller":{},"focus":true}"#,
            r#"{"method":"browser.open","page":{"url":"https://a.test"},"caller":{"shell":"x"},"focus":true}"#,
            r#"{"method":"browser.open","focus":true}"#,
            r#"{"method":"browser.feedback","wait_seconds":1}"#,
            r#"["browser.open"]"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn responses_round_trip() {
        for response in [
            Response::Opened {
                opened_in: OpenedIn::Tab,
                workspace_id: Some("w_1".into()),
            },
            Response::error(ErrorCode::WorkspaceNotFound, "No window shows w_9"),
            Response::Reloaded { tabs: 2 },
            Response::Feedback {
                text: Some("1. Note".into()),
            },
            Response::Feedback { text: None },
        ] {
            let text = serde_json::to_string(&response).unwrap();
            assert_eq!(serde_json::from_str::<Response>(&text).unwrap(), response);
        }
        assert_eq!(
            serde_json::to_string(&Response::error(ErrorCode::Busy, "x")).unwrap(),
            r#"{"status":"error","code":"busy","message":"x"}"#
        );
    }
}
