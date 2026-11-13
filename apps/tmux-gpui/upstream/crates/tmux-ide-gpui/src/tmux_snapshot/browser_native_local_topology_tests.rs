use super::*;
use herdr_client::tmux_topology::Layout;

fn attached() -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = fixture();
    let ServerRegistration::Online { scope, .. } = registration() else {
        unreachable!()
    };
    local.state.surface = Surface::Workspace;
    local.state.request = 5;
    local.presence_revision = 3;
    local.state.selected_session = Some("live".into());
    local.state.selected_pane = Some("left".into());
    local.state.panes = ["left", "right"]
        .into_iter()
        .map(|id| Choice {
            id: id.into(),
            label: id.into(),
            pane_count: None,
            window_id: None,
            browser_icon: None,
            display_name_source: None,
            window_label: None,
        })
        .collect();
    local.active = Some(Route {
        id: "attachment".into(),
        request: 5,
        target: Target {
            scope,
            live: "live".into(),
        },
        workspace: "fixture".into(),
    });
    (local, events)
}
fn layout() -> Layout {
    serde_json::from_value(serde_json::json!({"type":"layout","semanticWindowId":"window", "windowName":"Editor",
        "currentWindow":true,"cols":80,"rows":24,"zoomed":false,
        "panes":[{"pane":"right","displayName":"Build","left":40,"top":0,"width":40,"height":24,"active":false},
        {"pane":"left","displayName":"Shell","left":0,"top":0,"width":40,"height":24,"active":true}]})).unwrap()
}
fn notice(local: &Local, layouts: Vec<Layout>) -> Command {
    Command::NativeTerminalCatalog {
        version: 1,
        id: "attachment".into(),
        request: 5,
        pane: "left".into(),
        live_session_id: "live".into(),
        generation: local
            .active
            .as_ref()
            .unwrap()
            .target
            .scope
            .generation
            .clone(),
        presence_revision: 3,
        layouts,
        issued: None,
    }
}
/// The notice of a stream that follows pane changes in place: `panes` is its
/// whole set, `selected` its selected pane.
fn in_place(local: &Local, layouts: Vec<Layout>, panes: &[&str], selected: &str) -> Command {
    let Command::NativeTerminalCatalog {
        version,
        id,
        request,
        live_session_id,
        generation,
        presence_revision,
        layouts,
        ..
    } = notice(local, layouts)
    else {
        unreachable!()
    };
    Command::NativeTerminalCatalog {
        version,
        id,
        request,
        pane: selected.into(),
        live_session_id,
        generation,
        presence_revision,
        layouts,
        issued: Some(panes.iter().map(|pane| (*pane).to_owned()).collect()),
    }
}
fn layout_of(panes: &[(&str, &str)]) -> Layout {
    let rows: Vec<serde_json::Value> = (panes.iter().enumerate())
        .map(|(index, (pane, name))| serde_json::json!({"pane":pane,"displayName":name,"left":index * 10,"top":0,"width":9,"height":24,"active":index == 0}))
        .collect();
    serde_json::from_value(
        serde_json::json!({"type":"layout","semanticWindowId":"window","windowName":"Editor",
        "currentWindow":true,"cols":80,"rows":24,"zoomed":false,"panes":rows}),
    )
    .unwrap()
}
fn ids(local: &Local) -> Vec<&str> {
    local.state.panes.iter().map(|p| p.id.as_str()).collect()
}

/// #723: another client split a pane in and the stream stayed open. The
/// catalog's pane list (the pane choices, and the panes of the next lease)
/// follows the stream. Without this the notice was dropped as "not the
/// issued set" and the list went stale.
#[test]
fn a_stream_that_followed_a_split_brings_its_new_pane_to_the_catalog() {
    let (mut local, events) = attached();
    let layout = layout_of(&[("left", "Shell"), ("right", "Build"), ("third", "Logs")]);
    let command = in_place(&local, vec![layout], &["left", "right", "third"], "left");
    local.command(command).unwrap();
    assert_eq!(ids(&local), ["left", "right", "third"]);
    assert_eq!(local.state.panes[2].label, "Logs");
    assert_eq!(local.state.selected_pane.as_deref(), Some("left"));
    assert!(events.try_recv().is_ok());
}

#[test]
fn a_stream_that_followed_a_close_drops_the_pane_and_moves_a_lost_selection() {
    // The pane that is not selected closed.
    let (mut local, _events) = attached();
    let command = in_place(
        &local,
        vec![layout_of(&[("left", "Shell")])],
        &["left"],
        "left",
    );
    local.command(command).unwrap();
    assert_eq!(ids(&local), ["left"]);
    assert_eq!(local.state.selected_pane.as_deref(), Some("left"));
    // The selected pane closed: the stream's selected pane takes over.
    let (mut local, _events) = attached();
    let command = in_place(
        &local,
        vec![layout_of(&[("right", "Build")])],
        &["right"],
        "right",
    );
    local.command(command).unwrap();
    assert_eq!(ids(&local), ["right"]);
    assert_eq!(local.state.selected_pane.as_deref(), Some("right"));
}

/// A selection the user made arrives by its own acknowledgement. A notice
/// that merely names another pane of the same set does not move it.
#[test]
fn a_notice_naming_another_selected_pane_of_the_same_set_changes_nothing() {
    let (mut local, events) = attached();
    let command = in_place(&local, vec![layout()], &["left", "right"], "right");
    local.command(command).unwrap();
    assert_eq!(local.state.selected_pane.as_deref(), Some("left"));
    assert_eq!(local.state.panes[0].label, "left", "labels were taken");
    assert!(events.try_recv().is_err());
}

#[test]
fn a_pane_set_no_stream_can_have_is_not_taken() {
    let many: Vec<String> = (0..25).map(|n| format!("pane{n}")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    for (panes, selected) in [
        (vec![], "left"),
        (vec!["left", "left"], "left"),
        (vec!["left", "third"], "right"),
        (many, "pane0"),
    ] {
        let (mut local, events) = attached();
        let command = in_place(&local, vec![layout()], &panes, selected);
        local.command(command).unwrap();
        assert_eq!(ids(&local), ["left", "right"], "{panes:?}");
        assert_eq!(local.state.selected_pane.as_deref(), Some("left"));
        assert!(events.try_recv().is_err());
    }
}

/// A stream whose set is the lease's (a daemon without 119) is judged as
/// before: a layout with another pane set is dropped.
#[test]
fn without_the_capability_a_layout_with_another_pane_set_is_still_dropped() {
    let (mut local, events) = attached();
    let layout = layout_of(&[("left", "Shell"), ("right", "Build"), ("third", "Logs")]);
    local.command(notice(&local, vec![layout])).unwrap();
    assert_eq!(ids(&local), ["left", "right"]);
    assert!(events.try_recv().is_err());
}
#[test]
fn native_topology_updates_labels_and_order_without_changing_selection() {
    let (mut local, events) = attached();
    local.command(notice(&local, vec![layout()])).unwrap();
    assert_eq!(local.state.panes[0].id, "right");
    assert_eq!(local.state.panes[0].label, "Build");
    assert_eq!(local.state.panes[0].window_label.as_deref(), Some("Editor"));
    assert_eq!(local.state.selected_pane.as_deref(), Some("left"));
    assert!(local.state.session_catalog_complete);
    assert!(events.try_recv().is_ok());
    local.command(notice(&local, vec![layout()])).unwrap();
    assert!(events.try_recv().is_err());
}
#[test]
fn stale_or_background_topology_cannot_publish() {
    for case in 0..9 {
        let (mut local, events) = attached();
        let mut command = notice(&local, vec![layout()]);
        let Command::NativeTerminalCatalog {
            version,
            id,
            request,
            pane,
            live_session_id,
            generation,
            presence_revision,
            ..
        } = &mut command
        else {
            unreachable!()
        };
        match case {
            0 => *version = 2,
            1 => *id = "retired".into(),
            2 => *request = 4,
            3 => *pane = "right".into(),
            4 => *live_session_id = "other".into(),
            5 => *generation = uuid::Uuid::new_v4().to_string(),
            6 => *presence_revision = 2,
            7 => local.foreground = false,
            _ => local.state.surface = Surface::Home,
        }
        local.command(command).unwrap();
        assert_eq!(local.state.panes[0].label, "left");
        assert!(events.try_recv().is_err());
    }
}
#[test]
fn partial_duplicate_or_unknown_inventory_cannot_publish() {
    for case in 0..4 {
        let (mut local, events) = attached();
        let mut window = layout();
        match case {
            0 => {
                window.panes.pop();
            }
            1 => window.panes.push(window.panes[0].clone()),
            2 => window.panes[0].pane = Some("foreign".into()),
            _ => window.panes.clear(),
        }
        local.command(notice(&local, vec![window])).unwrap();
        assert_eq!(local.state.panes[0].label, "left");
        assert!(events.try_recv().is_err());
    }
}
#[test]
fn labels_are_bounded_cleaned_and_have_fallbacks() {
    let (mut local, _events) = attached();
    let mut window = layout();
    window.window_name = Some("\n\t".into());
    window.panes[0].display_name = Some("😀".repeat(200));
    window.panes[1].display_name = Some(" shell\u{7f}label\u{9f} ".into());
    local.command(notice(&local, vec![window])).unwrap();
    assert_eq!(local.state.panes[0].label.len(), 512);
    assert_eq!(local.state.panes[0].window_label.as_deref(), Some("Window"));
    assert_eq!(local.state.panes[1].label, "shell label");
}
#[test]
fn each_panes_name_source_reaches_its_choice() {
    use crate::tmux_snapshot::browser::NameSource;
    use herdr_client::tmux_topology::DisplayNameSource;
    let (mut local, _events) = attached();
    let mut window = layout();
    window.panes[0].display_name_source = Some(DisplayNameSource::Process);
    window.panes[1].display_name_source = Some(DisplayNameSource::Generated);
    local.command(notice(&local, vec![window])).unwrap();
    let sources: Vec<_> = local
        .state
        .panes
        .iter()
        .map(|p| (p.id.as_str(), p.display_name_source))
        .collect();
    assert_eq!(
        sources,
        [
            ("right", Some(NameSource::Process)),
            ("left", Some(NameSource::Generated)),
        ]
    );
}
