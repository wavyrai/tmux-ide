//! Batched glyph sprites (tmux-ide): resolve a glyph once, place it many
//! times, and insert a batch into the scene. The arithmetic is
//! `Window::paint_glyph`'s and `Window::paint_emoji`'s, so the sprites are the
//! ones those would insert. A child module of `window`, so the change to the
//! vendored crate is this file and its declaration.
use super::*;

impl Window {
    /// Where a glyph painted at `origin` lands: the device-pixel origin its
    /// sprite is placed from and the subpixel variant it is rasterized at.
    /// The arithmetic is [`Window::paint_glyph`]'s (or, for an emoji,
    /// [`Window::paint_emoji`]'s), so a sprite built from it is identical.
    pub fn glyph_placement(&self, origin: Point<Pixels>, is_emoji: bool) -> GlyphPlacement {
        let glyph_origin = origin.scale(self.scale_factor());
        if is_emoji {
            return GlyphPlacement {
                origin: glyph_origin.map(|c| ScaledPixels(round_half_toward_zero(c.0))),
                variant: Point::default(),
            };
        }
        let quantized_origin = Point::new(
            round_half_toward_zero(glyph_origin.x.0 * SUBPIXEL_VARIANTS_X as f32)
                / SUBPIXEL_VARIANTS_X as f32,
            round_half_toward_zero(glyph_origin.y.0 * SUBPIXEL_VARIANTS_Y as f32)
                / SUBPIXEL_VARIANTS_Y as f32,
        );
        GlyphPlacement {
            origin: quantized_origin.map(|c| ScaledPixels(c.trunc())),
            variant: Point::new(
                (quantized_origin.x.fract() * SUBPIXEL_VARIANTS_X as f32) as u8,
                (quantized_origin.y.fract() * SUBPIXEL_VARIANTS_Y as f32) as u8,
            ),
        }
    }

    /// The window state a [`ResolvedGlyph`] depends on besides its glyph,
    /// size and colour. While it compares equal, a resolution stays valid.
    pub fn glyph_raster_state(&self) -> GlyphRasterState {
        GlyphRasterState {
            scale_factor: self.scale_factor(),
            background: self.platform_window.background_appearance(),
            subpixel_supported: self.platform_window.is_subpixel_rendering_supported(),
            mode: self.text_rendering_mode.get(),
        }
    }

    /// Rasterizes (or finds) one glyph at one subpixel variant and colour,
    /// without placing it. `None` is a glyph with no pixels. The result stays
    /// valid while the window's scale factor, background appearance and
    /// text rendering mode are unchanged.
    pub fn resolve_glyph(
        &mut self,
        font_id: FontId,
        glyph_id: GlyphId,
        font_size: Pixels,
        variant: Point<u8>,
        color: Hsla,
        is_emoji: bool,
    ) -> Result<Option<ResolvedGlyph>> {
        let scale_factor = self.scale_factor();
        let (subpixel_rendering, dilation) = if is_emoji {
            (false, 0)
        } else {
            (
                self.should_use_subpixel_rendering(font_id, font_size),
                self.text_system().glyph_dilation_for_color(color),
            )
        };
        let params = RenderGlyphParams {
            font_id,
            glyph_id,
            font_size,
            subpixel_variant: if is_emoji { Point::default() } else { variant },
            scale_factor,
            is_emoji,
            subpixel_rendering,
            dilation,
        };
        let raster_bounds = self.text_system().raster_bounds(&params)?;
        if raster_bounds.is_zero() {
            return Ok(None);
        }
        let tile = self
            .sprite_atlas
            .get_or_insert_with(params.clone().into(), &mut || {
                let (size, bytes) = self.text_system().rasterize_glyph(&params)?;
                Ok(Some((size, Cow::Owned(bytes))))
            })?
            .expect("Callback above only errors or returns Some");
        Ok(Some(ResolvedGlyph {
            offset: raster_bounds.origin.map(Into::into),
            tile,
            kind: if is_emoji {
                GlyphKind::Polychrome
            } else if subpixel_rendering {
                GlyphKind::Subpixel
            } else {
                GlyphKind::Monochrome
            },
        }))
    }

    /// Inserts resolved glyphs into the scene in order, as the same number of
    /// [`Window::paint_glyph`] and [`Window::paint_emoji`] calls would: one
    /// content mask for the batch, element opacity per glyph.
    pub fn insert_glyphs(&mut self, glyphs: &[PlacedGlyph]) {
        self.invalidator.debug_assert_paint();
        let content_mask = self.snapped_content_mask();
        let uniform = self.edge_fade.is_none().then(|| self.element_opacity());
        for glyph in glyphs {
            let opacity = uniform.unwrap_or_else(|| {
                self.element_opacity_for_bounds(&Bounds {
                    origin: glyph.logical_origin,
                    size: size(glyph.font_size * 0.6, glyph.font_size),
                })
            });
            let resolved = &glyph.glyph;
            let bounds = Bounds {
                origin: glyph.origin + resolved.offset,
                size: resolved.tile.bounds.size.map(Into::into),
            };
            match resolved.kind {
                GlyphKind::Subpixel => self.next_frame.scene.insert_primitive(SubpixelSprite {
                    order: 0,
                    pad: 0,
                    bounds,
                    content_mask: content_mask.clone(),
                    color: glyph.color.opacity(opacity),
                    tile: resolved.tile,
                    transformation: TransformationMatrix::unit(),
                }),
                GlyphKind::Monochrome => self.next_frame.scene.insert_primitive(MonochromeSprite {
                    order: 0,
                    pad: 0,
                    bounds,
                    content_mask: content_mask.clone(),
                    color: glyph.color.opacity(opacity),
                    tile: resolved.tile,
                    transformation: TransformationMatrix::unit(),
                }),
                GlyphKind::Polychrome => self.next_frame.scene.insert_primitive(PolychromeSprite {
                    order: 0,
                    pad: 0,
                    grayscale: false.into(),
                    bounds,
                    corner_radii: Default::default(),
                    content_mask: content_mask.clone(),
                    tile: resolved.tile,
                    opacity,
                }),
            }
        }
    }
}

/// Where a glyph lands, from [`Window::glyph_placement`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphPlacement {
    /// The device-pixel origin the sprite is placed from.
    pub origin: Point<ScaledPixels>,
    /// The subpixel variant to rasterize at.
    pub variant: Point<u8>,
}

/// How a resolved glyph is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlyphKind {
    /// A tinted coverage mask.
    Monochrome,
    /// A tinted per-channel coverage mask.
    Subpixel,
    /// A colour bitmap (emoji).
    Polychrome,
}

/// A glyph rasterized into the sprite atlas, from [`Window::resolve_glyph`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedGlyph {
    /// The sprite's offset from its placement origin.
    pub offset: Point<ScaledPixels>,
    /// The atlas tile.
    pub tile: AtlasTile,
    /// How it is drawn.
    pub kind: GlyphKind,
}

/// A resolved glyph placed for [`Window::insert_glyphs`].
#[derive(Clone, Copy, Debug)]
pub struct PlacedGlyph {
    /// From [`Window::glyph_placement`].
    pub origin: Point<ScaledPixels>,
    /// From [`Window::resolve_glyph`].
    pub glyph: ResolvedGlyph,
    /// The tint (ignored for an emoji).
    pub color: Hsla,
    /// The logical origin passed to [`Window::glyph_placement`], for edge fades.
    pub logical_origin: Point<Pixels>,
    /// The font size, for edge fades.
    pub font_size: Pixels,
}

/// From [`Window::glyph_raster_state`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphRasterState {
    /// The window's scale factor.
    pub scale_factor: f32,
    /// Whether the window is opaque, which subpixel rendering needs.
    pub background: WindowBackgroundAppearance,
    /// Whether the platform window can render subpixel glyphs.
    pub subpixel_supported: bool,
    /// The app's text rendering mode.
    pub mode: TextRenderingMode,
}
