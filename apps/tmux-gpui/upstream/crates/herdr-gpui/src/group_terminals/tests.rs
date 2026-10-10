#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    controls::Command,
    sidebar::layout_tests::{fixture_window, full_draw, snapshot},
    window::MockPeer,
};
use core::prelude::v1::test;
use herdr_client::protocol::{
    ClientMessage, ClientShellSnapshot, FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect,
};
use std::sync::Arc;

/// A coherent surface for `snapshot`, as the daemon projects one.
pub(super) fn surface(snapshot: &ClientShellSnapshot, pane: &str) -> Arc<PaneSurfaceFrame> {
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: 80,
        height: 24,
    };
    Arc::new(PaneSurfaceFrame {
        boot_id: snapshot.boot_id.clone(),
        projection_revision: snapshot.revision,
        surface_revision: 1,
        frame: FrameData {
            width: 80,
            height: 24,
            cells: vec![],
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![PaneSurfacePane {
            pane_id: pane.into(),
            content_revision: 1,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 800,
            pixel_height: 480,
        }],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    })
}

/// A parked connection over `peer`, projecting `snapshot`. It names the
/// daemon `target` names, as a group's connection names its window's.
fn parked(
    group: GroupId,
    workspace: (Scope, String),
    target: herdr_client::ConnectTarget,
    peer: &MockPeer,
    snapshot: ClientShellSnapshot,
) -> Parked {
    let mut connection = ConnectionBridge::new(target);
    connection.handle = Some(peer.client.handle.clone());
    let mut live = LiveState::default();
    live.status = ConnectionStatus::Connected;
    live.surface = Some(surface(&snapshot, "p1"));
    live.snapshot = Some(Arc::new(snapshot));
    Parked {
        group,
        workspace,
        connection,
        live,
        presentation: Presentation::default(),
        options: ConnectOptions::default(),
        last_queued_options: Some(ConnectOptions::default()),
        pending_resize: None,
        bounds: Bounds::default(),
        unfocused: false,
        asked: None,
    }
}

fn fixture_snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap()
}

#[test]
fn a_parked_connection_stays_unfocused_and_asks_for_its_tab_once() {
    let mut peer = MockPeer::advertising(&["tab.focus"]);
    let snapshot = fixture_snapshot();
    let workspace = snapshot.focused_workspace_id.clone().unwrap();
    let mut ids = crate::browser::GroupIds::default();
    let mut parked = parked(
        ids.next(),
        (Scope::endpoint("local"), workspace),
        herdr_client::ConnectTarget::Socket("/unused-parked.sock".into()),
        &peer,
        snapshot,
    );
    let now = Instant::now();
    parked.steer("w1:t2", now);
    assert_eq!(
        peer.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    );
    let ClientMessage::ClientShellEndpointRequest { request, .. } = peer.receive() else {
        panic!("expected a tab focus request");
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "tab.focus");
    assert_eq!(request["params"]["tab_id"], "w1:t2");
    // Neither is repeated while the request is fresh; a later tick asks
    // again only once it has had its time.
    parked.steer("w1:t2", now + Duration::from_millis(10));
    assert!(parked.unfocused);
    let asked = parked.asked.clone().unwrap();
    assert_eq!((asked.0.as_str(), asked.1), ("w1:t2", now));
    parked.steer("w1:t2", now + REFOCUS_AFTER + Duration::from_millis(10));
    assert!(parked.asked.unwrap().1 > now);
}

#[test]
fn a_parked_connection_settles_a_new_size_before_sending_it() {
    let mut peer = MockPeer::new();
    let snapshot = fixture_snapshot();
    let workspace = snapshot.focused_workspace_id.clone().unwrap();
    let tab = snapshot.focused_tab_id.clone().unwrap();
    let mut ids = crate::browser::GroupIds::default();
    let mut parked = parked(
        ids.next(),
        (Scope::endpoint("local"), workspace),
        herdr_client::ConnectTarget::Socket("/unused-parked.sock".into()),
        &peer,
        snapshot,
    );
    let now = Instant::now();
    parked.options.surface_size.cols = 100;
    // Already on its tab, it asks for nothing but a size.
    parked.steer(&tab, now);
    assert_eq!(
        peer.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    );
    assert!(parked.pending_resize.is_some() && parked.asked.is_none());
    parked.steer(&tab, now + Duration::from_millis(100));
    assert!(parked.last_queued_options != Some(parked.options));
    parked.steer(&tab, now + RESIZE_SETTLE + Duration::from_millis(10));
    let ClientMessage::ClientShellResize { surface_size, .. } = peer.receive() else {
        panic!("expected a resize");
    };
    assert_eq!(surface_size.cols, 100);
    assert_eq!(parked.last_queued_options, Some(parked.options));
    assert!(parked.pending_resize.is_none());
}

#[test]
fn a_parked_connection_reasks_a_size_another_client_overrode() {
    let mut peer = MockPeer::new();
    let snapshot = fixture_snapshot();
    let workspace = snapshot.focused_workspace_id.clone().unwrap();
    let tab = snapshot.focused_tab_id.clone().unwrap();
    let mut ids = crate::browser::GroupIds::default();
    let mut parked = parked(
        ids.next(),
        (Scope::endpoint("local"), workspace),
        herdr_client::ConnectTarget::Socket("/unused-parked.sock".into()),
        &peer,
        snapshot,
    );
    // The connection's own request is already the queued one, but the
    // daemon projects a frame of another size: another client resized
    // the tab, so the request must go out again.
    parked.options.surface_size.cols = 100;
    parked.last_queued_options = Some(parked.options);
    let now = Instant::now();
    parked.steer(&tab, now);
    assert_eq!(
        peer.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    );
    assert!(parked.pending_resize.is_some());
    parked.steer(&tab, now + RESIZE_SETTLE + Duration::from_millis(10));
    assert!(
        parked.pending_resize.is_some(),
        "a frame of another size is not re-claimed before it has been answered"
    );
    parked.steer(&tab, now + RESIZE_REASSERT + Duration::from_millis(10));
    let ClientMessage::ClientShellResize { surface_size, .. } = peer.receive() else {
        panic!("expected a resize");
    };
    assert_eq!(surface_size.cols, 100);
    assert_eq!(parked.last_queued_options, Some(parked.options));
}

/// The fixture window, connected and showing tab `t0` of `w0`.
pub(super) fn fixture_window_on_t0(
    cx: &mut TestAppContext,
) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    window(cx)
}

fn window(cx: &mut TestAppContext) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut shown = snapshot(40);
        shown.focused_workspace_id = Some("w0".into());
        shown.focused_tab_id = Some("t0".into());
        view.live.snapshot = Some(Arc::new(shown));
        view.live.status = ConnectionStatus::Connected;
        // A connected endpoint's projection is what the window copied.
        view.endpoints[0].live = view.live.clone();
        view
    })
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn using_a_parked_group_swaps_its_connection_in(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    draw(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    draw(cx);
    let [left, right] = view.read_with(cx, |view, _| {
        let slots = view.group_slots();
        [slots[0].id, slots[1].id]
    });
    view.read_with(cx, |view, _| assert_eq!(view.primary_group(), Some(right)));

    // The left group picks the other Herdr tab through a connection of
    // its own, already on that tab.
    let peer = MockPeer::new();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let layout = view.ensure_layout().unwrap();
            layout.choose(left, Pick::Herdr("t1".into()));
            layout.activate(right);
            let mut on_t1 = snapshot(40);
            on_t1.focused_workspace_id = Some("w0".into());
            on_t1.focused_tab_id = Some("t1".into());
            let key = view.browser_key().unwrap();
            let target = view.endpoints[0].connection.target.clone();
            let parked = parked(left, key, target, &peer, on_t1);
            // Every connection hears every notification; a parked one
            // passes none of them on.
            if let Ok(mut inbox) = parked.connection.inbox.lock() {
                *inbox = parked.live.clone();
                inbox.notifications_lost = true;
                inbox.dirty = true;
            }
            view.browser.terminals.parked.push(parked);
            assert!(view.poll_group_terminals());
            assert!(!view.browser.terminals.parked[0].live.notifications_lost);
            let _ = cx;
        })
    });
    draw(cx);
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.group_shown(left, cx), Shown::Terminal);
        assert!(view.shows_parked_terminal(left, cx));
        assert_eq!(view.group_shown(right, cx), Shown::Terminal);
    });
    // Both terminals paint: the window's with its input, the parked one
    // as a picture.
    assert!(cx.debug_bounds("terminal").is_some());
    assert!(cx.debug_bounds("parked-terminal").is_some());
    let terminal = cx.debug_bounds("terminal").unwrap();
    let parked = cx.debug_bounds("parked-terminal").unwrap();
    assert!(parked.right() <= terminal.left());

    // A composition in progress belongs to the right group's terminal.
    let epoch = view.update(cx, |view, _| {
        view.marked = "kan".into();
        view.selection_epoch
    });
    #[cfg(feature = "integration-test")]
    let discarded = view.read_with(cx, |view, _| view.input_probe.compositions_discarded);
    cx.update(|window, cx| view.update(cx, |view, cx| view.activate_group(left, window, cx)));
    draw(cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.primary_group(), Some(left));
        assert!(view.selection_epoch > epoch);
        // The swap ends it in the input method too, not only here.
        assert!(view.marked.is_empty());
        #[cfg(feature = "integration-test")]
        assert_eq!(view.input_probe.compositions_discarded, discarded + 1);
        // The window now speaks through the left group's connection.
        assert_eq!(view.focused_herdr_tab(), Some("t1"));
        assert_eq!(
            view.endpoints[0]
                .live
                .snapshot
                .as_ref()
                .and_then(|s| s.focused_tab_id.as_deref()),
            Some("t1")
        );
        // The right group keeps its tab through the connection it had.
        let parked = &view.browser.terminals.parked;
        assert_eq!(parked.len(), 1);
        assert_eq!(parked[0].group, right);
        assert_eq!(parked[0].focused_tab(), Some("t0"));
    });
    assert!(cx.debug_bounds("g1-parked-terminal").is_some());
    assert!(
        cx.debug_bounds("terminal").unwrap().right()
            <= cx.debug_bounds("g1-parked-terminal").unwrap().left()
    );

    // Closing the group drops its connection.
    cx.update(|window, cx| view.update(cx, |view, cx| view.close_group(right, window, cx)));
    view.read_with(cx, |view, _| {
        assert!(view.browser.terminals.parked.is_empty());
        assert_eq!(view.primary_group(), Some(left));
    });
}

#[gpui::test]
fn leaving_the_workspace_drops_parked_connections(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    draw(cx);
    let peer = MockPeer::new();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx);
            let slots = view.group_slots();
            let key = view.browser_key().unwrap();
            view.ensure_layout()
                .unwrap()
                .choose(slots[0].id, Pick::Herdr("t1".into()));
            view.ensure_layout().unwrap().activate(slots[1].id);
            let mut on_t1 = snapshot(40);
            on_t1.focused_workspace_id = Some("w0".into());
            on_t1.focused_tab_id = Some("t1".into());
            let target = view.endpoints[0].connection.target.clone();
            view.browser
                .terminals
                .parked
                .push(parked(slots[0].id, key, target, &peer, on_t1));
            view.reconcile_group_terminals(cx);
            assert_eq!(view.browser.terminals.parked.len(), 1);
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w1".into());
            view.reconcile_group_terminals(cx);
            assert!(view.browser.terminals.parked.is_empty());
        })
    });
}
