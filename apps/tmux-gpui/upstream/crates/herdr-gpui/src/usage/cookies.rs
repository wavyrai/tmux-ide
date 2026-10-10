//! Web sessions read from this machine's browsers, for providers whose usage
//! is only behind a signed-in dashboard. Only providers the config asks for
//! reach this, and only on this machine: remote hosts have no browser here.
//!
//! Chromium browsers encrypt cookie values with a key kept in the login
//! keychain ("Chrome Safe Storage" and the like), so the first read asks the
//! user for Keychain access. The key is kept for the life of the worker so it
//! asks once. Safari's store needs Full Disk Access; without it Safari is
//! skipped quietly. Other apps' Keychain items the user refused are kept
//! here too, so a denied prompt is not shown again on every refresh; pressing
//! Allow in the panel again forgets them so macOS can ask once more.

use super::model::Provider;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use zeroize::Zeroizing;

#[derive(Default)]
pub(super) struct CookieJar {
    /// Each browser's cookie key once read, or None when it cannot be.
    keys: HashMap<&'static str, Option<Zeroizing<[u8; 16]>>>,
    /// Keychain items another app owns that could not be read on this
    /// machine, usually because the user denied the prompt.
    refused: HashSet<(Provider, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Cookie {
    pub domain: String,
    pub name: String,
    pub value: String,
}

impl CookieJar {
    pub(super) fn refused(&self, provider: Provider, item: &str) -> bool {
        self.refused.contains(&(provider, item.to_owned()))
    }

    pub(super) fn refuse(&mut self, provider: Provider, item: String) {
        self.refused.insert((provider, item));
    }

    /// Whether some browser's cookie key could not be read, which on a Mac
    /// almost always means its Keychain prompt was denied.
    pub(super) fn key_refused(&self) -> bool {
        self.keys.values().any(Option::is_none)
    }

    /// Forgets what `provider` was refused, and which browser keys could not
    /// be read, so the next read asks macOS again.
    pub(super) fn forgive(&mut self, provider: Provider) {
        self.refused.retain(|(refused, _)| *refused != provider);
        self.keys.retain(|_, key| key.is_some());
    }

    /// `name=value; …` for cookies of `domains` (and their subdomains) from the
    /// first browser that has them all, or any of them when `names` is empty.
    pub fn header(&mut self, domains: &[&str], names: &[&str]) -> Option<String> {
        let browsers = chromium_browsers();
        let mut found = None;
        for browser in &browsers {
            for store in browser.stores() {
                let Some(cookies) = self.chromium(browser, &store, domains) else {
                    continue;
                };
                if let Some(header) = complete(&cookies, names) {
                    found = Some(header);
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        found.or_else(|| complete(&safari(domains)?, names))
    }

    fn chromium(
        &mut self,
        browser: &Browser,
        store: &Path,
        domains: &[&str],
    ) -> Option<Vec<Cookie>> {
        let key = self
            .keys
            .entry(browser.name)
            .or_insert_with(|| browser.key())
            .clone()?;
        chromium_cookies(store, domains, &key)
    }
}

/// The header when every wanted name is present; any cookies when none are named.
fn complete(cookies: &[Cookie], names: &[&str]) -> Option<String> {
    let chosen: Vec<&Cookie> = if names.is_empty() {
        cookies.iter().collect()
    } else {
        let chosen: Vec<_> = names
            .iter()
            .filter_map(|name| cookies.iter().find(|cookie| cookie.name == *name))
            .collect();
        if chosen.len() != names.len() {
            return None;
        }
        chosen
    };
    (!chosen.is_empty()).then(|| {
        chosen
            .iter()
            .map(|cookie| format!("{}={}", cookie.name, cookie.value))
            .collect::<Vec<_>>()
            .join("; ")
    })
}

pub(super) fn matches_domain(host: &str, domain: &str) -> bool {
    let host = host.trim_start_matches('.');
    let domain = domain.trim_start_matches('.');
    host == domain || host.ends_with(&format!(".{domain}"))
}

struct Browser {
    name: &'static str,
    root: PathBuf,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    keychain: &'static str,
}

fn chromium_browsers() -> Vec<Browser> {
    let Ok(home) = crate::config::home() else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    let (base, list) = (
        home.join("Library/Application Support"),
        [
            ("Chrome", "Google/Chrome", "Chrome Safe Storage"),
            ("Brave", "BraveSoftware/Brave-Browser", "Brave Safe Storage"),
            ("Edge", "Microsoft Edge", "Microsoft Edge Safe Storage"),
            ("Arc", "Arc/User Data", "Arc Safe Storage"),
            ("Chromium", "Chromium", "Chromium Safe Storage"),
        ],
    );
    #[cfg(not(target_os = "macos"))]
    let (base, list) = (
        home.join(".config"),
        [
            ("Chrome", "google-chrome", ""),
            ("Brave", "BraveSoftware/Brave-Browser", ""),
            ("Edge", "microsoft-edge", ""),
            ("Arc", "arc", ""),
            ("Chromium", "chromium", ""),
        ],
    );
    list.into_iter()
        .map(|(name, directory, keychain)| Browser {
            name,
            root: base.join(directory),
            keychain,
        })
        .filter(|browser| browser.root.is_dir())
        .collect()
}

impl Browser {
    /// Every profile's cookie database, the default profile first.
    fn stores(&self) -> Vec<PathBuf> {
        let mut profiles: Vec<PathBuf> = std::fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == "Default" || name.starts_with("Profile "))
            })
            .collect();
        profiles.sort_by_key(|path| !path.ends_with("Default"));
        profiles
            .into_iter()
            .flat_map(|profile| [profile.join("Network/Cookies"), profile.join("Cookies")])
            .filter(|path| path.is_file())
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn key(&self) -> Option<Zeroizing<[u8; 16]>> {
        let mut command = std::process::Command::new("/usr/bin/security");
        command.args(["find-generic-password", "-w", "-s", self.keychain]);
        let (success, password) = super::probe::output(
            &mut command,
            Duration::from_secs(60),
            "read the browser's cookie key",
        )
        .ok()?;
        if !success {
            return None;
        }
        let password = Zeroizing::new(
            String::from_utf8(password.to_vec())
                .ok()?
                .trim_end()
                .to_owned(),
        );
        Some(derive(password.as_bytes(), 1003))
    }

    /// Linux Chromium without a keyring integration encrypts with a fixed
    /// password; values under a keyring (`v11`) are not readable here.
    #[cfg(not(target_os = "macos"))]
    fn key(&self) -> Option<Zeroizing<[u8; 16]>> {
        Some(derive(b"peanuts", 1))
    }
}

fn derive(password: &[u8], rounds: u32) -> Zeroizing<[u8; 16]> {
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", rounds, key.as_mut());
    key
}

/// Chrome counts microseconds from 1601.
const CHROME_EPOCH_OFFSET: u64 = 11_644_473_600;

fn chromium_cookies(store: &Path, domains: &[&str], key: &[u8; 16]) -> Option<Vec<Cookie>> {
    // Immutable: the browser holds the database open and locked.
    let uri = format!("file:{}?immutable=1", store.display());
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    let connection = rusqlite::Connection::open_with_flags(uri, flags).ok()?;
    let version: i64 = connection
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut statement = connection
        .prepare("SELECT host_key, name, value, encrypted_value, expires_utc FROM cookies")
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .ok()?;
    let mut cookies = Vec::new();
    for (host, name, value, encrypted, expires) in rows.flatten() {
        if !domains.iter().any(|domain| matches_domain(&host, domain)) {
            continue;
        }
        // 0 is a session cookie; anything else is microseconds since 1601.
        let expires = u64::try_from(expires).unwrap_or(0) / 1_000_000;
        if expires != 0 && expires.saturating_sub(CHROME_EPOCH_OFFSET) < now {
            continue;
        }
        let value = if value.is_empty() {
            match decrypt(&encrypted, key, version >= 24) {
                Some(value) => value,
                None => continue,
            }
        } else {
            value
        };
        cookies.push(Cookie {
            domain: host,
            name,
            value,
        });
    }
    Some(cookies)
}

/// `v10` values are AES-128-CBC with a blank IV. Since database version 24
/// the plaintext starts with a SHA-256 of the host, which is dropped.
pub(super) fn decrypt(encrypted: &[u8], key: &[u8; 16], hashed_host: bool) -> Option<String> {
    use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
    let body = encrypted.strip_prefix(b"v10")?;
    let mut buffer = Zeroizing::new(body.to_vec());
    let plain = cbc::Decryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into())
        .decrypt_padded::<Pkcs7>(&mut buffer)
        .ok()?;
    let plain = if hashed_host && plain.len() >= 32 {
        &plain[32..]
    } else {
        plain
    };
    String::from_utf8(plain.to_vec()).ok()
}

fn safari(domains: &[&str]) -> Option<Vec<Cookie>> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = crate::config::home().ok()?;
    [
        "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
        "Library/Cookies/Cookies.binarycookies",
    ]
    .into_iter()
    .find_map(|path| {
        let bytes = std::fs::read(home.join(path)).ok()?;
        let now = SystemTime::now();
        Some(
            binary_cookies(&bytes)?
                .into_iter()
                .filter(|(cookie, expires)| {
                    expires.is_none_or(|at| at > now)
                        && domains
                            .iter()
                            .any(|domain| matches_domain(&cookie.domain, domain))
                })
                .map(|(cookie, _)| cookie)
                .collect(),
        )
    })
}

/// Seconds from 1970 to 2001, Safari's epoch.
const MAC_EPOCH_OFFSET: f64 = 978_307_200.;

/// Safari's `Cookies.binarycookies`: big-endian pages, little-endian records.
pub(super) fn binary_cookies(bytes: &[u8]) -> Option<Vec<(Cookie, Option<SystemTime>)>> {
    let be = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    if bytes.get(..4)? != b"cook" {
        return None;
    }
    let pages = be(4)? as usize;
    let mut offset = 8 + pages.checked_mul(4)?;
    let mut cookies = Vec::new();
    for index in 0..pages.min(4096) {
        let size = be(8 + index * 4)? as usize;
        let page = bytes.get(offset..offset.checked_add(size)?)?;
        offset += size;
        let le = |at: usize| -> Option<u32> {
            Some(u32::from_le_bytes(page.get(at..at + 4)?.try_into().ok()?))
        };
        let count = le(4)? as usize;
        for record in 0..count.min(65_536) {
            let start = le(8 + record * 4)? as usize;
            let cookie = page.get(start..)?;
            let field = |at: usize| -> Option<u32> {
                Some(u32::from_le_bytes(cookie.get(at..at + 4)?.try_into().ok()?))
            };
            let text = |at: usize| -> Option<String> {
                let from = field(at)? as usize;
                let rest = cookie.get(from..)?;
                let end = rest.iter().position(|b| *b == 0)?;
                String::from_utf8(rest[..end].to_vec()).ok()
            };
            let expires = cookie
                .get(40..48)
                .and_then(|raw| raw.try_into().ok())
                .map(f64::from_le_bytes)
                .filter(|seconds| seconds.is_finite() && *seconds > 0.)
                .and_then(|seconds| {
                    SystemTime::UNIX_EPOCH
                        .checked_add(Duration::from_secs_f64(seconds + MAC_EPOCH_OFFSET))
                });
            let (Some(domain), Some(name), Some(value)) = (text(16), text(20), text(28)) else {
                continue;
            };
            cookies.push((
                Cookie {
                    domain,
                    name,
                    value,
                },
                expires,
            ));
        }
    }
    Some(cookies)
}
