//! Placeholder runs are decoded only for changed canonical row Arcs.
use super::{Error, Placement, State};
use crate::tmux_delivery::{Color, Row, Snapshot};
use std::sync::Arc;
#[path = "diacritics.rs"]
mod diacritics;

#[derive(Clone, Copy)]
struct Cell {
    image: u32,
    row: usize,
    column: usize,
}
#[derive(Clone)]
struct Rect {
    image: u32,
    row: usize,
    column: usize,
    rows: usize,
    columns: usize,
    source_row: usize,
    source_column: usize,
}
struct CachedRow {
    source: Arc<Row>,
    runs: Vec<Rect>,
}
#[derive(Default)]
pub(super) struct Resolver {
    rows: Vec<CachedRow>,
}
const MAX_RECTS: usize = 4096;

fn decode(grapheme: &str, foreground: &Color, left: Option<Cell>) -> Option<Cell> {
    let mut points = grapheme.chars();
    if points.next()? as u32 != 0x10eeee {
        return None;
    }
    let mut mark = || {
        points.next().and_then(|point| {
            diacritics::DIACRITICS
                .iter()
                .position(|code| *code == point as u32)
        })
    };
    let marks = [mark(), mark(), mark()];
    let mut image = match foreground {
        Color::Indexed { index } => u32::from(*index),
        Color::Rgb { value } => *value & 0xffffff,
        Color::Default => 0,
    };
    if let Some(high) = marks[2] {
        image = image.checked_add(u32::try_from(high).ok()?.checked_mul(0x1000000)?)?;
    }
    let continues = left.filter(|left| marks[0].is_none_or(|row| row == left.row));
    let row = marks[0].unwrap_or_else(|| continues.map_or(0, |left| left.row));
    let column = marks[1].unwrap_or_else(|| continues.map_or(0, |left| left.column + 1));
    if marks[2].is_none()
        && let Some(left) = continues
        && image == (left.image & 0xffffff)
    {
        image = left.image;
    }
    Some(Cell { image, row, column })
}
fn runs(row: &Row, y: usize) -> Result<Vec<Rect>, Error> {
    let mut result = Vec::new();
    let mut left = None;
    let mut run: Option<Rect> = None;
    for (x, source) in row.cells().iter().enumerate() {
        let cell = decode(&source.grapheme, &source.foreground, left);
        left = cell;
        if let (Some(cell), Some(run)) = (cell, run.as_mut())
            && cell.image == run.image
            && cell.row == run.source_row
            && cell.column == run.source_column + run.columns
        {
            run.columns += 1;
            continue;
        }
        if let Some(run) = run.take() {
            result.push(run);
            if result.len() > MAX_RECTS {
                return Err(Error::Bounds);
            }
        }
        run = cell.map(|cell| Rect {
            image: cell.image,
            row: y,
            column: x,
            rows: 1,
            columns: 1,
            source_row: cell.row,
            source_column: cell.column,
        });
    }
    if let Some(run) = run {
        result.push(run);
    }
    Ok(result)
}
impl Resolver {
    pub(super) fn resolve(
        &mut self,
        snapshot: &Snapshot,
        state: &State,
    ) -> Result<Vec<(Placement, u32)>, Error> {
        let mut output = Vec::new();
        if state.images.iter().any(|image| image.placeholder.is_some()) {
            let mut previous = std::mem::take(&mut self.rows).into_iter();
            for (y, row) in snapshot.grid.iter().enumerate() {
                let cached = previous
                    .next()
                    .filter(|cached| Arc::ptr_eq(&cached.source, row));
                self.rows.push(match cached {
                    Some(cached) => cached,
                    None => CachedRow {
                        source: Arc::clone(row),
                        runs: runs(row, y)?,
                    },
                });
            }
            let mut open: Vec<Rect> = Vec::new();
            let mut done = Vec::new();
            for (y, row) in self.rows.iter().enumerate() {
                let mut next = Vec::new();
                for candidate in &row.runs {
                    let above = open.iter().position(|rect| {
                        rect.image == candidate.image
                            && rect.column == candidate.column
                            && rect.columns == candidate.columns
                            && rect.source_column == candidate.source_column
                            && rect.row + rect.rows == y
                            && rect.source_row + rect.rows == candidate.source_row
                    });
                    if let Some(index) = above {
                        let mut rect = open.remove(index);
                        rect.rows += 1;
                        next.push(rect);
                    } else {
                        next.push(candidate.clone());
                    }
                }
                done.append(&mut open);
                open = next;
                if done.len() + open.len() > MAX_RECTS {
                    return Err(Error::Bounds);
                }
            }
            done.extend(open);
            for rect in done {
                let Some(image) = state
                    .images
                    .iter()
                    .find(|image| image.image_id == rect.image)
                else {
                    continue;
                };
                let Some(grid) = &image.placeholder else {
                    continue;
                };
                if rect.source_row + rect.rows > grid.rows
                    || rect.source_column + rect.columns > grid.columns
                {
                    continue;
                }
                output.push((
                    Placement {
                        digest: image.digest.clone(),
                        row: rect.row,
                        column: rect.column,
                        rows: rect.rows,
                        columns: rect.columns,
                        source_row: rect.source_row,
                        source_column: rect.source_column,
                        total_rows: grid.rows,
                        total_columns: grid.columns,
                    },
                    image.image_id,
                ));
            }
        } else {
            self.rows.clear();
        }
        for placement in &state.placements {
            if let Some(image) = state
                .images
                .iter()
                .find(|image| image.digest == placement.digest)
            {
                output.push((placement.clone(), image.image_id));
            }
        }
        if output.len() > 256 {
            return Err(Error::Bounds);
        }
        Ok(output)
    }
}
