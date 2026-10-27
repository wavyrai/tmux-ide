use super::*;
use crate::tmux_snapshot::{
    browser,
    pane_actions::{Menu, Target},
};
use core::prelude::v1::test;

#[test]
fn pane_menu_stays_within_accessible_flat_adapter_contract() {
    for zoomed in [false, true] {
        let menu = Menu {
            target: Target {
                request: 7,
                session: "session".into(),
                actions: browser::PaneActions {
                    token: "token".into(),
                    id: "pane".into(),
                    zoomed,
                },
            },
            cursor: Cursor::default(),
            input: None,
            error: None,
        };
        let items = menu.items();
        assert!(
            items.iter().all(|item| matches!(
                item,
                Item::Separator
                    | Item::Action {
                        description: None,
                        tooltip: None,
                        icon: None,
                        indent: 0,
                        checked: false,
                        enabled: true,
                        ..
                    }
            )),
            "Extend the adapter deliberately before adding richer menu items"
        );
        let mut cursor = Cursor::default();
        for index in [0, 1, 3, 5, 6, 8, 9, 10, 11, 0] {
            cursor.step(&items, 1);
            assert_eq!(cursor.path(), Some(vec![index]));
        }
    }
}
