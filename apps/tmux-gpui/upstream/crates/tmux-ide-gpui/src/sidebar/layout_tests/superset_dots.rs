use super::*;

/// Superset's status dot sits on the icon slot's corner. The slot sets the
/// line's height and the line clips, so the dot must stay inside the slot or
/// its top is cut off (#305).
#[gpui::test]
fn superset_status_dots_stay_inside_their_icon_slot(cx: &mut gpui::TestAppContext) {
    use crate::config::LayoutMode;
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(800.), px(900.)));
    for (size, style) in [12., 20., 36.]
        .into_iter()
        .flat_map(|size| ["dots", "symbols"].map(|style| (size, style)))
    {
        view.update(cx, |view, cx| {
            view.config.layout.mode = LayoutMode::Superset;
            view.config.sidebar.size = size;
            view.settings.shared = Some(
                crate::herdr_settings::Settings::parse_text(&format!(
                    "[ui]\nstatus_indicators = '{style}'\n"
                ))
                .unwrap(),
            );
            cx.notify();
        });
        cx.run_until_parked();
        for (key, icon, mark) in [
            ("herdr", "icon-herdr", "dot-herdr"),
            ("agent-p0", "icon-agent-p0", "dot-agent-p0"),
        ] {
            let slot = cx.debug_bounds(icon).unwrap();
            let dot = cx
                .debug_bounds(mark)
                .unwrap_or_else(|| panic!("{style} at {size}: no dot on {key}"));
            assert!(
                slot.contains(&dot.origin)
                    && dot.right() <= slot.right()
                    && dot.bottom() <= slot.bottom(),
                "{style} at {size}: {key} dot {dot:?} leaves slot {slot:?}"
            );
        }
    }
}
