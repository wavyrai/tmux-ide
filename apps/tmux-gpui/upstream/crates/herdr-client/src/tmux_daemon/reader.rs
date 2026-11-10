//! The Markdown reader's file and image routes (#756). The daemon serves only
//! the file named by the pane's own option; this client never names a path.
//! Bytes arrive base64-encoded in pages so each response fits the 1 MiB read
//! limit, and the caller reassembles and decodes them.
use super::{EditorTarget, Error, ServerClient};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

/// Bytes in one page, as the daemon sends them.
pub const READER_PAGE_BYTES: u64 = 512 * 1024;
/// The largest Markdown file the daemon serves.
pub const READER_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// The largest image the daemon serves.
pub const READER_ASSET_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// A response holds one page: 512 KiB as base64 plus a little JSON.
const RESPONSE_LIMIT: usize = 1024 * 1024;

/// Where an interrupted read resumes: the revision being assembled and how many
/// of its bytes are already held.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReaderPage {
    pub revision: String,
    pub offset: u64,
}

/// A page of bytes and where it sits in the whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderChunk {
    pub revision: String,
    pub size: u64,
    pub offset: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReaderFile {
    /// `have` is still the file's revision.
    Unchanged {
        revision: String,
    },
    Page(ReaderChunk),
    /// The file changed while a read was in progress; start again.
    Changed,
    TooLarge {
        size: u64,
    },
    /// Removed, renamed or no longer a Markdown file.
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderReply {
    pub name: String,
    pub folder: String,
    pub file: ReaderFile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageMime {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReaderAsset {
    Page { mime: ImageMime, chunk: ReaderChunk },
    Changed,
    Refused,
    Missing,
    TooLarge,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum FileWire {
    Unchanged {
        version: u8,
        name: String,
        folder: String,
        revision: String,
    },
    Ok {
        version: u8,
        name: String,
        folder: String,
        revision: String,
        size: u64,
        offset: u64,
        chunk: String,
    },
    Changed {
        version: u8,
        name: String,
        folder: String,
    },
    TooLarge {
        version: u8,
        name: String,
        folder: String,
        revision: String,
        size: u64,
    },
    Missing {
        version: u8,
        name: String,
        folder: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum AssetWire {
    Ok {
        version: u8,
        mime: String,
        revision: String,
        size: u64,
        offset: u64,
        chunk: String,
    },
    Changed {
        version: u8,
    },
    Refused {
        version: u8,
    },
    Missing {
        version: u8,
    },
    TooLarge {
        version: u8,
    },
}

fn revision(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn file_name(value: &str, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty())
        && value.chars().count() <= 255
        && !value.contains('/')
        && !value.chars().any(char::is_control)
}

/// One page, checked against the request: it starts where asked, stays inside
/// the whole, and is a full page unless it is the last.
fn chunk(
    revision_value: String,
    size: u64,
    offset: u64,
    encoded: &str,
    max: u64,
    page: Option<&ReaderPage>,
) -> Result<ReaderChunk, Error> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| Error::ResourceFormat)?;
    let end = offset.saturating_add(bytes.len() as u64);
    let expected_offset = page.map_or(0, |p| p.offset);
    let full = bytes.len() as u64 == READER_PAGE_BYTES || end == size;
    if !revision(&revision_value)
        || size > max
        || offset != expected_offset
        || page.is_some_and(|p| p.revision != revision_value)
        || end > size
        || !full
    {
        return Err(Error::ResourceFormat);
    }
    Ok(ReaderChunk {
        revision: revision_value,
        size,
        offset,
        bytes,
    })
}

pub(super) fn parse_file(bytes: &[u8], page: Option<&ReaderPage>) -> Result<ReaderReply, Error> {
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Error::ResourceFormat);
    }
    let wire: FileWire = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    let (version, name, folder, file) = match wire {
        FileWire::Unchanged {
            version,
            name,
            folder,
            revision: value,
        } => {
            if page.is_some() || !revision(&value) {
                return Err(Error::ResourceFormat);
            }
            (
                version,
                name,
                folder,
                ReaderFile::Unchanged { revision: value },
            )
        }
        FileWire::Ok {
            version,
            name,
            folder,
            revision,
            size,
            offset,
            chunk: encoded,
        } => {
            let page = chunk(revision, size, offset, &encoded, READER_MAX_BYTES, page)?;
            (version, name, folder, ReaderFile::Page(page))
        }
        FileWire::Changed {
            version,
            name,
            folder,
        } => (version, name, folder, ReaderFile::Changed),
        FileWire::TooLarge {
            version,
            name,
            folder,
            revision: value,
            size,
        } => {
            if !revision(&value) || size <= READER_MAX_BYTES {
                return Err(Error::ResourceFormat);
            }
            (version, name, folder, ReaderFile::TooLarge { size })
        }
        FileWire::Missing {
            version,
            name,
            folder,
        } => (version, name, folder, ReaderFile::Missing),
    };
    if version != 1 || !file_name(&name, false) || !file_name(&folder, true) {
        return Err(Error::ResourceFormat);
    }
    Ok(ReaderReply { name, folder, file })
}

pub(super) fn parse_asset(bytes: &[u8], page: Option<&ReaderPage>) -> Result<ReaderAsset, Error> {
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Error::ResourceFormat);
    }
    let wire: AssetWire = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    let (version, asset) = match wire {
        AssetWire::Ok {
            version,
            mime,
            revision,
            size,
            offset,
            chunk: encoded,
        } => {
            let mime = match mime.as_str() {
                "image/png" => ImageMime::Png,
                "image/jpeg" => ImageMime::Jpeg,
                "image/gif" => ImageMime::Gif,
                "image/webp" => ImageMime::Webp,
                "image/svg+xml" => ImageMime::Svg,
                _ => return Err(Error::ResourceFormat),
            };
            let chunk = chunk(
                revision,
                size,
                offset,
                &encoded,
                READER_ASSET_MAX_BYTES,
                page,
            )?;
            (version, ReaderAsset::Page { mime, chunk })
        }
        AssetWire::Changed { version } => (version, ReaderAsset::Changed),
        AssetWire::Refused { version } => (version, ReaderAsset::Refused),
        AssetWire::Missing { version } => (version, ReaderAsset::Missing),
        AssetWire::TooLarge { version } => (version, ReaderAsset::TooLarge),
    };
    if version != 1 {
        return Err(Error::ResourceFormat);
    }
    Ok(asset)
}

impl ServerClient {
    fn reader_post(
        &self,
        target: &EditorTarget,
        route: &str,
        body: &[u8],
    ) -> Result<Vec<u8>, Error> {
        self.assert_current()?;
        if !target.valid() {
            return Err(Error::ActionInput);
        }
        if target.generation != self.scope().generation {
            return Err(Error::ServerChanged);
        }
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/{route}",
            scope.server_id, scope.generation
        );
        let result = self.daemon.post_resource(&path, body);
        self.assert_current()?;
        result
    }

    /// One read of the reader pane's file: `have` is the revision already shown,
    /// `page` the read in progress.
    pub fn pane_reader(
        &self,
        target: &EditorTarget,
        have: Option<&str>,
        page: Option<&ReaderPage>,
    ) -> Result<ReaderReply, Error> {
        if have.is_some_and(|h| !revision(h)) || page.is_some_and(|p| !revision(&p.revision)) {
            return Err(Error::ActionInput);
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "target": target, "have": have, "page": page,
        }))
        .map_err(|_| Error::ActionInput)?;
        parse_file(&self.reader_post(target, "reader", &body)?, page)
    }

    /// One page of an image the document names, as written in it. The daemon
    /// refuses anything with a scheme and anything outside the file's folder or
    /// its git repository.
    pub fn pane_reader_asset(
        &self,
        target: &EditorTarget,
        src: &str,
        page: Option<&ReaderPage>,
    ) -> Result<ReaderAsset, Error> {
        if src.is_empty() || src.len() > 2048 || page.is_some_and(|p| !revision(&p.revision)) {
            return Err(Error::ActionInput);
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "target": target, "src": src, "page": page,
        }))
        .map_err(|_| Error::ActionInput)?;
        parse_asset(&self.reader_post(target, "reader/asset", &body)?, page)
    }
}

#[cfg(test)]
#[path = "reader_tests.rs"]
mod tests;
