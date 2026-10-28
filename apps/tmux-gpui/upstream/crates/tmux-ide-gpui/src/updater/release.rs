//! Blocking release transport and authentication. Run only on a worker thread.
//! The caller supplies the compile-time HERDR_UPDATE_PUBLIC_KEY, never a secret.

use super::error::{Result, UpdateError as Error};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MANIFEST_LIMIT: usize = 64 * 1024;
const ARCHIVE_LIMIT: u64 = 256 * 1024 * 1024;
const METADATA_LIMIT: usize = 1024 * 1024;
const LATEST_URL: &str = "https://api.github.com/repos/penso/herdr-gpui/releases/latest";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub(super) schema: u32,
    pub(super) version: String,
    pub(super) assets: Vec<Asset>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Asset {
    pub(super) target: String,
    pub(super) name: String,
    pub(super) size: u64,
    pub(super) sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Offer {
    pub(super) manifest: Manifest,
    pub(super) asset: Asset,
    pub(super) manifest_bytes: Vec<u8>,
    pub(super) signature: Vec<u8>,
}

/// Releases are calendar versions: an eight-digit `YYYYMMDD` date and a same-day
/// counter starting at 1. Both components compare numerically, so publication
/// order is version order.
pub(super) fn parse_version(value: &str) -> Option<(u64, u64)> {
    let (date, counter) = value.split_once('.')?;
    if date.len() != 8
        || date.starts_with('0')
        || !date.bytes().all(|byte| byte.is_ascii_digit())
        || counter.is_empty()
        || counter.starts_with('0')
        || !counter.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((date.parse().ok()?, counter.parse().ok()?))
}

pub(super) fn target() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("universal-apple-darwin")
    } else if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu"
    )) {
        Some("x86_64-unknown-linux-gnu")
    } else if cfg!(all(
        target_os = "linux",
        target_arch = "aarch64",
        target_env = "gnu"
    )) {
        Some("aarch64-unknown-linux-gnu")
    } else {
        None
    }
}

fn hex32(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64 {
        return Err(Error::InvalidHex);
    }
    let mut result = [0; 32];
    for (out, pair) in result.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        let digit = |b| match b {
            b'0'..=b'9' => Ok(b - b'0'),
            b'a'..=b'f' => Ok(b - b'a' + 10),
            _ => Err(Error::InvalidHex),
        };
        *out = digit(pair[0])? * 16 + digit(pair[1])?;
    }
    Ok(result)
}

fn asset_name(version: &str, target: &str) -> Result<String> {
    let suffix = match target {
        "universal-apple-darwin" => "macos-universal.app",
        "x86_64-unknown-linux-gnu" => "x86_64-unknown-linux-gnu-update",
        "aarch64-unknown-linux-gnu" => "aarch64-unknown-linux-gnu-update",
        _ => return Err(Error::UnsupportedTarget),
    };
    Ok(format!("herdr-gpui-{version}-{suffix}.tar.gz"))
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.schema != 1 || parse_version(&manifest.version).is_none() {
        return Err(Error::ManifestSchema);
    }
    if manifest.assets.is_empty() || manifest.assets.len() > 3 {
        return Err(Error::ManifestAssetCount);
    }
    for (index, asset) in manifest.assets.iter().enumerate() {
        if asset.name != asset_name(&manifest.version, &asset.target)?
            || manifest.assets[..index]
                .iter()
                .any(|other| other.target == asset.target)
        {
            return Err(Error::ManifestAsset);
        }
        validate_digest(asset)?;
    }
    Ok(())
}

fn validate_digest(asset: &Asset) -> Result<[u8; 32]> {
    if asset.size == 0 || asset.size > ARCHIVE_LIMIT {
        return Err(Error::ArchiveSize);
    }
    hex32(&asset.sha256)
}

pub(super) fn verify_manifest(
    bytes: &[u8],
    signature: &[u8],
    key_hex: &str,
    expected_version: &str,
) -> Result<Manifest> {
    if bytes.len() > MANIFEST_LIMIT || parse_version(expected_version).is_none() {
        return Err(Error::ManifestBounds);
    }
    let key = VerifyingKey::from_bytes(&hex32(key_hex)?).map_err(Error::PublicKey)?;
    let signature = Signature::from_slice(signature).map_err(Error::SignatureLength)?;
    key.verify_strict(bytes, &signature)
        .map_err(Error::Signature)?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(Error::ManifestJson)?;
    validate_manifest(&manifest)?;
    if manifest.version != expected_version {
        return Err(Error::ManifestVersion);
    }
    Ok(manifest)
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

fn release_url(version: &str, name: &str) -> String {
    format!("https://github.com/penso/herdr-gpui/releases/download/v{version}/{name}")
}

fn allowed_url(value: &str) -> bool {
    let Ok(uri) = value.parse::<ureq::http::Uri>() else {
        return false;
    };
    uri.scheme_str() == Some("https")
        && uri.authority().is_some_and(|authority| {
            matches!(
                authority.as_str(),
                "api.github.com" | "github.com" | "release-assets.githubusercontent.com"
            )
        })
        && !value.contains('#')
}

#[derive(Clone, Copy)]
enum RequestProfile {
    Metadata,
    // Only the POSIX installer downloads a release archive; see
    // `updater::unsupported`.
    #[cfg_attr(not(unix), allow(dead_code))]
    Archive,
}

fn request_config(profile: RequestProfile) -> ureq::config::Config {
    let (total, body) = match profile {
        RequestProfile::Metadata => (120, 30),
        RequestProfile::Archive => (600, 600),
    };
    // ureq body/per-call timeouts are total deadlines, not idle-read limits.
    // Its standard transport exposes no independent per-read timeout: cancellation
    // can await the remaining body deadline if the current read stalls.
    ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(total)))
        .timeout_resolve(Some(Duration::from_secs(10)))
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_send_request(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(Duration::from_secs(body)))
        .build()
}

fn request(
    url: &str,
    profile: RequestProfile,
    cancel: &AtomicBool,
) -> Result<ureq::http::Response<ureq::Body>> {
    let agent: ureq::Agent = request_config(profile).into();
    let mut url = url.to_owned();
    for redirects in 0..=5 {
        cancelled(cancel)?;
        if !allowed_url(&url) {
            return Err(Error::UntrustedUrl);
        }
        let response = agent
            .get(&url)
            .header("User-Agent", "herdr-gpui-updater")
            .header(
                "Accept",
                if url == LATEST_URL {
                    "application/vnd.github+json"
                } else {
                    "application/octet-stream"
                },
            )
            .header("Accept-Encoding", "identity")
            .call()
            .map_err(|source| Error::Http(Box::new(source)))?;
        match response.status().as_u16() {
            200 => return Ok(response),
            301 | 302 | 303 | 307 | 308 if redirects < 5 => {
                // GitHub download redirects are absolute. Reject relative URLs rather
                // than introducing an additional URL resolution policy.
                url = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| value.len() <= 8192)
                    .ok_or(Error::InvalidRedirect)?
                    .to_owned();
            }
            status => return Err(Error::HttpStatus(status)),
        }
    }
    Err(Error::RedirectLimit)
}

fn read_bounded(mut reader: impl Read, limit: usize, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        cancelled(cancel)?;
        let count = reader.read(&mut buffer).map_err(Error::ReadUpdate)?;
        if count == 0 {
            cancelled(cancel)?;
            return Ok(bytes);
        }
        if count > limit.saturating_sub(bytes.len()) {
            return Err(Error::ResponseLimit);
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

#[derive(Deserialize)]
struct Release {
    #[serde(rename = "tag_name")]
    version: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

fn parse_release(bytes: &[u8]) -> Result<Release> {
    if bytes.len() > METADATA_LIMIT {
        return Err(Error::MetadataLimit);
    }
    let mut release: Release = serde_json::from_slice(bytes).map_err(Error::ReleaseJson)?;
    let version = release
        .version
        .strip_prefix('v')
        .ok_or(Error::ReleaseVersion)?;
    if release.draft || release.prerelease || parse_version(version).is_none() {
        return Err(Error::UnstableRelease);
    }
    release.version = version.to_owned();
    if release.assets.len() > 128 {
        return Err(Error::ReleaseAssetCount);
    }
    for (index, asset) in release.assets.iter().enumerate() {
        if asset.name.is_empty()
            || asset.name.len() > 255
            || !asset
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            || asset.name == "."
            || asset.name == ".."
            || asset.size == 0
            || asset.size > ARCHIVE_LIMIT
            || asset.browser_download_url != release_url(&release.version, &asset.name)
            || release.assets[..index]
                .iter()
                .any(|other| other.name == asset.name)
        {
            return Err(Error::ReleaseAsset);
        }
    }
    Ok(release)
}

pub(super) fn check(
    current_version: &str,
    key_hex: &str,
    cancel: &AtomicBool,
) -> Result<Option<Offer>> {
    cancelled(cancel)?;
    let current = parse_version(current_version).ok_or(Error::CurrentVersion)?;
    VerifyingKey::from_bytes(&hex32(key_hex)?).map_err(Error::PublicKey)?;
    let Some(target) = target() else {
        return Ok(None);
    };
    let metadata = read_bounded(
        request(LATEST_URL, RequestProfile::Metadata, cancel)?
            .into_body()
            .into_reader(),
        METADATA_LIMIT,
        cancel,
    )?;
    let release = parse_release(&metadata)?;
    if parse_version(&release.version).ok_or(Error::ReleaseVersion)? <= current {
        return Ok(None);
    }
    for (name, limit) in [
        ("update-manifest.json", MANIFEST_LIMIT as u64),
        ("update-manifest.sig", 64),
    ] {
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .ok_or(Error::MissingSignedMetadata)?;
        if asset.size > limit || (name == "update-manifest.sig" && asset.size != 64) {
            return Err(Error::SignedMetadataSize);
        }
    }
    let fetch = |name, limit| {
        read_bounded(
            request(
                &release_url(&release.version, name),
                RequestProfile::Metadata,
                cancel,
            )?
            .into_body()
            .into_reader(),
            limit,
            cancel,
        )
    };
    let manifest_bytes = fetch("update-manifest.json", MANIFEST_LIMIT)?;
    let signature = fetch("update-manifest.sig", 64)?;
    let manifest = verify_manifest(&manifest_bytes, &signature, key_hex, &release.version)?;
    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.target == target)
        .ok_or(Error::MissingPlatformAsset)?
        .clone();
    if !release
        .assets
        .iter()
        .any(|metadata| metadata.name == asset.name && metadata.size == asset.size)
    {
        return Err(Error::ArchiveMetadata);
    }
    cancelled(cancel)?;
    Ok(Some(Offer {
        manifest,
        asset,
        manifest_bytes,
        signature,
    }))
}

// Only the POSIX installer downloads a release archive (see
// `updater::unsupported`). These stay compiled and tested everywhere because
// they are portable; they are simply unreachable where the updater is disabled.
#[cfg_attr(not(unix), allow(dead_code))]
fn copy_archive(
    mut reader: impl Read,
    mut writer: impl Write,
    asset: &Asset,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    let expected_hash = validate_digest(asset)?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0; 64 * 1024];
    cancelled(cancel)?;
    progress(0, asset.size);
    loop {
        cancelled(cancel)?;
        let count = reader.read(&mut buffer).map_err(Error::ReadArchive)?;
        cancelled(cancel)?;
        if count == 0 {
            break;
        }
        if count as u64 > asset.size - total {
            return Err(Error::ArchiveExceedsSize);
        }
        writer
            .write_all(&buffer[..count])
            .map_err(Error::WriteArchive)?;
        hash.update(&buffer[..count]);
        total += count as u64;
        progress(total, asset.size);
    }
    if total != asset.size || hash.finalize().as_slice() != expected_hash {
        return Err(Error::ArchiveDigest);
    }
    cancelled(cancel)
}

// Only the POSIX installer downloads a release archive (see
// `updater::unsupported`). These stay compiled and tested everywhere because
// they are portable; they are simply unreachable where the updater is disabled.
#[cfg_attr(not(unix), allow(dead_code))]
fn create_archive(destination: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(destination).map_err(Error::CreateArchive)
}

/// Requires an offer authenticated by `check`/`verify_manifest`. On error, the
/// caller owns cleanup of its private staging directory, including partial files.
/// Cancellation is checked between reads; a stalled read can wait for the
/// remaining ten-minute request deadline. Never wait for this worker on the UI thread.
// Only the POSIX installer downloads a release archive (see
// `updater::unsupported`). These stay compiled and tested everywhere because
// they are portable; they are simply unreachable where the updater is disabled.
#[cfg_attr(not(unix), allow(dead_code))]
pub(super) fn download(
    offer: &Offer,
    destination: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> Result<()> {
    cancelled(cancel)?;
    validate_manifest(&offer.manifest)?;
    if !offer.manifest.assets.contains(&offer.asset)
        || Some(offer.asset.target.as_str()) != target()
    {
        return Err(Error::OfferAsset);
    }
    let response = request(
        &release_url(&offer.manifest.version, &offer.asset.name),
        RequestProfile::Archive,
        cancel,
    )?;
    cancelled(cancel)?;
    let mut file = create_archive(destination)?;
    copy_archive(
        response.into_body().into_reader(),
        &mut file,
        &offer.asset,
        cancel,
        progress,
    )?;
    file.sync_all().map_err(Error::SyncArchive)?;
    cancelled(cancel)
}

/// Recheck a staged archive against an authenticated asset immediately before
/// extraction. The caller must keep the staging directory private throughout.
// Only the POSIX installer downloads a release archive (see
// `updater::unsupported`). These stay compiled and tested everywhere because
// they are portable; they are simply unreachable where the updater is disabled.
#[cfg_attr(not(unix), allow(dead_code))]
pub(super) fn verify_archive(path: &Path, asset: &Asset, cancel: &AtomicBool) -> Result<()> {
    cancelled(cancel)?;
    let file = File::open(path).map_err(Error::OpenArchive)?;
    copy_archive(file, std::io::sink(), asset, cancel, |_, _| {})
}

#[cfg(test)]
mod tests;
