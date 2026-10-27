#![allow(clippy::unwrap_used)]
use super::*;
fn layouts() -> BTreeMap<String, Layout> {
    let layout = serde_json::from_value(serde_json::json!({
        "type":"layout", "semanticWindowId":"window", "windowName":"one",
        "currentWindow":true, "cols":80, "rows":24, "zoomed":false,
        "panes":[{"pane":"left","left":0,"top":0,"width":80,"height":24,"active":true}]
    }))
    .unwrap();
    BTreeMap::from([("window".into(), layout)])
}
#[test]
fn epoch_only_updates_do_not_republish_layouts() {
    let mut notice = CatalogNotice::default();
    let layouts = layouts();
    assert!(notice.changed(1, 2, "left", 1, &layouts));
    assert!(!notice.changed(1, 2, "left", 1, &layouts));
    assert!(!notice.changed(1, 2, "left", 2, &layouts));
    assert!(!notice.changed(1, 2, "left", 3, &layouts));
}
#[test]
fn request_presence_and_selection_changes_republish_unchanged_layouts() {
    let mut notice = CatalogNotice::default();
    let layouts = layouts();
    assert!(notice.changed(1, 2, "left", 1, &layouts));
    assert!(notice.changed(2, 2, "left", 1, &layouts));
    assert!(notice.changed(2, 3, "left", 1, &layouts));
    assert!(notice.changed(2, 3, "right", 1, &layouts));
    assert!(!notice.changed(2, 3, "right", 2, &layouts));
}
#[test]
fn changed_layout_and_removal_are_published() {
    let mut notice = CatalogNotice::default();
    let mut layouts = layouts();
    assert!(notice.changed(1, 2, "left", 1, &layouts));
    layouts.get_mut("window").unwrap().panes[0].active = false;
    assert!(notice.changed(1, 2, "left", 2, &layouts));
    layouts.get_mut("window").unwrap().window_name = Some("renamed".into());
    assert!(notice.changed(1, 2, "left", 3, &layouts));
    layouts.clear();
    assert!(notice.changed(1, 2, "left", 4, &layouts));
    assert!(!notice.changed(1, 2, "left", 5, &layouts));
}
