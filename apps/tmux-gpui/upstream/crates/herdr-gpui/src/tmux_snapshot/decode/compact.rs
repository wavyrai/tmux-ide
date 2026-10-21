//! Negotiated adapter codec. Authority and painter semantics remain in the legacy validator.
use super::*;

const MAX_CELLS: usize = 262_144;
const MAX_GRAPHEMES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(untagged)]
enum WireRow {
    Compact((bool, Vec<Run>)),
    Legacy(Row),
}
#[derive(Deserialize)]
struct Run(u32, String, u8, u32, u32, u8);

fn color(value: u32) -> Result<Color, Error> {
    match value {
        0 => Ok(Color::Default),
        0x0100_0000..=0x0100_00ff => Ok(Color::Indexed { index: value as u8 }),
        0x0200_0000..=0x02ff_ffff => Ok(Color::Rgb {
            value: value & 0xffffff,
        }),
        _ => Err(Error::Invalid("invalid packed color")),
    }
}

pub(super) fn frame(bytes: &[u8]) -> Result<(FrameData, Option<PointerModes>), Error> {
    let snapshot: Snapshot<WireRow> = serde_json::from_slice(bytes)?;
    let compact = matches!(snapshot.encoding, Encoding::RleV1);
    let cols = usize::from(snapshot.cols);
    let total_rows = snapshot
        .grid
        .len()
        .checked_add(snapshot.history.len())
        .ok_or(Error::Invalid("compact cell budget exceeded"))?;
    if cols == 0
        || snapshot.rows == 0
        || snapshot.grid.len() != usize::from(snapshot.rows)
        || total_rows
            .checked_mul(cols)
            .is_none_or(|cells| cells > MAX_CELLS)
    {
        return Err(Error::Invalid("compact cell budget exceeded"));
    }
    // Validate every count and expanded byte budget before allocating expanded cells.
    let mut graphemes = 0usize;
    for row in snapshot.grid.iter().chain(&snapshot.history) {
        match (compact, row) {
            (true, WireRow::Compact((_, runs))) => {
                let mut count = 0usize;
                for Run(repeat, text, width, fg, bg, _) in runs {
                    let repeat = *repeat as usize;
                    if repeat == 0
                        || repeat > cols
                        || text.len() > 256
                        || *width > 2
                        || text.chars().any(char::is_control)
                    {
                        return Err(Error::Invalid("invalid compact run"));
                    }
                    count += repeat;
                    if count > cols {
                        return Err(Error::Invalid("compact row overflow"));
                    }
                    graphemes += repeat * text.len();
                    if graphemes > MAX_GRAPHEMES {
                        return Err(Error::Invalid("compact grapheme budget exceeded"));
                    }
                    color(*fg)?;
                    color(*bg)?;
                }
                if count != cols {
                    return Err(Error::Invalid("compact row underflow"));
                }
            }
            (false, WireRow::Legacy(_)) => (),
            _ => return Err(Error::Invalid("snapshot encoding and rows disagree")),
        }
    }
    fn expand(rows: Vec<WireRow>) -> Result<Vec<Row>, Error> {
        rows.into_iter()
            .map(|row| match row {
                WireRow::Legacy(row) => Ok(row),
                WireRow::Compact((wrapped, runs)) => {
                    let mut cells = Vec::with_capacity(runs.iter().map(|run| run.0 as usize).sum());
                    for Run(repeat, grapheme, width, fg, bg, attributes) in runs {
                        for _ in 0..repeat {
                            cells.push(Cell {
                                grapheme: grapheme.clone(),
                                width,
                                foreground: color(fg)?,
                                background: color(bg)?,
                                attributes,
                            });
                        }
                    }
                    Ok(Row { cells, wrapped })
                }
            })
            .collect()
    }
    convert(Snapshot {
        encoding: Encoding::Legacy,
        cols: snapshot.cols,
        rows: snapshot.rows,
        grid: expand(snapshot.grid)?,
        history: expand(snapshot.history)?,
        cursor: snapshot.cursor,
        modes: snapshot.modes,
        placements: snapshot.placements,
        bootstrap: snapshot.bootstrap,
        _kitty_graphics: snapshot._kitty_graphics,
    })
}

#[cfg(test)]
mod tests;
