//! The `-live` flood scenarios: each frame's rows are decoded afresh from the
//! compact wire format, as a delivered patch's rows are, and projected by the
//! live app's `DirectProjection`. `frame_at` instead reuses one `Arc` per pool
//! row, which no live publication does.
use super::super::super::direct_projection::{DirectProjection, PaneSurface};
use super::super::super::hit_regions::Region;
use crate::terminal_painter::NativeFrame;
use anyhow::anyhow;
use herdr_client::protocol::CellData;
use herdr_client::tmux_delivery::{Update, decode_compact};
use std::{sync::Arc, time::Instant};

pub(super) struct LiveFeed {
    /// Each pool row in the compact wire format.
    rows: Vec<String>,
    cols: usize,
    height: usize,
    projection: DirectProjection,
    region: Region,
    /// Projection time per frame (off the clock: the transport thread's).
    pub(super) projection_ms: Vec<f64>,
}

fn wire_color(color: u32) -> String {
    match color >> 24 {
        1 => format!("[1,{}]", color & 0xff),
        2 => format!("[2,{}]", color & 0xff_ffff),
        _ => "0".into(),
    }
}

fn wire_row(row: &[CellData]) -> String {
    let runs: Vec<String> = row
        .iter()
        .map(|cell| {
            let width = if cell.skip {
                0
            } else {
                unicode_width::UnicodeWidthStr::width(cell.symbol.as_str()).clamp(1, 2)
            };
            format!(
                "[1,{},{width},{},{},{}]",
                serde_json::Value::String(cell.symbol.clone()),
                wire_color(cell.fg),
                wire_color(cell.bg),
                cell.modifier & 0x0f,
            )
        })
        .collect();
    format!("[0,[{}]]", runs.join(","))
}

impl LiveFeed {
    pub(super) fn new(pool: &[Arc<[CellData]>], cols: usize, height: usize) -> Self {
        Self {
            rows: pool.iter().map(|row| wire_row(row)).collect(),
            cols,
            height,
            projection: DirectProjection::default(),
            region: Region {
                id: "pane-a".into(),
                left: 0,
                top: 0,
                width: u16::try_from(cols).unwrap_or(u16::MAX),
                height: u16::try_from(height).unwrap_or(u16::MAX),
            },
            projection_ms: Vec::new(),
        }
    }

    /// The frame scrolled to `scroll`, decoded and projected.
    pub(super) fn frame(&mut self, scroll: usize) -> anyhow::Result<Arc<NativeFrame>> {
        let grid: Vec<&str> = (0..self.height)
            .map(|y| self.rows[(scroll + y) % self.rows.len()].as_str())
            .collect();
        let bytes = format!(
            r#"{{"v":1,"k":"terminal-semantic-compact","f":"s","r":{scroll},"s":[{},{},[{}],[],[0,{},0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]}}"#,
            self.cols,
            self.height,
            grid.join(","),
            self.height - 1,
        );
        let snapshot = match decode_compact(bytes.as_bytes())? {
            Update::Seed { snapshot, .. } => snapshot,
            _ => return Err(anyhow!("live feed: expected a seed")),
        };
        let started = Instant::now();
        let projected = self.projection.project(
            u16::try_from(self.cols)?,
            u16::try_from(self.height)?,
            &[PaneSurface {
                region: &self.region,
                snapshot: &snapshot,
            }],
            "pane-a",
        )?;
        self.projection_ms
            .push(started.elapsed().as_secs_f64() * 1000.);
        Ok(projected.frame)
    }
}
