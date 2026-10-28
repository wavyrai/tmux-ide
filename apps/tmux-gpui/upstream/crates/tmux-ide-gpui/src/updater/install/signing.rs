//! The macOS code signature checks: a bundle must satisfy Herdr's designated
//! requirement, carry the expected version, and keep its signing identity.
use super::output;
use crate::updater::error::{Result, UpdateError as Error};
use std::{path::Path, process::Command, sync::atomic::AtomicBool};

// codesign and csreq read a bare `-R` argument as the path of a compiled
// requirement file; the leading `=` is what marks the rest as source text.
// Without it every verification exits 1 with "invalid requirement
// specification", which fails closed but blocks all updates.
pub(super) const REQUIREMENT: &str = "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier \"so.pen.herdr-gpui\"";

pub(super) fn identity(
    bundle: &Path,
    version: &str,
    cancel: &AtomicBool,
) -> Result<(String, String)> {
    output(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "-R", REQUIREMENT])
            .arg(bundle),
        cancel,
    )?;
    let text = output(
        Command::new("/usr/bin/codesign")
            .args(["--display", "--verbose=4"])
            .arg(bundle),
        cancel,
    )?;
    let identity = signing_identity(&text)?;
    for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
        let actual = output(
            Command::new("/usr/bin/plutil")
                .args(["-extract", key, "raw", "-o", "-"])
                .arg(bundle.join("Contents/Info.plist")),
            cancel,
        )?;
        if actual.trim() != version {
            return Err(Error::BundleVersion);
        }
    }
    Ok(identity)
}

pub(super) fn signing_identity(text: &str) -> Result<(String, String)> {
    let field = |prefix: &'static str| {
        text.lines()
            .find_map(|line| line.strip_prefix(prefix))
            .filter(|value| !value.is_empty() && *value != "not set")
            .map(str::to_owned)
            .ok_or(Error::MissingSignatureField(prefix))
    };
    let team = field("TeamIdentifier=")?;
    let identifier = field("Identifier=")?;
    if identifier != "so.pen.herdr-gpui" {
        return Err(Error::BundleIdentifier);
    }
    Ok((team, identifier))
}
