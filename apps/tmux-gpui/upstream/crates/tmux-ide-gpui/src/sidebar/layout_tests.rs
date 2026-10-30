//! Paint-phase probes for the native sidebar label tests.
//! Headless NoopTextSystem ignores font-run lengths, so only the native smoke
//! test can catch GPUI's stale truncation runs. Keep headless checks for geometry.
#![allow(clippy::unwrap_used)]
use anyhow::{Context as _, Result, ensure};
use gpui::{
    App, Bounds, ElementId, Global, GlobalElementId, InspectorElementId, LayoutId, Pixels,
    SharedString, TextLayout, Window, prelude::*,
};

#[derive(Default)]
struct TextProbes(std::collections::BTreeMap<String, (Bounds<Pixels>, String, Pixels)>);
impl Global for TextProbes {}

#[derive(Default)]
pub(crate) struct PaintedProbes(
    pub std::collections::BTreeMap<String, PaintedText>,
    Option<anyhow::Error>,
);
impl Global for PaintedProbes {}

impl PaintedProbes {
    fn record(&mut self, text: String, result: Result<PaintedText>) {
        match result {
            Ok(probe) => {
                self.0.entry(text).or_insert(probe);
            }
            Err(error) if self.1.is_none() => {
                let error = error.context(format!("native paint probe {text:?}"));
                eprintln!("SIDEBAR native paint FAIL: {error:#}");
                self.1 = Some(error);
            }
            Err(_) => {}
        }
    }
}

#[derive(Debug)]
pub(crate) struct PaintedText {
    pub bounds: Bounds<Pixels>,
    pub mask: Bounds<Pixels>,
    pub width: Pixels,
}

// Delegate every phase to the production SharedString element. Native checks
// inspect the glyph stream used by paint, not just the cached backing string.
pub(crate) struct ProbeText(pub SharedString);

impl IntoElement for ProbeText {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for ProbeText {
    type RequestLayoutState = TextLayout;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, TextLayout) {
        self.0.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut TextLayout,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.0.prepaint(id, inspector_id, bounds, state, window, cx);
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut TextLayout,
        prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.0
            .paint(id, inspector_id, bounds, state, prepaint, window, cx);
        let Some(line) = state.line_layout_for_index(0) else {
            if cx.has_global::<PaintedProbes>() {
                cx.default_global::<PaintedProbes>().record(
                    self.0.to_string(),
                    Err(anyhow::anyhow!("missing first text line")),
                );
            }
            return;
        };
        let width = line.unwrapped_layout.width;
        cx.default_global::<TextProbes>().0.insert(
            self.0.to_string(),
            (state.bounds(), state.wrapped_text(), width),
        );
        if !cx.has_global::<PaintedProbes>() {
            return;
        }
        let result = self.inspect(bounds, state, window, cx);
        cx.default_global::<PaintedProbes>()
            .record(self.0.to_string(), result);
    }
}

impl ProbeText {
    fn inspect(
        &self,
        bounds: Bounds<Pixels>,
        state: &TextLayout,
        window: &mut Window,
        _cx: &mut App,
    ) -> Result<PaintedText> {
        // Inspect the actual native glyph stream consumed by WrappedLine::paint.
        // Its backing string can be longer than the shaped font runs (GPUI 0.2.2).
        let line = state
            .line_layout_for_index(0)
            .context("missing first text line")?;
        let layout = &line.unwrapped_layout;
        let text = state.text();
        let mask = window.content_mask().bounds;
        for run in &layout.runs {
            for glyph in &run.glyphs {
                let ch = text
                    .get(glyph.index..)
                    .and_then(|text| text.chars().next())
                    .with_context(|| format!("invalid glyph source index {}", glyph.index))?;
                // Resolve the ID independently, not merely its cached source index.
                let expected = window.text_system().shape_line(
                    ch.to_string().into(),
                    layout.font_size,
                    &[window.text_style().to_run(ch.len_utf8())],
                    None,
                );
                let expected = expected
                    .runs
                    .first()
                    .and_then(|run| run.glyphs.first())
                    .context("independent glyph shaping produced no glyph")?;
                ensure!(
                    expected.id == glyph.id,
                    "painted glyph ID for {ch:?}: actual {:?}, expected {:?}",
                    glyph.id,
                    expected.id
                );
            }
        }
        let probe = PaintedText {
            bounds,
            mask,
            width: layout.width,
        };
        Ok(probe)
    }
}
