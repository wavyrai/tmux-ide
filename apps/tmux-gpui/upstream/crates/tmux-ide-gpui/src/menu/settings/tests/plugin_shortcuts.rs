#![allow(clippy::unwrap_used)]
use crate::{
    HerdrWindow,
    keymap::{DaemonKeys, Keymap},
    state::ConnectionStatus,
};
use gpui::{Entity, VisualTestContext};
use herdr_client::protocol::{ClientShellCommand, ClientShellCommandAction};
use std::sync::Arc;

fn command(
    id: &str,
    description: Option<&str>,
    action: ClientShellCommandAction,
    labels: &[&str],
) -> ClientShellCommand {
    ClientShellCommand {
        command_id: id.into(),
        description: description.map(str::to_owned),
        action,
        binding_label: labels.join(" / "),
        binding_labels: labels.iter().map(|label| (*label).to_owned()).collect(),
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn search(view: &Entity<HerdrWindow>, query: &str, cx: &mut VisualTestContext) {
    view.update(cx, |view, cx| {
        view.menu
            .keybinds_search
            .as_ref()
            .unwrap()
            .update(cx, |input, cx| {
                input.set_text_selected(query, cx);
            });
        view.menu.keybinds_scroll.set_offset(Default::default());
        cx.notify();
    });
    draw(cx);
}

fn install(
    view: &Entity<HerdrWindow>,
    commands: Vec<ClientShellCommand>,
    cx: &mut VisualTestContext,
) {
    view.update(cx, |view, cx| {
        let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
        snapshot.commands = commands;
        view.live.status = ConnectionStatus::Connected;
        cx.notify();
    });
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn plugin_shortcuts_keep_all_actions_and_unusable_bindings_visible(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    install(
        &view,
        vec![
            command(
                "plugin.audit",
                Some("Audit review"),
                ClientShellCommandAction::PluginAction,
                &[
                    "prefix+y",
                    "ctrl+alt+a",
                    "prefix+c",
                    "cmd+t",
                    "hyper+a",
                    "CTRL+hyper+Y",
                ],
            ),
            command(
                "shell.run",
                Some("Run shell task"),
                ClientShellCommandAction::Shell,
                &["ctrl+alt+r"],
            ),
            command(
                "pane.run",
                Some(""),
                ClientShellCommandAction::Pane,
                &["prefix+u"],
            ),
            command("popup.run", None, ClientShellCommandAction::Popup, &[]),
        ],
        cx,
    );
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_keybinds(window, cx)));
    search(&view, "plugin custom commands", cx);
    for description in ["Audit review", "Run shell task", "pane.run", "popup.run"] {
        assert!(
            cx.debug_bounds(format!("shortcut-{description}").leak())
                .is_some(),
            "missing {description}"
        );
    }
    // Keycaps read in GPUI's platform spelling (`super-t` on Linux).
    let new_tab = gpui::Keystroke::parse("cmd-t").unwrap().unparse();
    for query in ["ctrl+b c", new_tab.as_str(), "hyper+a", "ctrl+hyper+y"] {
        search(&view, query, cx);
        assert!(
            cx.debug_bounds("shortcut-Audit review").is_some(),
            "lost unavailable binding {query}"
        );
    }
    search(&view, "New Workspace", cx);
    assert!(
        cx.debug_bounds("shortcut-New Workspace").is_some(),
        "builtin shortcuts must remain"
    );
}

#[gpui::test]
fn plugin_shortcuts_keep_bindings_beyond_the_dispatch_limit_searchable(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    install(
        &view,
        vec![command(
            "plugin.aliases",
            Some("Many aliases"),
            ClientShellCommandAction::PluginAction,
            &[
                "ctrl+alt+a",
                "ctrl+alt+b",
                "ctrl+alt+c",
                "ctrl+alt+d",
                "ctrl+alt+e",
                "ctrl+alt+f",
                "ctrl+alt+g",
                "ctrl+alt+h",
                "ctrl+alt+z",
            ],
        )],
        cx,
    );
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_keybinds(window, cx)));
    search(&view, "ctrl+alt+a", cx);
    assert!(cx.debug_bounds("shortcut-Many aliases").is_some());
    search(&view, "ctrl+alt+z", cx);
    assert!(
        cx.debug_bounds("shortcut-Many aliases").is_some(),
        "configured aliases beyond the dispatch limit must remain visible"
    );
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn plugin_shortcuts_search_description_section_and_active_prefix(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    install(
        &view,
        vec![command(
            "plugin.audit",
            Some("Audit review"),
            ClientShellCommandAction::PluginAction,
            &["prefix+y", "ctrl+alt+a"],
        )],
        cx,
    );
    view.update(cx, |view, _| {
        let keys = DaemonKeys::from_profile(Some("[keys]\nprefix = 'ctrl+a'\n")).unwrap();
        view.config.keybindings =
            Keymap::with_overrides(&Default::default(), &Default::default(), &keys).unwrap();
    });
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_keybinds(window, cx)));
    for query in [
        "audit review",
        "plugin custom commands",
        "ctrl+a y",
        "ctrl+alt+a",
    ] {
        search(&view, query, cx);
        assert!(
            cx.debug_bounds("shortcut-Audit review").is_some(),
            "search missed {query}"
        );
    }
    search(&view, "ctrl+b y", cx);
    assert!(
        cx.debug_bounds("shortcut-Audit review").is_none(),
        "old prefix must not match"
    );
    search(&view, "no-shortcut-matches-xyz", cx);
    assert!(cx.debug_bounds("keybinds-empty").is_some());
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn plugin_shortcuts_follow_snapshot_replacement_removal_and_disconnect(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let custom = |description| {
        command(
            "plugin.audit",
            Some(description),
            ClientShellCommandAction::PluginAction,
            &["prefix+y"],
        )
    };
    install(&view, vec![custom("Old audit")], cx);
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_keybinds(window, cx)));
    search(&view, "plugin custom commands", cx);
    assert!(cx.debug_bounds("shortcut-Old audit").is_some());
    install(&view, vec![custom("New audit")], cx);
    draw(cx);
    assert!(cx.debug_bounds("shortcut-Old audit").is_none());
    assert!(cx.debug_bounds("shortcut-New audit").is_some());
    install(&view, Vec::new(), cx);
    draw(cx);
    assert!(cx.debug_bounds("shortcut-New audit").is_none());
    assert!(cx.debug_bounds("keybinds-empty").is_some());
    install(&view, vec![custom("New audit")], cx);
    draw(cx);
    assert!(cx.debug_bounds("shortcut-New audit").is_some());
    view.update(cx, |view, cx| {
        view.live.status = ConnectionStatus::Disconnected;
        cx.notify();
    });
    draw(cx);
    assert!(
        cx.debug_bounds("shortcut-New audit").is_none(),
        "disconnected snapshots must not advertise runnable custom shortcuts"
    );
}

#[gpui::test]
fn plugin_shortcut_rows_sharing_a_name_are_numbered(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let plugin = |id, description| {
        command(
            id,
            Some(description),
            ClientShellCommandAction::PluginAction,
            &["ctrl+alt+a"],
        )
    };
    install(
        &view,
        vec![
            plugin("plugin.workspace", "New Workspace"),
            plugin("plugin.one", "Audit"),
            plugin("plugin.two", "Audit"),
            plugin("plugin.solo", "Solo"),
        ],
        cx,
    );
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_keybinds(window, cx)));
    search(&view, "", cx);
    for row in [
        "New Workspace",
        "New Workspace (2)",
        "Audit",
        "Audit (2)",
        "Solo",
    ] {
        assert!(
            cx.debug_bounds(format!("shortcut-{row}").leak()).is_some(),
            "missing {row}"
        );
    }
    assert!(cx.debug_bounds("shortcut-Audit (3)").is_none());
}
