//! R03: `ReaderLinks::open` is where a click lands; it applies the owner's
//! link policy, so only plain http and https reach the system browser.
#![allow(clippy::unwrap_used)]
use super::*;
use bezel_markdown::{Link, Links as _};
use gpui::TestAppContext;

#[gpui::test]
fn a_click_opens_only_plain_web_links(cx: &mut TestAppContext) {
    let window = cx.add_empty_window();
    // The test platform keeps the last URL opened, so refusals go first.
    for url in [
        "mailto:owner@example.com",
        "file:///etc/passwd",
        "vscode://open",
        "https://user:pass@example.com/",
        "../notes.md",
        "#intro",
    ] {
        window.update(|window, cx| ReaderLinks::open(Link::new(url, None), window, cx));
        assert_eq!(window.opened_url(), None, "{url}");
    }
    window.update(|window, cx| {
        ReaderLinks::open(Link::new("https://tmux-ide.dev/docs", None), window, cx)
    });
    assert_eq!(
        window.opened_url().as_deref(),
        Some("https://tmux-ide.dev/docs")
    );
}
