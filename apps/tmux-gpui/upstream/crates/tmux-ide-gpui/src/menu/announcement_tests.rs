//! The daemon's announcement card and release notes sheet, drawn headless
//! over a mock peer so each dismissal is checked on the wire.
#![allow(clippy::unwrap_used)]

use super::Page;
use crate::{
    HerdrWindow, sidebar::layout_tests::fixture_window, state::ConnectionStatus, window::MockPeer,
};
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};
use herdr_client::protocol::{ClientMessage, ClientShellSnapshot};
use std::sync::Arc;

fn snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap()
}

/// A window drawing the fixture snapshot over `peer`, which offers both
/// dismiss methods.
fn connected<'a>(
    cx: &'a mut TestAppContext,
    peer: &MockPeer,
    snapshot: ClientShellSnapshot,
) -> (Entity<HerdrWindow>, &'a mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(900.), px(700.)));
    view.update(cx, |view, _| {
        view.endpoints[0].connection.handle = Some(peer.client.handle.clone());
        view.live.snapshot = Some(Arc::new(snapshot));
        view.live.status = ConnectionStatus::Connected;
        view.live.supports_announcement_dismiss = true;
        view.live.supports_release_notes_dismiss = true;
        *view.endpoints[0].connection.inbox.lock().unwrap() = view.live.clone();
    });
    draw(cx);
    (view, cx)
}

/// GPUI double-buffers debug bounds; draw both buffers before asking.
fn draw(cx: &mut VisualTestContext) {
    for _ in 0..2 {
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
}

fn request(peer: &mut MockPeer) -> serde_json::Value {
    loop {
        if let ClientMessage::ClientShellEndpointRequest { request, .. } = peer.receive() {
            return serde_json::from_str(&request).unwrap();
        }
    }
}

#[gpui::test]
fn dismissing_the_card_asks_the_daemon_and_hides_it(cx: &mut TestAppContext) {
    let mut peer = MockPeer::advertising(&["product_announcement.dismiss"]);
    let (view, cx) = connected(cx, &peer, snapshot());
    let card = cx.debug_bounds("announcement").unwrap();
    assert!(cx.debug_bounds("announcement-title").is_some());
    assert!(cx.debug_bounds("announcement-line-0").is_some());
    // Inside the window, clear of the tab strip.
    assert!(card.right() <= px(900.) && card.top() > px(0.));

    let dismiss = cx.debug_bounds("announcement-dismiss").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    let sent = request(&mut peer);
    assert_eq!(sent["method"], "product_announcement.dismiss");
    assert_eq!(
        sent["params"],
        serde_json::json!({"version": "1.0.0", "id": "announcement-v1"})
    );
    draw(cx);
    assert!(cx.debug_bounds("announcement").is_none());
    view.read_with(cx, |view, _| {
        let inbox = view.endpoints[0].connection.inbox.lock().unwrap();
        assert!(
            inbox
                .announcement_dismissal
                .as_ref()
                .unwrap()
                .request
                .is_some()
        );
        assert!(view.local_error.is_none());
    });
}

#[gpui::test]
fn the_card_stacks_below_a_config_diagnostic(cx: &mut TestAppContext) {
    let peer = MockPeer::new();
    let mut warned = snapshot();
    warned.config_diagnostic = Some("config.toml invalid; using defaults".into());
    let (view, cx) = connected(cx, &peer, warned);
    view.update(cx, |view, cx| {
        view.endpoints[0].live = view.live.clone();
        view.endpoints[0].sync_live();
        cx.notify();
    });
    draw(cx);
    let diagnostic = cx.debug_bounds("config-diagnostic").unwrap();
    let card = cx.debug_bounds("announcement").unwrap();
    assert!(diagnostic.bottom() <= card.top());
    assert_eq!(diagnostic.right(), card.right());
}

#[gpui::test]
fn a_daemon_without_the_method_only_hides_the_card(cx: &mut TestAppContext) {
    let peer = MockPeer::new();
    let (view, cx) = connected(cx, &peer, snapshot());
    view.update(cx, |view, cx| {
        view.live.supports_announcement_dismiss = false;
        *view.endpoints[0].connection.inbox.lock().unwrap() = view.live.clone();
        view.dismiss_announcement("1.0.0", "announcement-v1", cx);
        assert!(view.live.product_announcement().is_none());
        let inbox = view.endpoints[0].connection.inbox.lock().unwrap();
        assert_eq!(inbox.announcement_dismissal.as_ref().unwrap().request, None);
    });
}

#[gpui::test]
fn a_replaced_announcement_is_not_dismissed(cx: &mut TestAppContext) {
    let peer = MockPeer::advertising(&["product_announcement.dismiss"]);
    let (view, cx) = connected(cx, &peer, snapshot());
    view.update(cx, |view, cx| {
        view.dismiss_announcement("1.0.0", "older", cx);
        assert!(view.live.product_announcement().is_some());
        assert!(
            view.endpoints[0]
                .connection
                .inbox
                .lock()
                .unwrap()
                .announcement_dismissal
                .is_none()
        );
    });
}

#[gpui::test]
fn the_card_waits_behind_menu_pages(cx: &mut TestAppContext) {
    let peer = MockPeer::new();
    let (view, cx) = connected(cx, &peer, snapshot());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_menu(window, cx);
        })
    });
    draw(cx);
    assert!(cx.debug_bounds("announcement").is_none());
}

#[gpui::test]
fn the_menu_offers_release_notes_only_when_the_daemon_has_them(cx: &mut TestAppContext) {
    let peer = MockPeer::new();
    let mut notes_only = snapshot();
    notes_only.update_available = None;
    let mut nothing = notes_only.clone();
    nothing.release_notes = None;
    let (view, cx) = connected(cx, &peer, snapshot());
    for (snapshot, item) in [
        (snapshot(), Some("update ready")),
        (notes_only, Some("what's new")),
        (nothing, None),
    ] {
        view.update(cx, |view, _| {
            view.live.snapshot = Some(Arc::new(snapshot));
            let items = view.menu_items();
            assert_eq!(view.release_notes_item(), item);
            assert_eq!(items.contains(&"what's new"), item == Some("what's new"));
            assert_eq!(
                items.contains(&"update ready"),
                item == Some("update ready")
            );
        });
    }
}

#[gpui::test]
fn closing_the_sheet_marks_the_notes_read(cx: &mut TestAppContext) {
    let mut peer = MockPeer::advertising(&["release_notes.dismiss"]);
    let mut notes = snapshot();
    notes.release_notes.as_mut().unwrap().body =
        "### Added\n- `herdr x` [docs](https://herdr.dev)\n```\nrm -rf /\n```".into();
    let (view, cx) = connected(cx, &peer, notes);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_menu(window, cx);
            view.activate_menu("update ready", window, cx);
        })
    });
    draw(cx);
    assert_eq!(
        view.read_with(cx, |view, _| view.menu.page),
        Some(Page::Update)
    );
    for selector in [
        "release-notes-title",
        "release-notes-command",
        "release-notes-body",
        "release-notes-line-0",
        "release-notes-line-2",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let close = cx.debug_bounds("release-notes-close").unwrap();
    cx.simulate_click(close.center(), Default::default());
    let sent = request(&mut peer);
    assert_eq!(sent["method"], "release_notes.dismiss");
    assert_eq!(sent["params"], serde_json::json!({"version": "1.0.1"}));
    assert_eq!(view.read_with(cx, |view, _| view.menu.page), None);
}
