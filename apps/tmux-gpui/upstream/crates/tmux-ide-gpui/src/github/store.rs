//! Where a GitHub token lives for this build, and the precedence between the
//! environment and that store. A signed macOS release build uses the Keychain
//! and Linux uses the Secret Service; every build that keeps the token
//! unencrypted on disk says so plainly.

use super::{Profile, Result, credentials, profile, token::Credential};
use crate::Error;
use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

// All windows share one credential. A refresh token is single-use, and a late
// renewal must not recreate an entry after another window has deleted it.
// Called only by background workers; never hold this lock on the UI thread.
fn transaction<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
    static ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ACCESS.lock().unwrap_or_else(|error| error.into_inner());
    work()
}

pub(crate) const PLAINTEXT_WARNING: &str = "WARNING: plaintext credential storage is enabled. GitHub tokens are unencrypted on disk; software running as you and backups can read them.";
pub(crate) const DEVELOPMENT_WARNING: &str = "WARNING: this development build does not use the macOS Keychain. GitHub tokens are unencrypted beside the GUI config; software running as you and backups can read them.";
#[cfg(not(target_os = "linux"))]
pub(crate) const KEYRING_NOTICE: &str =
    "Credentials are saved in macOS Keychain. macOS may ask you to unlock or approve access.";
#[cfg(target_os = "linux")]
pub(crate) const KEYRING_NOTICE: &str =
    "Credentials are saved in your desktop keyring (Secret Service). It may ask you to unlock it.";

#[cfg(target_os = "macos")]
const SERVICE: &str = "dev.herdr.gpui.github";

/// Which saved GitHub sign-in a credential belongs to. Each one is a separate
/// entry in the same store, so signing one out never touches another.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Account {
    /// The account used on this device, and on any saved host without its own.
    #[default]
    Main,
    /// A saved SSH device's own account, keyed by its catalog profile ID.
    Host(String),
}

impl Account {
    /// Catalog profile IDs are 32 lowercase hex digits, so they are safe in a
    /// keyring account name and a file name. Anything else is refused.
    pub(crate) fn host(id: &str) -> Option<Self> {
        herdr_client::valid_profile_id(id).then(|| Self::Host(id.to_owned()))
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn keyring_account(&self) -> String {
        match self {
            Self::Main => "github.com".into(),
            Self::Host(id) => format!("github.com/host/{id}"),
        }
    }

    fn file_name(&self) -> std::ffi::CString {
        let name = match self {
            Self::Main => "github-credentials".to_owned(),
            Self::Host(id) => format!("github-credentials-{id}"),
        };
        // Neither form can contain NUL: `host` admits only hex digits.
        std::ffi::CString::new(name).unwrap_or_default()
    }
}

pub(super) fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4096 && token.bytes().all(|b| b.is_ascii_graphic())
}

pub(super) fn resolve_token(
    gh: Option<SecretString>,
    github: Option<SecretString>,
    saved: impl FnOnce() -> Result<Option<SecretString>>,
) -> Result<SecretString> {
    let token = match gh
        .filter(|s| !s.expose_secret().trim().is_empty())
        .or_else(|| github.filter(|s| !s.expose_secret().trim().is_empty()))
    {
        Some(token) => Some(token),
        None => saved()?,
    }
    .ok_or(Error::GitHubAuthentication)?;
    let trimmed = token.expose_secret().trim();
    if !valid_token(trimmed) {
        return Err(Error::GitHubToken);
    }
    if trimmed.len() == token.expose_secret().len() {
        Ok(token)
    } else {
        Ok(trimmed.into())
    }
}

pub(super) fn credential_bytes(bytes: Vec<u8>) -> Result<SecretString> {
    let bytes = Zeroizing::new(bytes);
    // Validate by borrowing so invalid UTF-8 never escapes in FromUtf8Error.
    std::str::from_utf8(&bytes)
        .map(SecretString::from)
        .map_err(Error::GitHubEncoding)
}

pub(super) fn environment_token(name: &str) -> Result<Option<SecretString>> {
    // Own and wipe even non-Unicode environment values. The process environment
    // itself is outside this allocation's lifetime and is not erased here.
    std::env::var_os(name)
        .map(|value| credential_bytes(value.into_encoded_bytes()))
        .transpose()
}

/// Where a saved GitHub token lives for this build.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Store {
    /// No persistent store: `GH_TOKEN` / `GITHUB_TOKEN` only.
    #[default]
    Environment,
    /// The app-specific macOS login Keychain or Linux Secret Service entry.
    Keyring,
    /// A private `0600` file beside the GUI config.
    File,
}

// A macOS development build is unsigned and gets a fresh code identity on every
// rebuild, so macOS would re-prompt for the Keychain item's ACL on every run.
// Only the signed release pipeline sets `HERDR_RELEASE_VERSION`, so only it uses
// Keychain. The Secret Service grants access per user session, not per binary,
// so every Linux build uses it.
pub(super) const KEYRING: bool =
    (cfg!(target_os = "macos") && crate::RELEASE_BUILD) || cfg!(target_os = "linux");
// The private file relies on POSIX ownership and mode bits, so platforms
// without them keep the environment as their only source of a saved token.
pub(super) const FILE: bool = cfg!(unix);
// macOS development builds have no other secure store to fall back on, so the
// private file is their default.
pub(super) const FILE_DEFAULT: bool = cfg!(target_os = "macos") && !KEYRING;
// macOS picks its store from the build alone. Elsewhere the plaintext opt-in
// chooses the file, even over the Secret Service: it is the fallback for a
// desktop without one, and keeps a sign-in saved under that opt-in readable.
pub(super) const OPT_IN: bool = FILE && !cfg!(target_os = "macos");
// An unsigned build must never reach the Keychain, whatever else changes here.
const _: () = assert!(!(KEYRING && cfg!(target_os = "macos")) || crate::RELEASE_BUILD);

impl Store {
    pub(crate) fn select(config: &crate::config::Config) -> Self {
        Self::choose(
            config.github.allow_plaintext_credentials && OPT_IN,
            KEYRING,
            FILE_DEFAULT,
        )
    }

    pub(super) const fn choose(opted_in: bool, keyring: bool, file_default: bool) -> Self {
        if opted_in || file_default {
            Self::File
        } else if keyring {
            Self::Keyring
        } else {
            Self::Environment
        }
    }

    /// Credential handling shown in the GitHub menu, so storage is never implicit.
    pub(crate) fn note(self, connected: bool) -> Option<Note> {
        match self {
            Self::File if FILE_DEFAULT => Some(Note::Warning(DEVELOPMENT_WARNING)),
            Self::File => Some(Note::Warning(PLAINTEXT_WARNING)),
            Self::Keyring if !connected => Some(Note::Info(KEYRING_NOTICE)),
            Self::Keyring | Self::Environment => None,
        }
    }
}

pub(crate) enum Note {
    Warning(&'static str),
    Info(&'static str),
}

#[cfg(target_os = "macos")]
fn keyring_token(account: &Account) -> Result<Option<SecretString>> {
    keychain_read(SERVICE, &account.keyring_account())
}

#[cfg(target_os = "linux")]
fn keyring_token(account: &Account) -> Result<Option<SecretString>> {
    super::secret_service::read(&account.keyring_account())
}

// `Store::Keyring` is never selected elsewhere; the stubs keep the match total.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn keyring_token(_: &Account) -> Result<Option<SecretString>> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn keyring_save(token: Option<&SecretString>, account: &Account) -> Result<()> {
    keychain_save(SERVICE, &account.keyring_account(), token)
}

#[cfg(target_os = "linux")]
fn keyring_save(token: Option<&SecretString>, account: &Account) -> Result<()> {
    super::secret_service::save(token, &account.keyring_account())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn keyring_save(_: Option<&SecretString>, _: &Account) -> Result<()> {
    Err(Error::CredentialPolicy)
}

/// A credential another feature saves under the same policy as GitHub's:
/// the keyring service, account and label, the private file beside the GUI
/// config, and the record check every read and write must pass (which must
/// also bound its size).
#[cfg(feature = "cloud")]
pub(crate) struct Entry {
    // Only the macOS Keychain and Linux Secret Service address entries by these.
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
    pub(crate) service: &'static str,
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
    pub(crate) account: &'static str,
    /// Shown by the Linux Secret Service; the Keychain has no item label here.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) label: &'static str,
    pub(crate) file: &'static std::ffi::CStr,
    pub(crate) validate: fn(&SecretString) -> Result<()>,
}

#[cfg(feature = "cloud")]
impl Store {
    /// The store for another feature's credential, from its own plaintext opt-in.
    pub(crate) const fn for_policy(allow_plaintext: bool) -> Self {
        Self::choose(allow_plaintext && OPT_IN, KEYRING, FILE_DEFAULT)
    }
}

#[cfg(target_os = "macos")]
fn keychain_read(service: &str, account: &str) -> Result<Option<SecretString>> {
    match security_framework::passwords::get_generic_password(service, account) {
        Ok(bytes) => credential_bytes(bytes).map(Some),
        Err(e) if e.code() == -25300 => Ok(None),
        Err(error) => Err(Error::KeychainRead(error)),
    }
}

#[cfg(target_os = "macos")]
fn keychain_save(service: &str, account: &str, token: Option<&SecretString>) -> Result<()> {
    use security_framework::passwords::{delete_generic_password, set_generic_password};
    let result = match token {
        Some(token) => set_generic_password(service, account, token.expose_secret().as_bytes()),
        None => delete_generic_password(service, account),
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if token.is_none() && e.code() == -25300 => Ok(()),
        Err(error) => Err(Error::KeychainWrite(error)),
    }
}

/// Read `entry` from `store`. Callers run on a background worker.
#[cfg(feature = "cloud")]
pub(crate) fn read_entry(store: Store, entry: &Entry) -> Result<Option<SecretString>> {
    match store {
        Store::Environment => Ok(None),
        #[cfg(target_os = "macos")]
        Store::Keyring => keychain_read(entry.service, entry.account),
        #[cfg(target_os = "linux")]
        Store::Keyring => super::secret_service::read_in(entry.service, entry.account),
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        Store::Keyring => Ok(None),
        Store::File => {
            credentials::read_checked(&credential_directory()?, entry.file, entry.validate)
        }
    }
}

/// Write or remove `entry` in `store`. Callers run on a background worker.
#[cfg(feature = "cloud")]
pub(crate) fn save_entry(store: Store, entry: &Entry, token: Option<&SecretString>) -> Result<()> {
    if let Some(token) = token {
        (entry.validate)(token)?;
    }
    match store {
        #[cfg(target_os = "macos")]
        Store::Keyring => keychain_save(entry.service, entry.account, token),
        #[cfg(target_os = "linux")]
        Store::Keyring => {
            super::secret_service::save_in(entry.service, entry.label, token, entry.account)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        Store::Keyring => Err(Error::CredentialPolicy),
        // Removal stays allowed without an opt-in, as for GitHub sign-out.
        Store::Environment => credentials::store_checked(
            &credential_directory()?,
            entry.file,
            token,
            false,
            entry.validate,
        ),
        Store::File => credentials::store_checked(
            &credential_directory()?,
            entry.file,
            token,
            true,
            entry.validate,
        ),
    }
}

pub(super) fn saved_token(store: Store, account: &Account) -> Result<Option<SecretString>> {
    match store {
        Store::Environment => Ok(None),
        Store::Keyring => keyring_token(account),
        Store::File => credentials::read(&credential_directory()?, &account.file_name()),
    }
}

pub(super) fn load_profile(store: Store, account: &Account) -> Result<Option<Profile>> {
    // The environment names one account for this device. A host's own sign-in
    // exists precisely to differ from it, so only the main account reads it.
    if *account != Account::Main {
        return transaction(|| load_saved(store, account));
    }
    let gh = environment_token("GH_TOKEN")?;
    let github = if gh
        .as_ref()
        .is_none_or(|s| s.expose_secret().trim().is_empty())
    {
        environment_token("GITHUB_TOKEN")?
    } else {
        None
    };
    if gh
        .as_ref()
        .is_none_or(|s| s.expose_secret().trim().is_empty())
        && github
            .as_ref()
            .is_none_or(|s| s.expose_secret().trim().is_empty())
    {
        return transaction(|| load_saved(store, account));
    }
    tracing::info!(
        category = "github_restore",
        "Checking environment GitHub token"
    );
    let token = resolve_token(gh, github, || Ok(None))?;
    profile(std::sync::Arc::new(token)).map(Some)
}

/// Call only inside `transaction`: a renewal rotates the single-use refresh token.
fn load_saved(store: Store, account: &Account) -> Result<Option<Profile>> {
    let saved = saved_token(store, account)?;
    tracing::info!(
        category = "github_restore",
        ?store,
        host = matches!(account, Account::Host(_)),
        present = saved.is_some(),
        "Checking saved GitHub sign-in"
    );
    saved
        .map(|token| {
            Credential::decode(&token)?.profile_with(profile, Credential::refresh, |value| {
                save_unlocked(Some(value), store, account)
            })
        })
        .transpose()
}

pub(super) fn credential_directory() -> Result<std::path::PathBuf> {
    crate::config::Config::path()?
        .parent()
        .map(std::path::Path::to_owned)
        .ok_or(Error::CredentialDirectory)
}

pub(super) fn save(token: Option<&SecretString>, store: Store, account: &Account) -> Result<()> {
    transaction(|| save_unlocked(token, store, account))
}

fn save_unlocked(token: Option<&SecretString>, store: Store, account: &Account) -> Result<()> {
    let name = account.file_name();
    match store {
        Store::Keyring => keyring_save(token, account),
        // Removal stays allowed without an opt-in, so a file written under an
        // earlier policy is still cleaned up by an explicit sign-out.
        Store::Environment => credentials::store(&credential_directory()?, &name, token, false),
        Store::File => credentials::store(&credential_directory()?, &name, token, true),
    }
}

#[cfg(test)]
mod tests;
