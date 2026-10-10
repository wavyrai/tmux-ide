use crate::sidebar::layout_tests::fixture_window;
use gpui::{TestAppContext, VisualTestContext, px, size};
use herdr_client::protocol::ClientShellSnapshot;
use std::sync::Arc;

fn set_diagnostic(
    view: &gpui::Entity<crate::HerdrWindow>,
    index: usize,
    diagnostic: Option<&str>,
    cx: &mut VisualTestContext,
) {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    snapshot.config_diagnostic = diagnostic.map(str::to_owned);
    view.update(cx, |view, cx| {
        let endpoint = &mut view.endpoints[index];
        endpoint.live.snapshot = Some(Arc::new(snapshot));
        endpoint.sync_live();
        cx.notify();
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn banner_follows_snapshot_dismissal_and_selected_endpoint(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(1000.), px(600.)));
    view.update(cx, |view, _| {
        view.endpoints.push(crate::endpoint::Endpoint::new(
            "remote".into(),
            "Remote".into(),
            herdr_client::ConnectTarget::Socket("/unused-config-diagnostic.sock".into()),
            true,
        ));
    });

    set_diagnostic(&view, 0, None, cx);
    assert!(cx.debug_bounds("config-diagnostic").is_none());

    set_diagnostic(&view, 0, Some("config.toml invalid; using defaults"), cx);
    let banner = cx.debug_bounds("config-diagnostic").unwrap();
    assert!(banner.right() <= px(1000.) && banner.left() >= px(0.));
    assert!(cx.debug_bounds("config-diagnostic-line-0").is_some());

    // Dismissal hides it while the daemon repeats the same text.
    let dismiss = cx.debug_bounds("config-diagnostic-dismiss").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    draw(cx);
    assert!(cx.debug_bounds("config-diagnostic").is_none());
    set_diagnostic(&view, 0, Some("config.toml invalid; using defaults"), cx);
    assert!(cx.debug_bounds("config-diagnostic").is_none());

    // Changed text comes back.
    set_diagnostic(&view, 0, Some("config.toml has unknown keys"), cx);
    assert!(cx.debug_bounds("config-diagnostic").is_some());

    // Another endpoint's diagnostic shows only while it is selected.
    set_diagnostic(&view, 1, Some("remote: config.toml invalid"), cx);
    set_diagnostic(&view, 0, None, cx);
    assert!(cx.debug_bounds("config-diagnostic").is_none());
    view.update(cx, |view, _| view.selected_endpoint = 1);
    draw(cx);
    assert!(cx.debug_bounds("config-diagnostic").is_some());
    // Dismissing it leaves the other endpoint's state alone.
    let dismiss = cx.debug_bounds("config-diagnostic-dismiss").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    set_diagnostic(&view, 0, Some("local again"), cx);
    view.read_with(cx, |view, _| {
        assert!(view.endpoints[1].config_diagnostic.visible().is_none());
        assert!(view.endpoints[0].config_diagnostic.visible().is_some());
    });
    view.update(cx, |view, _| view.selected_endpoint = 0);
    draw(cx);
    assert!(cx.debug_bounds("config-diagnostic").is_some());

    // Narrow windows keep it inside the viewport.
    cx.simulate_resize(size(px(320.), px(400.)));
    draw(cx);
    let banner = cx.debug_bounds("config-diagnostic").unwrap();
    assert!(banner.left() >= px(0.) && banner.right() <= px(320.));
}

#[gpui::test]
fn gui_config_warning_stacks_above_the_endpoint_card(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(1000.), px(600.)));
    let config = crate::config::Config {
        unknown_keys: vec!["future.key".into()],
        ..Default::default()
    };
    view.update(cx, |view, cx| {
        view.gui_config_diagnostic
            .sync(config.diagnostic().as_deref());
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("gui-config-diagnostic").is_some());
    assert!(cx.debug_bounds("config-diagnostic").is_none());

    set_diagnostic(&view, 0, Some("config.toml has unknown keys"), cx);
    let gui = cx.debug_bounds("gui-config-diagnostic").unwrap();
    let endpoint = cx.debug_bounds("config-diagnostic").unwrap();
    assert!(gui.bottom() <= endpoint.top());
    assert_eq!(gui.right(), endpoint.right());

    // Each card dismisses on its own.
    let dismiss = cx.debug_bounds("gui-config-diagnostic-dismiss").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    draw(cx);
    assert!(cx.debug_bounds("gui-config-diagnostic").is_none());
    assert!(cx.debug_bounds("config-diagnostic").is_some());

    // A reload that names no unknown keys clears it; new ones bring it back.
    view.update(cx, |view, _| {
        view.gui_config_diagnostic.sync(None);
        view.gui_config_diagnostic
            .sync(config.diagnostic().as_deref());
    });
    draw(cx);
    assert!(cx.debug_bounds("gui-config-diagnostic").is_some());
}

#[gpui::test]
fn stale_dismissal_cannot_hide_new_text(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    set_diagnostic(&view, 0, Some("old"), cx);
    let (id, generation, inbox, lines) = view.read_with(cx, |view, _| {
        let endpoint = &view.endpoints[0];
        (
            endpoint.id.clone(),
            endpoint.generation,
            endpoint.connection.inbox.clone(),
            endpoint.config_diagnostic.visible().unwrap().clone(),
        )
    });
    set_diagnostic(&view, 0, Some("new"), cx);
    view.update(cx, |view, cx| {
        view.dismiss_config_diagnostic(&id, generation, &inbox, &lines, cx);
        assert!(view.endpoints[0].config_diagnostic.visible().is_some());
        // A retired connection generation cannot dismiss either.
        let current = view.endpoints[0]
            .config_diagnostic
            .visible()
            .unwrap()
            .clone();
        view.dismiss_config_diagnostic(&id, generation + 1, &inbox, &current, cx);
        assert!(view.endpoints[0].config_diagnostic.visible().is_some());
        view.dismiss_config_diagnostic(&id, generation, &inbox, &current, cx);
        assert!(view.endpoints[0].config_diagnostic.visible().is_none());
    });
}
