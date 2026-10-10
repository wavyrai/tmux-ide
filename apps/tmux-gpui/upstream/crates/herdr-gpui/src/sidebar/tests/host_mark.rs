//! Which wash and dimming a host's rows get for each selection mode.
use super::super::wash::{HostMark, REST_ALPHA, SELECTED_ALPHA, Wash};
use crate::{
    config::{SelectMode, SidebarStyle, Theme},
    contrast::Contrast,
};
use std::collections::BTreeMap;

fn style(select: SelectMode) -> SidebarStyle {
    SidebarStyle {
        select,
        hosts: BTreeMap::from([("Personal".to_owned(), 0x3a4a6b)]),
        ..SidebarStyle::default()
    }
}

#[test]
fn row_mode_shows_configured_colours_only() {
    let theme = Theme::default();
    let style = style(SelectMode::Row);
    for selected in [false, true] {
        assert_eq!(
            HostMark::resolve(&style, "Personal", selected, &theme),
            HostMark {
                wash: Some(Wash {
                    color: 0x3a4a6b,
                    alpha: REST_ALPHA
                }),
                dim: false,
            }
        );
        assert_eq!(
            HostMark::resolve(&style, "Work", selected, &theme),
            HostMark::default()
        );
    }
}

#[test]
fn group_modes_raise_the_selected_host_and_fall_back_to_the_active_colour() {
    let theme = Theme::default();
    for select in [SelectMode::Group, SelectMode::GroupDim] {
        let style = style(select);
        assert_eq!(
            HostMark::resolve(&style, "Personal", true, &theme).wash,
            Some(Wash {
                color: 0x3a4a6b,
                alpha: SELECTED_ALPHA
            })
        );
        assert_eq!(
            HostMark::resolve(&style, "Work", true, &theme).wash,
            Some(Wash {
                color: theme.active,
                alpha: SELECTED_ALPHA
            })
        );
        assert!(!HostMark::resolve(&style, "Work", true, &theme).dim);
        let other = HostMark::resolve(&style, "Personal", false, &theme);
        assert_eq!(other.wash.map(|wash| wash.alpha), Some(REST_ALPHA));
        assert_eq!(other.dim, select == SelectMode::GroupDim);
        assert_eq!(
            HostMark::resolve(&style, "Work", false, &theme).dim,
            select == SelectMode::GroupDim
        );
    }
}

/// The wash never exceeds the alpha a light theme can carry under
/// foreground text, whatever colour or contrast is configured, and the
/// selected host's wash stays stronger than a resting one.
#[test]
fn wash_alpha_stays_a_tint() {
    let theme = Theme::default().with_contrast(Contrast::High);
    let style = style(SelectMode::Group);
    let selected = HostMark::resolve(&style, "Work", true, &theme)
        .wash
        .unwrap();
    let rest = HostMark::resolve(&style, "Personal", false, &theme)
        .wash
        .unwrap();
    assert!(selected.alpha <= 0x40, "{:#x}", selected.alpha);
    assert!(rest.alpha < selected.alpha);
    assert_eq!(selected.color, theme.active);
}
