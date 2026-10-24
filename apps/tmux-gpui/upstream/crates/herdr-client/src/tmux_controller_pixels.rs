use super::*;
/// Device-pixel metrics, independent of terminal grid geometry or its lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellPixels {
    pub width: u32,
    pub height: u32,
    pub precise: Option<(u32, u32)>,
}
impl CellPixels {
    fn validate(&self) -> Result<(), Error> {
        if !(1..=1024).contains(&self.width)
            || !(1..=1024).contains(&self.height)
            || self.precise.is_some_and(|(w, h)| {
                !(1000..=1_024_000).contains(&w) || !(1000..=1_024_000).contains(&h)
            })
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
impl Controller {
    /// Retained until the daemon confirms support; repeated metrics do not resize tmux.
    pub fn set_cell_pixels(&mut self, pixels: CellPixels) -> Result<(), Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        pixels.validate()?;
        self.cell_pixels = Some(pixels);
        Ok(())
    }
    pub(super) fn flush_cell_pixels(
        &mut self,
        supported: bool,
        precise_supported: bool,
    ) -> Result<(), Error> {
        if !supported {
            return Ok(());
        }
        let Some(mut pixels) = self.cell_pixels.clone() else {
            return Ok(());
        };
        if !precise_supported {
            pixels.precise = None;
        }
        if self.sent_cell_pixels.as_ref() == Some(&pixels) {
            return Ok(());
        }
        let mut value =
            json!({"type":"terminal-cell-pixels","width":pixels.width,"height":pixels.height});
        if let Some((width, height)) = pixels.precise {
            value["precise"] = json!({"width":width,"height":height});
        }
        let command = tmux_stream::Command::from_json(value.to_string())?;
        if let Err(error) = self.session.try_send(command) {
            self.retire();
            return Err(error.into());
        }
        self.sent_cell_pixels = Some(pixels);
        Ok(())
    }
}
