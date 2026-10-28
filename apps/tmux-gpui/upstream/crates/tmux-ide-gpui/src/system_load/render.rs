//! Drawing a host's load: a CPU sparkline and a memory meter with their
//! shares in the status bar and on roomy host rows, two small gauges after a
//! compact host's name, and the details in a tooltip.

use super::{HISTORY, Reading, sample::Memory};
use crate::{
    config::{Theme, status_bar::Detail},
    usage::Host,
    window::HerdrWindow,
};
use gpui::{prelude::*, *};

const BAR_WIDTH: f32 = 2.;
const BAR_GAP: f32 = 1.;
const GRAPH_HEIGHT: f32 = 11.;
const METER_WIDTH: f32 = 32.;
const GAUGE_WIDTH: f32 = 3.;
const ITEM_GAP: f32 = 5.;
/// Glyphs a share takes at most: `100%`.
const SHARE_GLYPHS: f32 = 4.;
const CPU_WARN: f32 = 75.;
const MEMORY_WARN: f32 = 80.;
const CRITICAL: f32 = 90.;

impl HerdrWindow {
    /// The selected host's load; nothing while hidden or before the host's
    /// first answer.
    pub(crate) fn render_system_load(&self) -> Option<impl IntoElement> {
        if !self.config.show_system_load {
            return None;
        }
        let host = self.selected_host()?;
        let reading = self.system_load.get(&host)?;
        let theme = &self.theme;
        let segment = div()
            .id("system-load")
            .debug_selector(|| "system-load".into())
            .flex()
            .flex_none()
            .items_center()
            .px(px(6.))
            .h_full()
            .tooltip(tooltip(reading, &host, theme));
        if reading.latest().is_none() {
            // A host that never answered says so; one still starting shows nothing.
            reading.error()?;
            return Some(
                segment.child(
                    div()
                        .text_color(rgb(theme.muted))
                        .child("CPU and memory unavailable"),
                ),
            );
        }
        Some(segment.child(line(
            reading,
            theme,
            None,
            self.config.status_bar.system_load,
        )))
    }
}

/// A tooltip naming the host, its cores, load, and memory in gigabytes.
pub(crate) fn tooltip(
    reading: &Reading,
    host: &Host,
    theme: &Theme,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = SharedString::from(details(reading, host));
    let (foreground, surface) = (theme.foreground, theme.surface);
    move |_, cx| {
        cx.new(|_| crate::usage::Hint {
            text: text.clone(),
            foreground,
            surface,
        })
        .into()
    }
}

/// `CPU ▁▃▂▅ 12%  MEM ━━─ 61%`, or `CPU 12%  MEM 61%` when compact. `glyph`
/// fixes each share's width so a row's columns do not shift as numbers
/// change; None lets them size.
pub(crate) fn line(reading: &Reading, theme: &Theme, glyph: Option<f32>, detail: Detail) -> Div {
    let graphs = detail == Detail::Detailed;
    let Some(sample) = reading.latest() else {
        return div().text_color(rgb(theme.muted)).child("CPU and memory…");
    };
    // The numbers are the last good ones while a refresh fails.
    let stale = reading.error().is_some();
    let label = |name: &'static str| div().flex_none().text_color(rgb(theme.muted)).child(name);
    let mut cpu = div()
        .debug_selector(|| "system-load-cpu".into())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(ITEM_GAP))
        .child(label("CPU"))
        .when(graphs, |cpu| cpu.child(sparkline(reading.history(), theme)));
    if let Some(value) = sample.cpu {
        cpu = cpu.child(share(value, CPU_WARN, stale, theme, glyph));
    }
    let memory = sample.memory.map(|memory| {
        div()
            .debug_selector(|| "system-load-memory".into())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(ITEM_GAP))
            .child(label("MEM"))
            .when(graphs, |row| row.child(meter(memory, theme)))
            .child(share(memory.percent(), MEMORY_WARN, stale, theme, glyph))
    });
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .overflow_hidden()
        .child(cpu)
        .children(memory)
}

/// Two vertical gauges with their shares, for a host row with no room for a
/// second line, and the width they take.
pub(crate) fn gauges(reading: &Reading, theme: &Theme, glyph: f32, height: f32) -> (f32, Div) {
    let item_width = GAUGE_WIDTH + 2. + glyph * SHARE_GLYPHS;
    let width = 2. * item_width + ITEM_GAP;
    let Some(sample) = reading.latest() else {
        return (width, div().w(px(width)).flex_none());
    };
    let stale = reading.error().is_some();
    let item = |value: f32, warn: f32| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(2.))
            .child(gauge(value, warn, height, theme))
            .child(share(value, warn, stale, theme, Some(glyph)))
    };
    let mut row = div()
        .debug_selector(|| "system-load-gauges".into())
        .w(px(width))
        .flex()
        .flex_none()
        .justify_end()
        .items_center()
        .gap(px(ITEM_GAP));
    if let Some(cpu) = sample.cpu {
        row = row.child(item(cpu, CPU_WARN));
    }
    if let Some(memory) = sample.memory {
        row = row.child(item(memory.percent(), MEMORY_WARN));
    }
    (width, row)
}

fn share(value: f32, warn: f32, stale: bool, theme: &Theme, glyph: Option<f32>) -> Div {
    div()
        .flex_none()
        .when_some(glyph, |text, glyph| {
            text.w(px(glyph * SHARE_GLYPHS)).flex().justify_end()
        })
        .when(glyph.is_none(), |text| text.min_w(px(28.)))
        .text_color(rgb(if stale {
            theme.muted
        } else {
            severity(value, warn, theme, theme.foreground)
        }))
        .child(format!("{value:.0}%"))
}

fn severity(value: f32, warn: f32, theme: &Theme, normal: u32) -> u32 {
    if value >= CRITICAL {
        theme.ink(theme.palette[1])
    } else if value >= warn {
        theme.ink(theme.palette[3])
    } else {
        normal
    }
}

/// Oldest on the left; empty slots wait on the left until history fills.
fn sparkline(history: impl ExactSizeIterator<Item = f32>, theme: &Theme) -> Div {
    let empty = HISTORY.saturating_sub(history.len());
    let bars = std::iter::repeat_n(None, empty)
        .chain(history.map(Some))
        .map(|value| {
            let bar = div().w(px(BAR_WIDTH)).flex_none().rounded(px(0.5));
            match value {
                Some(value) => bar
                    .h(px((GRAPH_HEIGHT * value / 100.).max(1.)))
                    .bg(rgb(severity(value, CPU_WARN, theme, theme.muted))),
                None => bar.h(px(1.)).bg(rgb(theme.active)),
            }
        });
    div()
        .flex()
        .flex_none()
        .items_end()
        .gap(px(BAR_GAP))
        .h(px(GRAPH_HEIGHT))
        .children(bars)
}

fn meter(memory: Memory, theme: &Theme) -> Div {
    let used = memory.percent();
    div()
        .w(px(METER_WIDTH))
        .h(px(5.))
        .flex_none()
        .rounded_full()
        .overflow_hidden()
        .bg(rgb(theme.active))
        .child(
            div()
                .h_full()
                .w(px(METER_WIDTH * used / 100.))
                .rounded_full()
                .bg(rgb(severity(used, MEMORY_WARN, theme, theme.muted))),
        )
}

/// A meter standing up, filling from the bottom.
fn gauge(value: f32, warn: f32, height: f32, theme: &Theme) -> Div {
    div()
        .w(px(GAUGE_WIDTH))
        .h(px(height))
        .flex()
        .flex_col()
        .justify_end()
        .flex_none()
        .rounded(px(1.))
        .overflow_hidden()
        .bg(rgb(theme.active))
        .child(
            div()
                .w_full()
                .h(px((height * value / 100.).max(1.)))
                .bg(rgb(severity(value, warn, theme, theme.muted))),
        )
}

fn details(reading: &Reading, host: &Host) -> String {
    let mut lines = vec![match host {
        Host::Local => "This machine".to_owned(),
        Host::Ssh(target) => target.clone(),
        Host::Wsl(distro) => format!("WSL · {distro}"),
    }];
    if let Some(sample) = reading.latest() {
        let mut cpu = match sample.cpu {
            Some(value) => format!("CPU {value:.0}%"),
            None => "CPU measuring…".to_owned(),
        };
        if let Some(cores) = sample.cores {
            cpu.push_str(&format!(" of {cores} cores"));
        }
        if let Some([one, five, fifteen]) = sample.load {
            cpu.push_str(&format!(" · load {one:.2} {five:.2} {fifteen:.2}"));
        }
        lines.push(cpu);
        if let Some(memory) = sample.memory {
            lines.push(format!(
                "Memory {} of {} ({:.0}%)",
                gigabytes(memory.used),
                gigabytes(memory.total),
                memory.percent()
            ));
        }
    }
    if let Some(error) = reading.error() {
        lines.push(error.to_owned());
    }
    lines.join("\n")
}

/// Binary gigabytes, as Activity Monitor and `free -h` count them.
pub(super) fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / f64::from(1u32 << 30))
}
