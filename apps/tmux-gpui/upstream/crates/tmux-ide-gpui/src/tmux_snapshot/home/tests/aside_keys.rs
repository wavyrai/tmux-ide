//! #359 review: a machine header's text actions are still controls, as the
//! Bezel button before them was: a tab stop each in the window's focus
//! order, Bezel's Activate (Enter and Space where Bezel's keys are bound)
//! presses them, a focus ring, and a disabled one ignores presses.
//!
//! The app binds neither Bezel's tab traversal nor its Activate keys, and
//! Home's own Tab cycles its action row, so the tests drive gpui's focus
//! order and the Activate action directly. Home's keyboard routes are D on
//! a table row (that row's server for new sessions) and the F5 palette
//! (Disconnect), which their own tests cover.
use super::*;

fn fleet_home(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1400.), px(1400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}

/// Steps the window's focus order until `selector` holds keyboard focus;
/// false if it never does.
fn tab_to(cx: &mut VisualTestContext, selector: &str) -> bool {
    // debug_bounds takes a 'static selector.
    let marker: &'static str = Box::leak(format!("{selector}:focused").into_boxed_str());
    for _ in 0..80 {
        cx.update(|window, cx| {
            window.focus_next(cx);
            window.draw(cx).clear(cx);
        });
        if cx.debug_bounds(marker).is_some() {
            return true;
        }
    }
    false
}

#[gpui::test]
fn header_text_actions_take_focus_and_activate_from_the_keyboard(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    assert!(
        tab_to(cx, "fleet-disconnect-0"),
        "Disconnect has a tab stop"
    );
    receiver.try_iter().for_each(drop);
    cx.dispatch_action(bezel_ui::focus::Activate);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetDisconnect { .. }
    ));
    assert!(receiver.try_recv().is_err());
    assert!(
        tab_to(cx, "fleet-use-server-action-0-0"),
        "Use for new sessions has a tab stop"
    );
    let token = view.read_with(cx, |v, _| {
        v.browser_state.fleet.as_ref().unwrap().groups[0].servers[0]
            .selection
            .clone()
            .unwrap()
    });
    receiver.try_iter().for_each(drop);
    cx.dispatch_action(bezel_ui::focus::Activate);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetServer { selection, .. } if selection == token
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn a_disabled_header_action_ignores_presses(cx: &mut TestAppContext) {
    let (view, cx, receiver) = fleet_home(cx);
    // A publication for another request: the action would act on stale state.
    cx.update(|window, cx| {
        view.update(cx, |v, _| v.browser_state.request += 1);
        window.draw(cx).clear(cx);
    });
    let link = cx.debug_bounds("fleet-use-server-action-0-0").unwrap();
    cx.simulate_click(link.center(), Modifiers::default());
    assert!(
        !receiver
            .try_iter()
            .any(|c| matches!(c, browser::Command::FleetServer { .. }))
    );
    assert!(!tab_to(cx, "fleet-use-server-action-0-0"), "no tab stop");
}
