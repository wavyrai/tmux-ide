use super::*;
#[test]
fn hit_testing_excludes_gaps_edges_and_invalid_coordinates() {
    let regions = vec![
        Region {
            id: "a".into(),
            left: 0,
            top: 0,
            width: 2,
            height: 2,
        },
        Region {
            id: "b".into(),
            left: 3,
            top: 0,
            width: 2,
            height: 2,
        },
    ];
    assert_eq!(hit(&regions, 19.9, 39.9, 10., 20.), Some("a"));
    assert_eq!(hit(&regions, 20., 0., 10., 20.), None);
    assert_eq!(hit(&regions, 30., 0., 10., 20.), Some("b"));
    assert_eq!(hit(&regions, 50., 0., 10., 20.), None);
    assert_eq!(hit(&regions, 0., 40., 10., 20.), None);
    assert_eq!(hit(&regions, -0.1, 0., 10., 20.), None);
    assert_eq!(hit(&regions, f32::NAN, 0., 10., 20.), None);
}
#[test]
fn rejects_foreign_overlapping_and_out_of_frame_targets() -> anyhow::Result<()> {
    let frame = crate::tmux_snapshot::decode::frame(include_bytes!(
        "../../../../../fixtures/snapshot.json"
    ))?;
    let choices = vec![
        Choice {
            id: "a".into(),
            label: "A".into(),
            pane_count: None,
            window_id: None,
            window_label: None,
        },
        Choice {
            id: "b".into(),
            label: "B".into(),
            pane_count: None,
            window_id: None,
            window_label: None,
        },
    ];
    let mut regions = vec![Region {
        id: "a".into(),
        left: 0,
        top: 0,
        width: 1,
        height: 1,
    }];
    assert!(valid(&regions, Some(&frame), &choices));
    assert!(!valid(&regions, None, &choices));
    assert!(!valid(&regions, Some(&frame), &[]));
    regions.push(Region {
        id: "b".into(),
        left: 0,
        top: 0,
        width: 1,
        height: 1,
    });
    assert!(!valid(&regions, Some(&frame), &choices));
    regions.pop();
    regions[0].left = frame.width;
    assert!(!valid(&regions, Some(&frame), &choices));
    regions[0].left = u16::MAX;
    regions[0].width = u16::MAX;
    assert!(!valid(&regions, Some(&frame), &choices));
    Ok(())
}
#[test]
fn clicks_wait_for_the_current_frame_to_be_painted() -> anyhow::Result<()> {
    use std::sync::Arc;
    let first = Arc::new(crate::tmux_snapshot::decode::frame(include_bytes!(
        "../../../../../fixtures/snapshot.json"
    ))?);
    let next = Arc::new(crate::tmux_snapshot::decode::frame(include_bytes!(
        "../../../../../fixtures/snapshot.json"
    ))?);
    assert!(is_painted(Some(&first), Some(&first)));
    assert!(!is_painted(Some(&next), Some(&first)));
    assert!(!is_painted(None, Some(&first)));
    assert!(!is_painted(Some(&next), None));
    Ok(())
}
