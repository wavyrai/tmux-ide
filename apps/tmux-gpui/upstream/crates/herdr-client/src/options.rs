//! Surface geometry the client negotiates with, and the bounds it is validated
//! against before any of it reaches the wire.

use crate::{Error, Result, protocol::ClientSurfaceSize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectOptions {
    pub surface_size: ClientSurfaceSize,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}
impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            surface_size: ClientSurfaceSize { cols: 80, rows: 24 },
            cell_width_px: 0,
            cell_height_px: 0,
        }
    }
}

pub(crate) fn validate_options(options: ConnectOptions) -> Result<()> {
    let size = options.surface_size;
    if size.cols == 0 || size.rows == 0 {
        return Err(Error::EmptySurface);
    }
    if size.cols > 4096
        || size.rows > 4096
        || u32::from(size.cols) * u32::from(size.rows) > 1_000_000
        || options.cell_width_px > 4096
        || options.cell_height_px > 4096
    {
        return Err(Error::GeometryLimit);
    }
    Ok(())
}
