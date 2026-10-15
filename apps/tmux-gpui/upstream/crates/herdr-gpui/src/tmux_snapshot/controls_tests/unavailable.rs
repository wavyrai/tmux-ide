use super::*;
use gpui::accesskit::{Action, Node, Role};

#[test]
fn unavailable_icon_keeps_name_and_reason_without_advertising_activation() {
    let control = action_button(
        "workspace-new-window",
        None,
        "New terminal window",
        Icon::Plus,
        ButtonStyle::Unavailable,
        &Theme::default(),
    )
    .aria_description("Unavailable until the selected terminal is ready");
    let mut node = Node::new(Role::Button);
    control.write_a11y_info(&mut node);
    assert_eq!(node.label(), Some("New terminal window"));
    assert_eq!(
        node.description(),
        Some("Unavailable until the selected terminal is ready")
    );
    assert!(!node.supports_action(Action::Click));
}
