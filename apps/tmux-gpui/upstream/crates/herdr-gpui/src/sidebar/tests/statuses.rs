use super::*;

const STATUSES: [AgentStatus; 5] = [
    AgentStatus::Working,
    AgentStatus::Blocked,
    AgentStatus::Done,
    AgentStatus::Idle,
    AgentStatus::Unknown,
];

#[test]
fn status_colors_keep_upstream_literals_where_they_already_read() {
    // Upstream's default palette (Catppuccin Mocha), which its status dots use
    // whatever terminal colors are loaded.
    for (status, color) in [
        (AgentStatus::Working, 0xf9e2af),
        (AgentStatus::Blocked, 0xf38ba8),
        (AgentStatus::Done, 0x94e2d5),
        (AgentStatus::Idle, 0xa6e3a1),
    ] {
        for name in ["Default", "Nord", "Dracula", "Catppuccin Mocha"] {
            let mut theme = Theme::builtin(name).unwrap();
            assert_eq!(status_style(status, &theme).2, color, "{name}");
            theme.palette.fill(0x123456);
            let indicators = Indicators::new(None, false, &theme);
            assert_eq!(indicators.style, IndicatorStyle::Dots);
            assert_eq!(indicators.color(status), color);
        }
    }
    let mocha = Theme::builtin("Catppuccin Mocha").unwrap();
    let unknown = status_style(AgentStatus::Unknown, &mocha).2;
    let channels = |color: u32| [16, 8, 0].map(|shift| ((color >> shift) & 255) as i32);
    for (lifted, upstream) in channels(unknown).into_iter().zip(channels(0x6c7086)) {
        assert!((0..=16).contains(&(lifted - upstream)), "{unknown:06x}");
    }
}

#[test]
fn status_symbols_match_upstream_without_changing_status_colors() {
    let mut indicators = Indicators::new(None, false, &Theme::default());
    indicators.style = IndicatorStyle::Symbols;
    for (status, symbol) in [
        (AgentStatus::Working, "\u{25d0}"),
        (AgentStatus::Blocked, "\u{d7}"),
        (AgentStatus::Done, "\u{2713}"),
        (AgentStatus::Idle, "\u{25cb}"),
        (AgentStatus::Unknown, "\u{b7}"),
    ] {
        assert_eq!(status_symbol(status), symbol);
        assert_eq!(
            indicators.color(status),
            status_style(status, &Theme::default()).2
        );
    }
}

#[test]
fn status_slots_are_fixed_for_each_style_and_font_size() {
    use gpui::{Styled, px};
    for size in [6., 8., 12., 12.5, 16., 20., 32.] {
        let font = FontConfig {
            family: "Menlo".into(),
            size,
            fallbacks: None,
            line_height_multiple: None,
        };
        for style in [IndicatorStyle::Dots, IndicatorStyle::Symbols] {
            let mut indicators = Indicators::new(None, false, &Theme::default());
            indicators.style = style;
            let width = match style {
                IndicatorStyle::Dots => STATUS_WIDTH,
                IndicatorStyle::Symbols => size.ceil().max(STATUS_WIDTH),
            };
            assert_eq!(indicators.width(&font), width);
            for status in [
                AgentStatus::Working,
                AgentStatus::Blocked,
                AgentStatus::Done,
                AgentStatus::Idle,
                AgentStatus::Unknown,
            ] {
                let mut slot = status_indicator(status, &font, indicators);
                assert_eq!(slot.style().size.width, Some(px(width).into()));
                if style == IndicatorStyle::Symbols {
                    assert_eq!(slot.text_style().font_size, Some(px(size).into()));
                }
            }
        }
    }
}

#[test]
fn symbol_rows_keep_layout_density_and_expand_child_indent() {
    use super::super::row::{RowIcon, RowKind, RowTree, row};
    use crate::config::LayoutMode;
    use gpui::{Styled, px};

    let font = FontConfig {
        family: "Menlo".into(),
        size: 20.,
        fallbacks: None,
        line_height_multiple: None,
    };
    let theme = Theme::default();
    for mode in [
        LayoutMode::default(),
        LayoutMode::Classic {
            density: crate::config::Density::Compact,
            style: crate::config::Style::Flat,
        },
    ] {
        let layout = super::super::layout::for_mode(mode);
        for style in [IndicatorStyle::Dots, IndicatorStyle::Symbols] {
            let mut indicators = Indicators::new(None, false, &theme);
            indicators.style = style;
            for kind in [
                RowKind::Workspace,
                RowKind::Agent(crate::icons::AgentIcon::Generic),
            ] {
                let mut row = row(
                    "density",
                    &[("child", true)],
                    "branch",
                    kind,
                    AgentStatus::Working,
                    indicators,
                    false,
                    super::super::cell::RowState::default(),
                    RowTree::LastChild,
                    true,
                    RowIcon::None,
                    None,
                    None,
                    None,
                    None,
                    &[],
                    &super::super::cell::RowContext {
                        indicators,
                        font: &font,
                        theme: &theme,
                        look: layout,
                        width: 160.,
                        nest: 0.,
                        mark: Default::default(),
                        host: None,
                    },
                );
                assert_eq!(
                    row.style().padding.left,
                    Some(
                        px(layout.content_x()
                            + layout.density.child_indent()
                            + indicators.width(&font)
                            - STATUS_WIDTH)
                        .into()
                    )
                );
                let lines = if layout.density.child_details() || matches!(kind, RowKind::Agent(_)) {
                    2.
                } else {
                    1.
                };
                assert_eq!(
                    row.style().size.height,
                    Some(px(layout.row_height(super::super::line_height(&font) * lines)).into())
                );
            }
        }
    }
}

#[test]
fn status_colors_reach_the_contrast_setting_on_every_builtin_theme() {
    for name in Theme::BUILTIN_NAMES {
        for contrast in [Contrast::Standard, Contrast::High] {
            let theme = Theme::builtin(name).unwrap().with_contrast(contrast);
            for status in STATUSES {
                let color = status_style(status, &theme).2;
                for background in [theme.background, theme.surface, theme.active] {
                    let ratio = crate::contrast::ratio(color, background);
                    assert!(
                        ratio >= contrast.mark_ratio(),
                        "{name} {contrast:?} {status:?} on {background:06x}: {ratio}"
                    );
                }
            }
        }
    }
    // Light chrome darkens the pastels rather than keeping upstream's literals.
    let latte = Theme::builtin("Catppuccin Latte").unwrap();
    let mocha = Theme::builtin("Catppuccin Mocha").unwrap();
    for status in STATUSES {
        assert_ne!(
            status_style(status, &latte).2,
            status_style(status, &mocha).2
        );
    }
}

#[test]
fn status_shapes_match_upstream_dots_and_wire_casing() {
    let snapshot = layout_tests::snapshot(1);
    for (wire, status) in [
        ("idle", AgentStatus::Idle),
        ("working", AgentStatus::Working),
        ("blocked", AgentStatus::Blocked),
        ("done", AgentStatus::Done),
        ("unknown", AgentStatus::Unknown),
    ] {
        let mut value = serde_json::to_value(&snapshot.workspaces[0]).unwrap();
        value["agent_status"] = wire.into();
        let workspace: ClientShellWorkspace = serde_json::from_value(value).unwrap();
        assert_eq!(workspace.agent_status, status);
        let mut value = serde_json::to_value(&snapshot.agents[0]).unwrap();
        value["agent_status"] = wire.into();
        let agent: ClientShellAgent = serde_json::from_value(value).unwrap();
        assert_eq!(agent.agent_status, status);
        assert_eq!(serde_json::to_value(status).unwrap(), wire);
        let theme = Theme::default();
        let (diameter, filled, color) = status_style(status, &theme);
        assert_eq!(
            color,
            theme.ink(match status {
                AgentStatus::Working => 0xf9e2af,
                AgentStatus::Blocked => 0xf38ba8,
                AgentStatus::Done => 0x94e2d5,
                AgentStatus::Idle => 0xa6e3a1,
                AgentStatus::Unknown => 0x6c7086,
            })
        );
        assert_eq!(filled, status != AgentStatus::Idle);
        assert_eq!(
            diameter,
            if status == AgentStatus::Unknown {
                STATUS_DOT_UNKNOWN
            } else {
                STATUS_WIDTH
            }
        );
    }
}

#[test]
fn child_gutter_lines_land_on_whole_device_pixels() {
    use crate::sidebar::row::{RowTree, tree_lines};
    use gpui::{Bounds, Pixels, point, px, size};
    let font = FontConfig {
        family: "Menlo".into(),
        size: 12.,
        fallbacks: None,
        line_height_multiple: None,
    };
    for scale in [1., 2., 3.] {
        let row = Bounds::new(point(px(0.), px(244.)), size(px(231.), px(40.)));
        let device = |value: Pixels| f32::from(value) * scale;
        let whole = |value: Pixels| (device(value) - device(value).round()).abs() < 0.001;
        for tree in [RowTree::Child, RowTree::LastChild] {
            let [trunk, tick] = tree_lines(row, tree, &font, 4., scale);
            // Both lines carry the same weight and start on the device grid, so
            // neither is drawn thinner or blurrier than the other.
            assert!(
                (trunk.size.width - tick.size.height).abs() < px(0.01),
                "{scale}"
            );
            assert!(
                (device(trunk.size.width) - scale.round().max(1.)).abs() < 0.01,
                "{scale}"
            );
            for edge in [trunk.left(), trunk.top(), tick.left(), tick.top()] {
                assert!(whole(edge), "{scale}: {edge:?}");
            }
            // The trunk hugs the gutter's leading edge, the tick crosses to the
            // dot at its far edge; neither strays into the label beyond.
            assert_eq!(trunk.left(), tick.left(), "{scale}");
            assert_eq!(trunk.left(), row.left(), "{scale}");
            assert_eq!(tick.right(), row.right(), "{scale}");
            // The tick meets the status dot's middle row.
            let middle = row.top() + px(4. + super::super::line_height(&font) / 2.);
            assert!(
                (tick.center().y - middle).abs() <= px(1. / scale),
                "{scale}"
            );
            // Only a row with a sibling below carries the trunk to the bottom.
            match tree {
                RowTree::Child => assert_eq!(trunk.bottom(), row.bottom(), "{scale}"),
                _ => assert_eq!(trunk.bottom(), tick.bottom(), "{scale}"),
            }
            assert_eq!(trunk.top(), row.top(), "{scale}");
        }
    }
}
