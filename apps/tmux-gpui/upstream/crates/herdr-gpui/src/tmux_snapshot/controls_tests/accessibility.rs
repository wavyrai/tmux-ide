//! Public Element/AccessKit metadata contract, not native AX activation proof.
use super::*;
use gpui::accesskit::{Action, Node, Role};

#[test]
fn controls_expose_accessible_names_and_only_registered_click_actions() {
    let theme = Theme::default();
    for (id, label, hint, expected_name) in [
        ("icon-refresh", None, "Refresh sessions", "Refresh sessions"),
        (
            "labelled-browse",
            Some("Browse sessions"),
            "Browse sessions (⌘K)",
            "Browse sessions",
        ),
    ] {
        let control = button(id, label, hint, Icon::Sessions, &theme);
        assert_eq!(control.a11y_role(), Some(Role::Button));
        let mut node = Node::new(Role::Button);
        control.write_a11y_info(&mut node);
        assert_eq!(node.label(), Some(expected_name));
        assert_eq!(node.author_id(), Some(id));
        assert!(!node.supports_action(Action::Click));

        // GPUI exposes the existing owner callback to assistive technology;
        // adding semantics must not invent a second command-routing path.
        let control = control.on_click(|_, _, _| {});
        let mut node = Node::new(Role::Button);
        control.write_a11y_info(&mut node);
        assert!(node.supports_action(Action::Click));
        assert_eq!(node.label(), Some(expected_name));
        assert_eq!(node.author_id(), Some(id));
    }
}
