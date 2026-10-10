#![allow(clippy::unwrap_used)]

use super::*;
use crate::contrast::{Contrast, luminance, ratio};

#[test]
fn colors_follow_primary_and_contrast_in_every_theme() {
    for &name in Theme::BUILTIN_NAMES {
        for contrast in [Contrast::Standard, Contrast::High] {
            let mut theme = Theme::builtin(name).unwrap().with_contrast(contrast);
            for checked in [false, true] {
                let (fill, ink) = colors(&theme, checked);
                assert_eq!(
                    fill,
                    if checked {
                        theme.primary()
                    } else {
                        theme.active
                    }
                );
                assert!(
                    ratio(ink, fill) >= contrast.mark_ratio(),
                    "{name} {contrast:?} checked={checked}: {ink:06x} on {fill:06x}"
                );
            }
            // Shared/custom themes can use a dark purple accent even on light chrome.
            theme.palette[5] = 0x8839ef;
            let (fill, ink) = colors(&theme, true);
            assert_eq!(fill, 0x8839ef);
            assert!(luminance(ink) > luminance(fill));
            assert!(ratio(ink, fill) >= contrast.mark_ratio());
        }
    }
}
