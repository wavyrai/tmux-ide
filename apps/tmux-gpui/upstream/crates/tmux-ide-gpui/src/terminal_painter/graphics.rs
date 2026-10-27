//! Terminal graphics occupy the cell, not the font's ink bounds. Keep their
//! edges on the same device-pixel grid even with fractional cell metrics.
use gpui::{Bounds, Path, PathBuilder, Pixels, Point, point, px};

#[derive(Clone, Copy)]
pub(super) enum Graphic {
    // Left, right, up, down: absent (0), light (1), or heavy (2).
    Lines([u8; 4]),
    Block([u8; 4]),
    Quadrants(u8),
}

#[cfg(test)]
mod tests;

/// The four solid prompt separators (U+E0B0, U+E0B2, U+E0B4, U+E0B6) occupy
/// the cell, not the font's ink bounds. Font glyphs leave line-height padding
/// above and below a colored prompt bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CellSeparator {
    RightTriangle,
    LeftTriangle,
    RightRound,
    LeftRound,
}

impl CellSeparator {
    pub(super) fn from_symbol(symbol: &str) -> Option<Self> {
        match symbol {
            "\u{e0b0}" => Some(Self::RightTriangle),
            "\u{e0b2}" => Some(Self::LeftTriangle),
            "\u{e0b4}" => Some(Self::RightRound),
            "\u{e0b6}" => Some(Self::LeftRound),
            _ => None,
        }
    }

    /// Takes the cell's snapped absolute corners rather than a `Bounds`, whose
    /// far edge would be rebuilt as origin + size and drift off the pixel grid
    /// the background quads share.
    pub(super) fn path(
        self,
        top_left: Point<Pixels>,
        bottom_right: Point<Pixels>,
    ) -> gpui::Result<Path<Pixels>> {
        let (left, top, right, bottom) = (top_left.x, top_left.y, bottom_right.x, bottom_right.y);
        let middle = (top + bottom) / 2.;
        let width = right - left;
        let half_height = (bottom - top) / 2.;
        let k = 0.552_284_8;
        let mut path = PathBuilder::fill();
        match self {
            Self::RightTriangle => path.add_polygon(
                &[point(left, top), point(right, middle), point(left, bottom)],
                true,
            ),
            Self::LeftTriangle => path.add_polygon(
                &[point(right, top), point(left, middle), point(right, bottom)],
                true,
            ),
            Self::RightRound => {
                path.move_to(point(left, top));
                path.cubic_bezier_to(
                    point(right, middle),
                    point(left + width * k, top),
                    point(right, middle - half_height * k),
                );
                path.cubic_bezier_to(
                    point(left, bottom),
                    point(right, middle + half_height * k),
                    point(left + width * k, bottom),
                );
                path.close();
            }
            Self::LeftRound => {
                path.move_to(point(right, top));
                path.cubic_bezier_to(
                    point(left, middle),
                    point(right - width * k, top),
                    point(left, middle - half_height * k),
                );
                path.cubic_bezier_to(
                    point(right, bottom),
                    point(left, middle + half_height * k),
                    point(right - width * k, bottom),
                );
                path.close();
            }
        }
        path.build()
    }
}

impl Graphic {
    pub(super) fn from_symbol(symbol: &str) -> Option<Self> {
        // Every graphic below is one character in U+2500..=U+259F, three UTF-8
        // bytes; this rejects ASCII, most of any grid, before decoding.
        if symbol.len() != 3 {
            return None;
        }
        let mut chars = symbol.chars();
        let ch = chars.next()?;
        // Do not swallow combining marks or variation selectors.
        if chars.next().is_some() {
            return None;
        }
        let lines = match ch {
            '─' => [1, 1, 0, 0],
            '━' => [2, 2, 0, 0],
            '│' => [0, 0, 1, 1],
            '┃' => [0, 0, 2, 2],
            '┌'..='╋' => {
                const ARMS: [[u8; 4]; 64] = [
                    [0, 1, 0, 1],
                    [0, 2, 0, 1],
                    [0, 1, 0, 2],
                    [0, 2, 0, 2],
                    [1, 0, 0, 1],
                    [2, 0, 0, 1],
                    [1, 0, 0, 2],
                    [2, 0, 0, 2],
                    [0, 1, 1, 0],
                    [0, 2, 1, 0],
                    [0, 1, 2, 0],
                    [0, 2, 2, 0],
                    [1, 0, 1, 0],
                    [2, 0, 1, 0],
                    [1, 0, 2, 0],
                    [2, 0, 2, 0],
                    [0, 1, 1, 1],
                    [0, 2, 1, 1],
                    [0, 1, 2, 1],
                    [0, 1, 1, 2],
                    [0, 1, 2, 2],
                    [0, 2, 2, 1],
                    [0, 2, 1, 2],
                    [0, 2, 2, 2],
                    [1, 0, 1, 1],
                    [2, 0, 1, 1],
                    [1, 0, 2, 1],
                    [1, 0, 1, 2],
                    [1, 0, 2, 2],
                    [2, 0, 2, 1],
                    [2, 0, 1, 2],
                    [2, 0, 2, 2],
                    [1, 1, 0, 1],
                    [2, 1, 0, 1],
                    [1, 2, 0, 1],
                    [2, 2, 0, 1],
                    [1, 1, 0, 2],
                    [2, 1, 0, 2],
                    [1, 2, 0, 2],
                    [2, 2, 0, 2],
                    [1, 1, 1, 0],
                    [2, 1, 1, 0],
                    [1, 2, 1, 0],
                    [2, 2, 1, 0],
                    [1, 1, 2, 0],
                    [2, 1, 2, 0],
                    [1, 2, 2, 0],
                    [2, 2, 2, 0],
                    [1, 1, 1, 1],
                    [2, 1, 1, 1],
                    [1, 2, 1, 1],
                    [2, 2, 1, 1],
                    [1, 1, 2, 1],
                    [1, 1, 1, 2],
                    [1, 1, 2, 2],
                    [2, 1, 2, 1],
                    [1, 2, 2, 1],
                    [2, 1, 1, 2],
                    [1, 2, 1, 2],
                    [2, 2, 2, 1],
                    [2, 2, 1, 2],
                    [2, 1, 2, 2],
                    [1, 2, 2, 2],
                    [2, 2, 2, 2],
                ];
                ARMS[(ch as u32 - '┌' as u32) as usize]
            }
            '╴' => [1, 0, 0, 0],
            '╵' => [0, 0, 1, 0],
            '╶' => [0, 1, 0, 0],
            '╷' => [0, 0, 0, 1],
            '╸' => [2, 0, 0, 0],
            '╹' => [0, 0, 2, 0],
            '╺' => [0, 2, 0, 0],
            '╻' => [0, 0, 0, 2],
            '╼' => [1, 2, 0, 0],
            '╽' => [0, 0, 1, 2],
            '╾' => [2, 1, 0, 0],
            '╿' => [0, 0, 2, 1],
            '▀' => return Some(Self::Block([0, 0, 8, 4])),
            '▁'..='█' => {
                return Some(Self::Block([
                    0,
                    8 - (ch as u32 - '▁' as u32 + 1) as u8,
                    8,
                    8,
                ]));
            }
            '▉'..='▏' => {
                return Some(Self::Block([0, 0, 7 - (ch as u32 - '▉' as u32) as u8, 8]));
            }
            '▐' => return Some(Self::Block([4, 0, 8, 8])),
            '▔' => return Some(Self::Block([0, 0, 8, 1])),
            '▕' => return Some(Self::Block([7, 0, 8, 8])),
            '▖'..='▟' => {
                // Bits: upper left, upper right, lower left, lower right.
                const MASKS: [u8; 10] = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14];
                return Some(Self::Quadrants(MASKS[(ch as u32 - '▖' as u32) as usize]));
            }
            // Dashed, double, rounded and diagonal lines, and shades retain
            // their font rendering rather than changing their intended shape.
            _ => return None,
        };
        Some(Self::Lines(lines))
    }

    /// Emits at most four quads, without allocating or entering the glyph cache.
    pub(super) fn rectangles(
        self,
        cell: Bounds<Pixels>,
        scale: f32,
        mut emit: impl FnMut(Bounds<Pixels>),
    ) {
        let x = f32::from(cell.left()) * scale;
        let y = f32::from(cell.top()) * scale;
        let w = f32::from(cell.size.width) * scale;
        let h = f32::from(cell.size.height) * scale;
        let mut rect = |left: f32, top: f32, right: f32, bottom: f32| {
            let [left, top, right, bottom] = [left, top, right, bottom].map(f32::round);
            if right > left && bottom > top {
                emit(Bounds::from_corners(
                    point(px(left / scale), px(top / scale)),
                    point(px(right / scale), px(bottom / scale)),
                ));
            }
        };
        match self {
            Self::Block([left, top, right, bottom]) => rect(
                x + w * f32::from(left) / 8.,
                y + h * f32::from(top) / 8.,
                x + w * f32::from(right) / 8.,
                y + h * f32::from(bottom) / 8.,
            ),
            Self::Quadrants(mask) => {
                for bit in 0..4 {
                    if mask & (1 << bit) != 0 {
                        let left = x + w * (bit % 2) as f32 / 2.;
                        let top = y + h * (bit / 2) as f32 / 2.;
                        rect(left, top, left + w / 2., top + h / 2.);
                    }
                }
            }
            Self::Lines([left, right, up, down]) => {
                let light = (w / 8.).round().max(1.);
                let band = |center: f32, weight: u8| {
                    let width = light * f32::from(weight);
                    let start = (center - width / 2.).floor();
                    (start, start + width)
                };
                let center_x = (x + w / 2.).round();
                let center_y = (y + h / 2.).round();
                // Arms overlap the widest perpendicular stroke at the joint.
                // This avoids pinholes at mixed light/heavy corners and tees.
                let (vx0, vx1) = band(x + w / 2., up.max(down));
                let (hy0, hy1) = band(y + h / 2., left.max(right));
                for (weight, is_left) in [(left, true), (right, false)] {
                    if weight != 0 {
                        let (top, bottom) = band(y + h / 2., weight);
                        rect(
                            if is_left { x } else { vx0.min(center_x) },
                            top,
                            if is_left { vx1.max(center_x) } else { x + w },
                            bottom,
                        );
                    }
                }
                for (weight, is_up) in [(up, true), (down, false)] {
                    if weight != 0 {
                        let (left, right) = band(x + w / 2., weight);
                        rect(
                            left,
                            if is_up { y } else { hy0.min(center_y) },
                            right,
                            if is_up { hy1.max(center_y) } else { y + h },
                        );
                    }
                }
            }
        }
    }
}
