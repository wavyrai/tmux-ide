use super::*;
use crate::config::SelectMode;
use std::collections::BTreeMap;

/// A local host beside a remote one named `Remote`, whose workspace is
/// `remote workspace` and whose agent pane is `r0`, so each host's rows can
/// be told apart by probe. Returns the selectors that carried a wash.
fn washed(
    cx: &mut gpui::TestAppContext,
    mode: crate::config::LayoutMode,
    select: SelectMode,
    hosts: &[(&str, u32)],
    selected_endpoint: usize,
) -> Vec<&'static str> {
    let hosts: BTreeMap<String, u32> = hosts
        .iter()
        .map(|(name, color)| ((*name).to_owned(), *color))
        .collect();
    let (_fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            view.config.layout.mode = mode;
            view.config.sidebar_style.select = select;
            view.config.sidebar_style.hosts = hosts;
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:test".into(),
                "Remote".into(),
                ConnectTarget::Ssh {
                    target: "unused".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live.snapshot = view.live.snapshot.clone();
            // The selected host draws the window's own live snapshot, so the
            // remote's names go wherever the remote will read them from.
            let snapshot = if selected_endpoint == 1 {
                &mut view.live.snapshot
            } else {
                &mut remote.live.snapshot
            };
            let snapshot = Arc::make_mut(snapshot.as_mut().unwrap());
            snapshot.workspaces[0].label = "remote workspace".into();
            snapshot.agents[0].pane_id = "r0".into();
            view.endpoints.push(remote);
            view.selected_endpoint = selected_endpoint;
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    [
        "wash-host-local",
        "wash-herdr",
        "wash-agent-p0",
        "wash-host-ssh:test",
        "wash-remote workspace",
        "wash-agent-r0",
    ]
    .into_iter()
    .filter(|selector| cx.debug_bounds(selector).is_some())
    .collect()
}

const REMOTE_ROWS: [&str; 3] = [
    "wash-host-ssh:test",
    "wash-remote workspace",
    "wash-agent-r0",
];
const LOCAL_ROWS: [&str; 3] = ["wash-host-local", "wash-herdr", "wash-agent-p0"];

/// A configured colour washes the host's header, its workspace rows, and
/// its agents' rows, and no one else's, in every layout.
#[gpui::test]
fn a_host_colour_washes_only_that_hosts_rows(cx: &mut gpui::TestAppContext) {
    for mode in crate::config::LayoutMode::ALL {
        assert_eq!(
            washed(cx, mode, SelectMode::Row, &[("Remote", 0x336699)], 0),
            REMOTE_ROWS,
            "{mode}"
        );
        assert!(
            washed(cx, mode, SelectMode::Row, &[], 0).is_empty(),
            "{mode}: nothing configured, nothing washed"
        );
    }
}

/// In the group modes the selected host is always washed, with or without a
/// colour of its own; the other host keeps only its configured colour.
#[gpui::test]
fn group_modes_wash_the_selected_host(cx: &mut gpui::TestAppContext) {
    let mode = crate::config::LayoutMode::default();
    for select in [SelectMode::Group, SelectMode::GroupDim] {
        // Local selected, no colour anywhere: only local is washed.
        assert_eq!(washed(cx, mode, select, &[], 0), LOCAL_ROWS, "{select:?}");
        // Remote selected and coloured, local uncoloured: only remote.
        assert_eq!(
            washed(cx, mode, select, &[("Remote", 0x336699)], 1),
            REMOTE_ROWS,
            "{select:?}"
        );
        // Local selected while remote is coloured: both show.
        let mut both = LOCAL_ROWS.to_vec();
        both.extend(REMOTE_ROWS);
        assert_eq!(
            washed(cx, mode, select, &[("Remote", 0x336699)], 0),
            both,
            "{select:?}"
        );
    }
}

/// The wash is a layer of the row, the size of its highlight, under it.
#[gpui::test]
fn the_wash_paints_beneath_the_highlight(cx: &mut gpui::TestAppContext) {
    let (_fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            view.config.sidebar_style.hosts =
                BTreeMap::from([(view.endpoints[0].label.clone(), 0x336699)]);
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let wash = cx.debug_bounds("wash-herdr").unwrap();
    let highlight = cx.debug_bounds("highlight-herdr").unwrap();
    let row = cx.debug_bounds("row-herdr").unwrap();
    assert_eq!(wash, highlight, "the wash covers exactly the highlight");
    assert!(row.contains(&wash.center()));
}
