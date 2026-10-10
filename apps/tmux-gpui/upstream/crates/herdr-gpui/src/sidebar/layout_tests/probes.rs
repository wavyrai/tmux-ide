use super::*;

#[test]
fn native_child_probe_reports_geometry_and_glyph_failures_without_panicking() {
    use crate::config::{Density, LayoutMode, Style};
    // Rounded rows move content in by the highlight's inset, the density's
    // gap, on both edges.
    for (mode, left, width) in [
        (LayoutMode::from(Density::Comfortable), 56., 145.),
        (LayoutMode::from(Density::Normal), 44., 161.),
        (LayoutMode::from(Density::Compact), 38., 169.),
        (
            LayoutMode::new(Density::Comfortable, Style::Rounded),
            64.,
            129.,
        ),
        (LayoutMode::new(Density::Normal, Style::Rounded), 50., 149.),
        (LayoutMode::new(Density::Compact, Style::Rounded), 42., 161.),
    ] {
        let bounds = Bounds::new(point(px(left), px(100.)), size(px(width), px(16.)));
        let mut probe = PaintedText {
            bounds,
            mask: bounds,
            cached: "sidebar-child".into(),
            glyph_text: "sidebar-child".into(),
            width: px(94.),
            clipped: false,
        };
        probe.verify_child("sidebar-child", mode).unwrap();
        probe.bounds.size.width -= px(1.);
        let error = probe.verify_child("sidebar-child", mode).unwrap_err();
        assert!(error.to_string().contains("child label width: actual"));
        assert!(error.to_string().contains("expected"));
        probe.bounds = bounds;
        probe.clipped = true;
        assert!(
            probe
                .verify_child("sidebar-child", mode)
                .unwrap_err()
                .to_string()
                .contains("clipped")
        );
        probe.clipped = false;
        probe.glyph_text = "sidebar-chil".into();
        assert!(
            probe
                .verify_child("sidebar-child", mode)
                .unwrap_err()
                .to_string()
                .contains("cached text")
        );
        probe.glyph_text = "sidebar-child-with-…".into();
        probe.cached.clone_from(&probe.glyph_text);
        probe.width = px(width - 5.);
        probe
            .verify_child("sidebar-child-with-a-long-readable-branch-name", mode)
            .unwrap();
        probe.width = px(50.);
        assert!(
            probe
                .verify_child("sidebar-child-with-a-long-readable-branch-name", mode)
                .unwrap_err()
                .to_string()
                .contains("did not fill")
        );
    }
}

#[test]
fn native_probe_failure_survives_later_frames_and_keeps_its_source() {
    let mut probes = PaintedProbes::default();
    probes.record(
        "first label".into(),
        Err(std::io::Error::from(std::io::ErrorKind::InvalidData).into()),
    );
    probes.0.clear();
    probes.record("later label".into(), Err(anyhow::anyhow!("later failure")));
    let error = probes.check().unwrap_err();
    assert!(error.to_string().contains("first label"));
    assert_eq!(
        error.downcast_ref::<std::io::Error>().unwrap().kind(),
        std::io::ErrorKind::InvalidData
    );
    assert!(probes.check().is_ok());
}
