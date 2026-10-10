use super::*;
use crate::browser::WebUrl;

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector}"));
    cx.simulate_click(bounds.center(), Modifiers::none());
    draw(cx);
}

fn first_group(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> GroupId {
    groups(view, cx)[0]
}

/// Workspace `w0` listening on every interface and on loopback alone.
fn seed_ports(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) {
    seed(
        view,
        cx,
        "L 1 *:3000 node\nL 1 127.0.0.1:5173 vite\nE 1 w0\n",
    );
}

fn seed(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, scan: &str) {
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.listening_ports.seed(
                crate::usage::Host::Local,
                crate::listening_ports::parse(scan).unwrap(),
            );
            cx.notify();
        })
    });
    draw(cx);
}

#[gpui::test]
fn plus_opens_a_terminal_tab_in_the_group_that_asked(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    draw(cx);
    let right = view.read_with(cx, |view, _| view.group_slots()[1].id);
    click(cx, "g1-new-tab");
    view.read_with(cx, |view, _| {
        // No menu: the tab is asked for at once, for the right group.
        assert!(view.menu.page.is_none());
        assert_eq!(view.expected_new_tab_group(), Some(right));
    });
}

/// A blank tab needs no native page, but only builds that show pages open
/// one rather than handing the request to the system browser.
#[cfg(any(target_os = "macos", windows))]
#[gpui::test]
fn a_new_browser_tab_opens_blank_in_the_group_that_asked(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    draw(cx);
    let right = view.read_with(cx, |view, _| view.group_slots()[1].id);
    click(cx, "g1-tab-actions");
    // Keyboard: the first row is New Browser Tab.
    cx.simulate_keystrokes("down enter");
    draw(cx);
    let picked = view.read_with(cx, |view, _| {
        assert!(view.menu.page.is_none());
        view.group_pick(right)
    });
    let Some(Pick::Page(id)) = picked else {
        panic!("the right group shows the new page, not {picked:?}")
    };
    let blank = cx.update(|_, cx| cx.global::<Store>().get(id).unwrap().location.is_none());
    assert!(blank);
    assert!(cx.debug_bounds("g1-browser-placeholder").is_some());
}

#[gpui::test]
fn review_is_offered_for_a_tracked_checkout(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    let group = first_group(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.git = crate::git::Git::fixture(
                crate::pull_request::Input {
                    checkout: None,
                    repo_key: Some("github.com/herdrdev/herdr-gpui".into()),
                    branch: "develop".into(),
                },
                crate::git::Status::default(),
            );
        })
    });
    assert_eq!(
        actions(&view, cx, group),
        [Action::NewBrowserTab, Action::Review, Action::Split]
    );
    run(&view, cx, group, Action::Review);
    view.read_with(cx, |view, _| {
        assert!(view.menu.page.is_none());
        assert_eq!(view.reviews.len(), 1);
    });
    // A second review of the same checkout brings its tab back.
    run(&view, cx, group, Action::Review);
    let reviews = cx.update(|_, cx| {
        cx.try_global::<Store>().map_or(0, |store| {
            (0..64)
                .filter_map(|id| store.get(crate::browser::TabId::test(id)))
                .filter(|tab| matches!(tab.location, Some(crate::browser::Location::Review { .. })))
                .count()
        })
    });
    assert_eq!(reviews, 1);
    view.read_with(cx, |view, _| assert_eq!(view.reviews.len(), 1));
}

#[gpui::test]
fn listening_ports_follow_the_tab_kinds(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    seed_ports(&view, cx);
    click(cx, "tab-actions");
    let group = first_group(&view, cx);
    let ports: Vec<_> = actions(&view, cx, group)
        .into_iter()
        .filter_map(|action| match action {
            Action::Port { link, process, .. } => Some((link.label(), process)),
            _ => None,
        })
        .collect();
    assert_eq!(
        ports,
        [
            ("localhost:3000".to_owned(), "node".to_owned()),
            ("localhost:5173".to_owned(), "vite".to_owned()),
        ]
    );
    let browser = cx.debug_bounds("group-menu-NewBrowserTab").unwrap();
    let first = cx.debug_bounds("group-menu-Port3000").unwrap();
    let split = cx.debug_bounds("group-menu-Split").unwrap();
    assert!(first.top() > browser.bottom());
    assert!(split.top() > first.bottom());
    // Hidden ports are not offered either.
    cx.simulate_keystrokes("escape");
    cx.update(|_, cx| view.update(cx, |view, _| view.config.show_listening_ports = false));
    assert_eq!(
        actions(&view, cx, group),
        [Action::NewBrowserTab, Action::Split]
    );
}

#[cfg(any(target_os = "macos", windows))]
#[gpui::test]
fn a_blank_tab_lists_the_listening_ports(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::NewBrowserTab, window, cx)
        })
    });
    draw(cx);
    assert!(cx.debug_bounds("browser-placeholder").is_some());
    assert!(cx.debug_bounds("blank-port-3000").is_none());
    seed_ports(&view, cx);
    let prompt = cx.debug_bounds("browser-placeholder").unwrap();
    let chip = cx.debug_bounds("blank-port-3000").unwrap();
    assert!(chip.top() > prompt.bottom());
    assert!(cx.debug_bounds("blank-port-5173").is_some());
}

#[test]
fn a_port_link_names_where_it_opens() {
    let page = Link::Page(WebUrl::try_from("http://localhost:5173/").unwrap());
    assert_eq!(page.label(), "localhost:5173");
    // The whole value stays in the row; only the selector is short.
    let action = Action::Port {
        number: 5173,
        process: "vite".into(),
        link: page,
    };
    assert_eq!(action.selector(), "group-menu-Port5173");
}

#[gpui::test]
fn a_long_process_name_leaves_the_port_address_readable(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    // The scan keeps at most 32 characters of a process name.
    let name = "w".repeat(32);
    seed(&view, cx, &format!("L 1 127.0.0.1:5173 {name}\nE 1 w0\n"));
    click(cx, "tab-actions");
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let row = cx.debug_bounds("group-menu-Port5173").unwrap();
    let address = cx.debug_bounds("group-menu-Port5173-label").unwrap();
    let process = cx.debug_bounds("group-menu-Port5173-detail").unwrap();
    assert!(process.size.width <= px(PROCESS_WIDTH), "{process:?}");
    assert!(address.right() <= process.left(), "{address:?} {process:?}");
    assert!(row.right() <= panel.right(), "{row:?} {panel:?}");
    // The address keeps most of the row rather than being squeezed out.
    assert!(address.size.width >= px(100.), "{address:?}");
    // A shortcut hint is not capped.
    let shortcut = cx.debug_bounds("group-menu-NewBrowserTab-detail").unwrap();
    assert!(shortcut.size.width > px(0.));
}

#[gpui::test]
fn the_keyboard_scrolls_a_long_menu_to_the_selected_row(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    let scan: String = (3000..3040)
        .map(|port| format!("L 1 127.0.0.1:{port} node\n"))
        .chain(["E 1 w0\n".to_owned()])
        .collect();
    // A short window, which the listed ports outgrow.
    cx.simulate_resize(size(px(1200.), px(500.)));
    seed(&view, cx, &scan);
    click(cx, "tab-actions");
    let panel = cx.debug_bounds("menu-panel").unwrap();
    // Split Right starts out of view.
    let split = cx.debug_bounds("group-menu-Split").unwrap();
    assert!(split.bottom() > panel.bottom(), "{split:?} {panel:?}");

    // Up wraps to the last row, which scrolls into the panel.
    cx.simulate_keystrokes("up");
    draw(cx);
    let split = cx.debug_bounds("group-menu-Split").unwrap();
    assert!(
        split.top() >= panel.top() && split.bottom() <= panel.bottom(),
        "{split:?} {panel:?}"
    );

    // Down wraps back to the first, which scrolls back up to it.
    cx.simulate_keystrokes("down");
    draw(cx);
    let first = cx.debug_bounds("group-menu-NewBrowserTab").unwrap();
    assert!(first.top() >= panel.top(), "{first:?} {panel:?}");
}

#[test]
fn the_listening_heading_shifts_the_rows_after_it() {
    let port = Action::Port {
        number: 3000,
        process: "node".into(),
        link: Link::Page(WebUrl::try_from("http://localhost:3000/").unwrap()),
    };
    let actions = [Action::NewBrowserTab, port, Action::Split];
    assert_eq!(child_index(&actions, 0), 0);
    assert_eq!(child_index(&actions, 1), 2);
    assert_eq!(child_index(&actions, 2), 3);
    assert_eq!(child_index(&actions[..1], 0), 0);
}
