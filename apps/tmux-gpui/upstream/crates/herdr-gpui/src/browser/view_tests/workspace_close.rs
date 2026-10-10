use super::*;

#[gpui::test]
fn tabs_of_a_closed_workspace_are_forgotten_but_a_restart_keeps_them(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = window(cx);
    let tab_scope = view.read_with(cx, |view, _| scope(&view.endpoints[0]));
    let open = |cx: &mut VisualTestContext, workspace: &str| {
        cx.update(|_, cx| {
            Store::update(cx, |store| {
                store.open(
                    tab_scope.clone(),
                    workspace,
                    Some(url("https://a.test/")),
                    None,
                )
            })
            .unwrap()
        })
    };
    let (kept, closed) = (open(cx, "w0"), open(cx, "w2"));
    let exists =
        |cx: &mut VisualTestContext, id| cx.update(|_, cx| cx.global::<Store>().get(id).is_some());
    let poll = |view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, boot: &str, count| {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                let mut next = snapshot(count);
                next.boot_id = boot.into();
                next.focused_workspace_id = Some("w0".into());
                view.live.snapshot = Some(Arc::new(next));
                view.poll_browser(window, cx);
            })
        });
    };
    poll(&view, cx, "boot-1", 3);
    // A daemon that restarted without w2 proves nothing about w2.
    poll(&view, cx, "boot-2", 2);
    assert!(exists(cx, closed));
    poll(&view, cx, "boot-2", 3);
    // The same daemon dropping w2 means it was closed.
    poll(&view, cx, "boot-2", 2);
    assert!(!exists(cx, closed));
    assert!(exists(cx, kept));
}
