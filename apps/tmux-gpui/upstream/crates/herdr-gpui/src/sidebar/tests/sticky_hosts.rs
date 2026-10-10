use crate::sidebar::sticky::{HostHeader, cover, pinned};

/// Where `pinned` draws its copy: the host, and its top.
fn pin(rows: &[(usize, f32, f32)]) -> Option<(usize, f32)> {
    pinned(&headers(rows)).map(|pinned| (pinned.host, pinned.top))
}

fn headers(rows: &[(usize, f32, f32)]) -> Vec<HostHeader> {
    rows.iter()
        .map(|&(host, top, height)| HostHeader { host, top, height })
        .collect()
}

#[test]
fn nothing_pins_until_a_header_scrolls_above_the_top() {
    assert_eq!(pinned(&[]), None);
    assert_eq!(cover(&[]), 0.);
    assert_eq!(pin(&[(0, 0., 24.), (1, 200., 24.)]), None);
    assert_eq!(pin(&[(0, 40., 24.), (1, 200., 24.)]), None);
}

#[test]
fn the_last_header_above_the_top_pins_in_place() {
    // Host 0 has scrolled away; its workspaces still fill the list.
    assert_eq!(pin(&[(0, -0.5, 24.), (1, 200., 24.)]), Some((0, 0.)));
    assert_eq!(
        pin(&[(0, -300., 24.), (1, -40., 24.), (2, 400., 24.)]),
        Some((1, 0.))
    );
    // The last host has no successor to push it.
    assert_eq!(pin(&[(0, -300., 24.), (1, -40., 24.)]), Some((1, 0.)));
}

#[test]
fn the_next_header_pushes_the_pinned_one_out_by_its_own_height() {
    // The next header overlaps the pinned copy's bottom 10px.
    assert_eq!(pin(&[(0, -100., 24.), (1, 14., 30.)]), Some((0, -10.)));
    // A two-line header, with its load, is pushed by its own height.
    assert_eq!(pin(&[(0, -100., 40.), (1, 14., 24.)]), Some((0, -26.)));
    // A collapsed host's next header follows directly, so the copy sits
    // exactly over the real row as it leaves.
    assert_eq!(pin(&[(0, -6., 24.), (1, 18., 24.)]), Some((0, -6.)));
}

#[test]
fn the_pinned_copy_covers_the_list_down_to_its_bottom_edge() {
    assert_eq!(cover(&headers(&[(0, 0., 24.), (1, 200., 24.)])), 0.);
    assert_eq!(cover(&headers(&[(0, -100., 40.), (1, 200., 24.)])), 40.);
    // Pushed 10px up, it hides 10px less.
    assert_eq!(cover(&headers(&[(0, -100., 24.), (1, 14., 30.)])), 14.);
}
