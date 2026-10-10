use super::*;

#[gpui::test]
fn listening_ports_ride_under_their_row_without_resizing_it(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let (id, label, next) = cx.update(|_, cx| {
        let snapshot = view.read(cx).live.snapshot.clone().unwrap();
        let [first, second, ..] = snapshot.workspaces.as_slice() else {
            panic!("the fixture lists several workspaces");
        };
        (
            first.workspace_id.clone(),
            first.label.clone(),
            second.label.clone(),
        )
    });
    let row = cx.debug_bounds(format!("row-{label}").leak()).unwrap();
    let below = cx.debug_bounds(format!("row-{next}").leak()).unwrap();
    // Probe names are static; leaking a few in a test is fine.
    let ports_line: &'static str = format!("ports-local-{id}").leak();
    assert!(cx.debug_bounds(ports_line).is_none());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let ports = format!("L 1 *:3000 node\nL 1 127.0.0.1:5173 vite\nE 1 {id}\n");
            view.listening_ports.seed(
                crate::usage::Host::Local,
                crate::listening_ports::parse(&ports).unwrap(),
            );
            cx.notify();
        })
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let line = cx.debug_bounds(ports_line).unwrap();
    let chip = cx
        .debug_bounds(format!("port-local-{id}-3000").leak())
        .unwrap();
    assert!(
        cx.debug_bounds(format!("port-local-{id}-5173").leak())
            .is_some()
    );
    let seeded = cx.debug_bounds(format!("row-{label}").leak()).unwrap();
    // The row keeps its size; the ports take a line of their own beneath it,
    // and the rows after it make room.
    assert_eq!(seeded, row);
    assert_eq!(line.top(), row.bottom());
    assert!(line.left() >= row.left() && line.right() <= row.right());
    assert!(chip.left() > line.left() && chip.right() <= line.right());
    let moved = cx.debug_bounds(format!("row-{next}").leak()).unwrap();
    assert_eq!(moved.top(), below.top() + line.size.height);
    // Turning the feature off takes the line away again.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.config.show_listening_ports = false;
            cx.notify();
        })
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds(ports_line).is_none());
    assert_eq!(
        cx.debug_bounds(format!("row-{next}").leak()).unwrap(),
        below
    );
}
