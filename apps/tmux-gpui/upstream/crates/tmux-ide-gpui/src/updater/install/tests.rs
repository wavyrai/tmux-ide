use super::*;
// Only the macOS-only opt-in tests below use it.
#[cfg(target_os = "macos")]
use anyhow::Context as _;
use flate2::{Compression, write::GzEncoder};
// The signing tests reach the checks through this module's glob, since on
// Linux `signing_identity` is all they use.
#[cfg(target_os = "macos")]
use super::signing::REQUIREMENT;
use super::signing::signing_identity;

mod archives;
mod guard;
mod locations;
mod replacement;
mod signing;
