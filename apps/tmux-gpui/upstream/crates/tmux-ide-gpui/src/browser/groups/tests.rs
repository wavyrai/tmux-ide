#![allow(clippy::unwrap_used)]
use super::*;
use Shown::*;

fn page(id: u64) -> Pick {
    Pick::Page(TabId::test(id))
}

fn herdr(id: &str) -> Pick {
    Pick::Herdr(id.into())
}

/// Every group's connection focusing the same tab, as before a split
/// connects the others.
fn shown(layout: &Layout, focused: &str) -> Vec<Shown> {
    each(layout, &[focused; 8])
}

/// Group `i`'s connection focusing `focused[i]`.
fn each(layout: &Layout, focused: &[&str]) -> Vec<Shown> {
    let slots: Vec<Slot> = layout.slots().collect();
    let focus = |group: GroupId| {
        slots
            .iter()
            .position(|slot| slot.id == group)
            .map(|index| focused[index].to_owned())
    };
    slots
        .iter()
        .map(|slot| layout.shown(slot.id, focus))
        .collect()
}

fn layout() -> (Layout, GroupIds, GroupId) {
    let mut ids = GroupIds::default();
    let first = ids.next();
    (Layout::new(first), ids, first)
}

#[test]
fn an_unsplit_layout_follows_the_terminal_until_a_page_is_picked() {
    let (mut layout, _, a) = layout();
    assert_eq!(shown(&layout, "t1"), [Terminal]);
    assert_eq!(layout.shown(a, |_| None), Terminal);
    layout.choose(a, page(1));
    assert_eq!(shown(&layout, "t1"), [Page(TabId::test(1))]);
    layout.choose(a, herdr("t1"));
    assert_eq!(shown(&layout, "t1"), [Terminal]);
    // Picking a Herdr tab its connection does not focus waits for it.
    layout.choose(a, herdr("t2"));
    assert_eq!(shown(&layout, "t1"), [Elsewhere(herdr("t2"))]);
    assert_eq!(shown(&layout, "t2"), [Terminal]);
}

#[test]
fn groups_show_different_herdr_tabs_through_their_own_connections() {
    let (mut layout, mut ids, a) = layout();
    let (b, c) = (ids.next(), ids.next());
    assert!(layout.split(a, b, Some("t1")));
    assert!(layout.split(b, c, Some("t1")));
    layout.choose(b, herdr("t2"));
    layout.choose(c, page(7));
    assert_eq!(
        each(&layout, &["t1", "t2", "t1"]),
        [Terminal, Terminal, Page(TabId::test(7))]
    );
    // A connection still on its way to the tab stands in for it.
    assert_eq!(
        each(&layout, &["t1", "t1", "t1"]),
        [Terminal, Elsewhere(herdr("t2")), Page(TabId::test(7))]
    );
    // Only groups holding a Herdr tab need a connection.
    assert_eq!(
        layout.terminal_holders(),
        [(a, "t1".to_owned()), (b, "t2".to_owned())]
    );
}

#[test]
fn one_tab_is_live_in_the_latest_group_to_use_it() {
    let (mut layout, mut ids, a) = layout();
    let b = ids.next();
    assert!(layout.split(a, b, Some("t1")));
    assert_eq!(layout.len(), 2);
    assert_eq!(layout.active(), b);
    assert_eq!(shown(&layout, "t1"), [Elsewhere(herdr("t1")), Terminal]);
    assert_eq!(layout.terminal_holders(), [(b, "t1".to_owned())]);
    assert_eq!(layout.share(a), 0.5);
    assert!(layout.activate(a));
    assert!(!layout.activate(a));
    assert_eq!(shown(&layout, "t1"), [Terminal, Elsewhere(herdr("t1"))]);
    layout.choose(b, page(1));
    layout.choose(a, page(1));
    assert_eq!(
        shown(&layout, "t1"),
        [Page(TabId::test(1)), Elsewhere(page(1))]
    );
    assert!(!layout.split(ids.next(), ids.next(), Some("t1")));
}

#[test]
fn closing_groups_hands_on_width_and_use() {
    let (mut layout, mut ids, a) = layout();
    let (b, c) = (ids.next(), ids.next());
    layout.split(a, b, Some("t1"));
    layout.split(b, c, Some("t1"));
    assert_eq!(layout.share(b), 0.25);
    assert!(layout.close(c));
    assert_eq!(layout.active(), b);
    assert_eq!(layout.share(b), 0.5);
    assert!(layout.close(a));
    assert_eq!(layout.share(b), 1.);
    assert!(!layout.close(b));
    assert_eq!(layout.len(), 1);
}

#[test]
fn dividers_drag_between_neighbours_only() {
    let (mut layout, mut ids, a) = layout();
    let (b, c) = (ids.next(), ids.next());
    layout.split(a, b, Some("t1"));
    layout.split(b, c, Some("t1"));
    // Shares 0.5, 0.25, 0.25: the second divider sits at 0.75.
    assert!(layout.drag(1, 600., 1000.));
    assert!((layout.share(b) - 0.1).abs() < 1e-6);
    assert!((layout.share(c) - 0.4).abs() < 1e-6);
    assert_eq!(layout.share(a), 0.5);
    assert!(layout.drag(0, 0., 1000.));
    assert_eq!(layout.share(a), MIN_SHARE);
    assert!(!layout.drag(2, 10., 1000.));
    assert!(!layout.drag(0, f32::NAN, 1000.));
    assert!(!layout.drag(0, 10., 0.));
}

#[test]
fn a_connections_focus_moves_only_its_own_group() {
    let (mut layout, mut ids, a) = layout();
    let b = ids.next();
    // Alone, a group follows the terminal.
    layout.focus_moved(a, "t9");
    assert_eq!(layout.pick(a, Some("t2")), Some(herdr("t2")));
    layout.split(a, b, Some("t1"));
    layout.choose(b, herdr("t2"));
    layout.focus_moved(a, "t3");
    assert_eq!(layout.pick(a, None), Some(herdr("t3")));
    assert_eq!(layout.pick(b, None), Some(herdr("t2")));
    layout.choose(a, page(1));
    layout.focus_moved(a, "t4");
    assert_eq!(layout.pick(a, None), Some(herdr("t4")));
}

#[test]
fn closed_tabs_leave_every_group_that_picked_them() {
    let (mut layout, mut ids, a) = layout();
    let b = ids.next();
    layout.split(a, b, Some("t1"));
    layout.choose(a, page(1));
    layout.choose(b, page(1));
    assert!(layout.replace(&page(1), Some(page(2)), Some("t1")));
    assert_eq!(layout.picks().collect::<Vec<_>>(), [&page(2), &page(2)]);
    assert!(layout.replace(&page(2), None, Some("t1")));
    assert!(!layout.replace(&page(2), None, Some("t1")));
    assert_eq!(shown(&layout, "t1"), [Elsewhere(herdr("t1")), Terminal]);
    // Alone, a group whose tab closed follows the terminal again.
    layout.close(a);
    layout.choose(b, page(3));
    assert!(layout.replace(&page(3), None, Some("t1")));
    assert_eq!(layout.pick(b, Some("t5")), Some(herdr("t5")));
}

#[test]
fn layouts_round_trip_through_their_saved_form() {
    let (mut split, mut ids, a) = layout();
    assert_eq!(split.saved(), None);
    let (b, c) = (ids.next(), ids.next());
    split.split(a, b, Some("t1"));
    split.split(b, c, Some("t1"));
    split.choose(a, herdr("t2"));
    split.choose(c, page(4));
    split.activate(b);
    let saved = split.saved().unwrap();
    assert!(saved.valid());
    let json = serde_json::to_string(&saved).unwrap();
    assert!(json.contains(r#"{"kind":"herdr","id":"t2"}"#), "{json}");
    let restored = Layout::restore(&serde_json::from_str(&json).unwrap(), &mut ids);
    assert_eq!(restored.saved(), Some(saved));
    assert_eq!(restored.len(), 3);
    // Fresh IDs, and the group in use is the second one again.
    let slots: Vec<Slot> = restored.slots().collect();
    assert!(slots.iter().all(|slot| ![a, b, c].contains(&slot.id)));
    assert_eq!(restored.active(), slots[1].id);
    // Each terminal group shows its own tab through its connection.
    assert_eq!(
        each(&restored, &["t2", "t1", "t1"]),
        [Terminal, Terminal, Page(TabId::test(4))]
    );
    // A lone group on a page is worth keeping too.
    let (mut lone, _, a) = layout();
    lone.choose(a, page(1));
    assert!(lone.saved().is_some());
}

#[test]
fn saved_layouts_the_app_could_not_have_written_are_refused() {
    let group = |pick: Option<Pick>, share: f32| SavedGroup {
        pick,
        share,
        hidden: Vec::new(),
    };
    let valid = SavedLayout {
        groups: vec![group(None, 0.5), group(Some(herdr("t1")), 0.5)],
        active: 1,
    };
    assert!(valid.valid());
    for invalid in [
        SavedLayout {
            groups: vec![],
            active: 0,
        },
        SavedLayout {
            active: 2,
            ..valid.clone()
        },
        SavedLayout {
            groups: vec![group(None, f32::NAN)],
            active: 0,
        },
        SavedLayout {
            groups: vec![group(None, 0.)],
            active: 0,
        },
        SavedLayout {
            groups: vec![group(Some(herdr("")), 1.)],
            active: 0,
        },
        SavedLayout {
            groups: vec![group(Some(herdr(&"x".repeat(300))), 1.)],
            active: 0,
        },
        SavedLayout {
            groups: vec![group(None, 1.); MAX_SAVED_GROUPS + 1],
            active: 0,
        },
    ] {
        assert!(!invalid.valid(), "{invalid:?}");
    }
}

#[test]
fn closing_a_tab_in_a_group_leaves_it_open_everywhere_else() {
    let (mut layout, mut ids, a) = layout();
    let (b, c) = (ids.next(), ids.next());
    layout.split(a, b, Some("t1"));
    layout.hide(b, [herdr("t2"), page(1)]);
    assert!(layout.lists(a, &herdr("t2"), b));
    assert!(!layout.lists(b, &herdr("t2"), b));
    // A split lists what its source lists.
    layout.split(b, c, Some("t1"));
    assert!(!layout.lists(c, &page(1), c));
    // Closed in every group, a tab stays in the group in use.
    layout.hide(a, [page(1)]);
    assert!(layout.lists(c, &page(1), c));
    assert!(!layout.lists(a, &page(1), c));
    // Picking it again brings it back to that group.
    layout.choose(a, page(1));
    assert!(layout.lists(a, &page(1), c));
    // Saved and restored with the layout; gone tabs are forgotten.
    let saved = layout.saved().unwrap();
    assert!(saved.valid());
    let restored = Layout::restore(&saved, &mut ids);
    assert_eq!(restored.saved(), Some(saved));
    layout.forget_hidden(|pick| *pick != herdr("t2"));
    assert!(layout.lists(b, &herdr("t2"), b));
}

#[test]
fn selectors_keep_their_names_in_the_first_group() {
    let (_, mut ids, _) = layout();
    let mut slot = |index| Slot {
        id: ids.next(),
        index,
    };
    assert_eq!(slot(0).selector("tab-t0"), "tab-t0");
    assert_eq!(slot(2).selector("tab-t0"), "g2-tab-t0");
}
