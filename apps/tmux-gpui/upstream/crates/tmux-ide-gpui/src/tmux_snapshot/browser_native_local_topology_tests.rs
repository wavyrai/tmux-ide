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
    }
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
