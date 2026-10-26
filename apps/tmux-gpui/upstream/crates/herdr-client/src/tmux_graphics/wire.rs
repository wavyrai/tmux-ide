use super::{Error, MAX_IMAGE_BYTES};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    Png,
    Rgba,
    Rgb,
    RgbaZlib,
    RgbZlib,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Placeholder {
    pub columns: usize,
    pub rows: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Image {
    pub image_id: u32,
    pub digest: String,
    pub format: Format,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub placeholder: Option<Placeholder>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Placement {
    pub digest: String,
    pub row: usize,
    pub column: usize,
    pub rows: usize,
    pub columns: usize,
    pub source_row: usize,
    pub source_column: usize,
    pub total_rows: usize,
    pub total_columns: usize,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct State {
    pub revision: u64,
    pub images: Vec<Image>,
    pub placements: Vec<Placement>,
    pub cell_pixels: Option<bool>,
    pub precise_cell_pixels: Option<bool>,
    pub binary_blobs: Option<bool>,
    pub compressed_blobs: Option<bool>,
    pub local_files: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Blob {
    pub digest: String,
    pub format: Format,
    pub width: u32,
    pub height: u32,
    pub total: usize,
    pub offset: usize,
}
#[derive(Debug, Serialize)]
pub struct ImageMetadata {
    #[serde(flatten)]
    pub blob: Blob,
    pub image: String,
}
#[derive(Debug, Serialize)]
pub struct KeyedPlacement {
    #[serde(flatten)]
    pub placement: Placement,
    pub image: String,
}

pub(super) fn digest(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn dimensions(format: Format, width: u32, height: u32, bytes: usize) -> bool {
    if !(1..=10_000).contains(&width)
        || !(1..=10_000).contains(&height)
        || bytes == 0
        || bytes > MAX_IMAGE_BYTES
    {
        return false;
    }
    let pixels = u64::from(width) * u64::from(height);
    match format {
        Format::Rgba => pixels * 4 == bytes as u64,
        Format::Rgb => pixels * 3 == bytes as u64,
        Format::RgbaZlib => pixels * 4 <= MAX_IMAGE_BYTES as u64,
        Format::RgbZlib => pixels * 3 <= MAX_IMAGE_BYTES as u64,
        Format::Png => true,
    }
}
impl State {
    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.revision > (1_u64 << 53) - 1
            || self.images.len() > 256
            || self.placements.len() > 256
            || self.cell_pixels == Some(false)
            || self.precise_cell_pixels == Some(false)
            || self.binary_blobs == Some(false)
            || self.compressed_blobs == Some(false)
            || (self.compressed_blobs == Some(true) && self.binary_blobs != Some(true))
            || self.local_files == Some(false)
        {
            return Err(Error::Bounds);
        }
        let mut ids = std::collections::BTreeSet::new();
        for image in &self.images {
            if !digest(&image.digest)
                || !ids.insert(image.image_id)
                || !dimensions(image.format, image.width, image.height, image.bytes)
                || image.placeholder.as_ref().is_some_and(|p| {
                    !(1..=1000).contains(&p.rows) || !(1..=1000).contains(&p.columns)
                })
            {
                return Err(Error::Metadata);
            }
        }
        for placement in &self.placements {
            placement.validate()?;
        }
        Ok(())
    }
}
impl Placement {
    pub(super) fn validate(&self) -> Result<(), Error> {
        if !digest(&self.digest)
            || [self.row, self.column, self.source_row, self.source_column]
                .into_iter()
                .any(|n| n > 1000)
            || [self.rows, self.columns, self.total_rows, self.total_columns]
                .into_iter()
                .any(|n| !(1..=1000).contains(&n))
            || self.source_row + self.rows > self.total_rows
            || self.source_column + self.columns > self.total_columns
        {
            return Err(Error::Metadata);
        }
        Ok(())
    }
    pub(super) fn clipped(mut self, rows: usize, cols: usize) -> Option<Self> {
        self.rows = self.rows.min(rows.saturating_sub(self.row));
        self.columns = self.columns.min(cols.saturating_sub(self.column));
        (self.rows > 0 && self.columns > 0).then_some(self)
    }
}
impl Blob {
    pub(super) fn matches(&self, image: &Image) -> bool {
        self.digest == image.digest
            && self.format == image.format
            && self.width == image.width
            && self.height == image.height
            && self.total == image.bytes
            && self.offset < self.total
            && dimensions(self.format, self.width, self.height, self.total)
    }
}
