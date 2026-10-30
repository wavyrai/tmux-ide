//! Surface geometry the client negotiates with, and the bounds it is validated
//! against before any of it reaches the wire.

use crate::protocol::ClientSurfaceSize;

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
