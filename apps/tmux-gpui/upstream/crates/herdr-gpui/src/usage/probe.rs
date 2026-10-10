//! What a provider reads its sign-in and its usage through. The same calls
//! work on this machine and on a remote host: there, every call runs in one
//! SSH shell session, and a secret read on the host stays in that shell as a
//! variable. Only a reference to it crosses back, and HTTP requests that use
//! it run on the host with `curl`, so credentials never leave the machine
//! they belong to. Settings from this machine's config stay here, and a
//! request using them runs here whichever host is selected.

use super::{cookies::CookieJar, model::Provider, service::Setting, settings::ProviderSettings};
use crate::{Error, Result};
use secrecy::{ExposeSecret, SecretString};
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

mod shell;

pub(crate) use shell::Shell;

/// Responses and files larger than this are refused rather than truncated.
pub(super) const LIMIT: usize = 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const STEP_TIMEOUT: Duration = Duration::from_secs(20);

/// A credential, held where it was read.
#[derive(Clone)]
pub(crate) struct Secret(Held);

#[derive(Clone)]
enum Held {
    Here(SecretString),
    /// The name of a shell variable in the remote session.
    There(String),
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.0 {
            Held::Here(_) => "Secret(here)",
            Held::There(_) => "Secret(remote)",
        })
    }
}

impl From<SecretString> for Secret {
    fn from(value: SecretString) -> Self {
        Self(Held::Here(value))
    }
}

/// A file on the probed host. `~/` is that host's home, and a base may come
/// from an environment variable there, as agents' config directories do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostPath {
    variable: Option<&'static str>,
    /// Relative to the home directory unless absolute.
    base: &'static str,
    rest: String,
}

impl HostPath {
    /// `~/.codex/auth.json` is `HostPath::home(".codex/auth.json")`.
    pub fn home(path: impl Into<String>) -> Self {
        Self {
            variable: None,
            base: "",
            rest: path.into(),
        }
    }

    /// `$CODEX_HOME`, or `~/.codex` when it is unset, then `rest`.
    pub fn env_or(
        variable: &'static str,
        home_relative: &'static str,
        rest: impl Into<String>,
    ) -> Self {
        Self {
            variable: Some(variable),
            base: home_relative,
            rest: rest.into(),
        }
    }

    pub fn absolute(path: impl Into<String>) -> Self {
        Self {
            variable: None,
            base: "/",
            rest: path.into().trim_start_matches('/').to_owned(),
        }
    }

    fn local(&self) -> Option<std::path::PathBuf> {
        let base = match (self.variable, self.base) {
            (Some(variable), base) => std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
                .or_else(|| crate::config::home().ok().map(|home| home.join(base)))?,
            (None, "/") => std::path::PathBuf::from("/"),
            (None, base) => crate::config::home().ok()?.join(base),
        };
        Some(if self.rest.is_empty() {
            base
        } else {
            base.join(&self.rest)
        })
    }

    /// A shell word that expands to the path on the remote host.
    fn remote(&self) -> String {
        let base = match (self.variable, self.base) {
            (Some(variable), base) => {
                format!("\"${{{variable}:-$HOME/{}}}\"", base.replace('"', ""))
            }
            (None, "/") => String::new(),
            (None, "") => "\"$HOME\"".into(),
            (None, base) => format!("\"$HOME\"/{}", quote(base)),
        };
        match (base.is_empty(), self.rest.is_empty()) {
            (true, _) => quote(&format!("/{}", self.rest)),
            (false, true) => base,
            (false, false) => format!("{base}/{}", quote(&self.rest)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
    Get,
    Post,
}

/// A piece of a header or body: literal text, or a secret spliced in where
/// the secret lives.
#[derive(Clone, Debug)]
pub(crate) enum Part {
    Text(String),
    Secret(Secret),
}

#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, Vec<Part>)>,
    pub body: Option<Vec<Part>>,
    pub timeout: Duration,
}

impl Request {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: Method::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            timeout: HTTP_TIMEOUT,
        }
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self {
            method: Method::Post,
            ..Self::get(url)
        }
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers
            .push((name.into(), vec![Part::Text(value.into())]));
        self
    }

    /// `name: <prefix><secret>`, e.g. `bearer` is `Authorization: Bearer <secret>`.
    pub fn secret_header(mut self, name: impl Into<String>, prefix: &str, secret: &Secret) -> Self {
        let mut parts = Vec::new();
        if !prefix.is_empty() {
            parts.push(Part::Text(prefix.to_owned()));
        }
        parts.push(Part::Secret(secret.clone()));
        self.headers.push((name.into(), parts));
        self
    }

    pub fn bearer(self, token: &Secret) -> Self {
        self.secret_header("Authorization", "Bearer ", token)
    }

    pub fn cookie(self, cookies: &Secret) -> Self {
        self.secret_header("Cookie", "", cookies)
    }

    /// A JSON body with no secrets in it.
    pub fn json(self, body: impl Into<String>) -> Self {
        self.header("Content-Type", "application/json")
            .body(vec![Part::Text(body.into())])
    }

    pub fn body(mut self, parts: Vec<Part>) -> Self {
        self.body = Some(parts);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn secrets(&self) -> impl Iterator<Item = &Secret> {
        self.headers
            .iter()
            .flat_map(|(_, parts)| parts)
            .chain(self.body.iter().flatten())
            .filter_map(|part| match part {
                Part::Secret(secret) => Some(secret),
                Part::Text(_) => None,
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Response {
    /// 0 when no answer arrived.
    pub status: u16,
    pub body: String,
}

impl Response {
    /// The body when the status is success, else the matching usage error.
    pub fn ok(self) -> Result<String> {
        match self.status {
            200..=299 => Ok(self.body),
            0 => Err(Error::UsageConnect),
            401 | 403 => Err(Error::UsageRejected),
            429 => Err(Error::UsageRateLimited),
            status => Err(Error::UsageStatus(status)),
        }
    }

    pub fn json<T: serde::de::DeserializeOwned>(self) -> Result<T> {
        super::service::json(&self.ok()?)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Output {
    pub success: bool,
    pub stdout: String,
}

/// Where the probe runs: this machine, or a shell on a remote host.
pub(super) enum Exec {
    Local,
    Remote(Shell),
}

pub(crate) struct Probe<'a> {
    exec: &'a mut Exec,
    provider: Provider,
    settings: Option<&'a ProviderSettings>,
    cookies: &'a mut CookieJar,
    consent: Consent,
    prompt: Prompt,
}

/// What a probe may do that the user would notice. Reading another app's
/// Keychain item, or a browser's cookie key, makes macOS ask, so only a
/// provider the config lists and the user allowed in its panel gets past
/// [`Consent::Ask`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Consent {
    /// Detected, not asked for: read only what needs no permission.
    Quiet,
    /// Listed but not allowed yet: anything that would ask is withheld and
    /// reported, so the panel can offer to allow it. `browsers` is whether
    /// browser cookies would be read once allowed.
    Ask { browsers: bool },
    /// Listed and allowed: may read another app's Keychain item.
    Keychain,
    /// Listed and allowed with browser cookies on: also reads the browsers'
    /// cookies.
    Browsers,
}

/// Why a read that would ask macOS did not happen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Prompt {
    #[default]
    None,
    /// Not allowed yet.
    Withheld,
    /// Allowed, but the read failed on this machine, usually a denial.
    Refused,
}

impl<'a> Probe<'a> {
    pub(super) fn new(
        exec: &'a mut Exec,
        provider: Provider,
        settings: Option<&'a ProviderSettings>,
        cookies: &'a mut CookieJar,
        consent: Consent,
    ) -> Self {
        Self {
            exec,
            provider,
            settings,
            cookies,
            consent,
            prompt: Prompt::None,
        }
    }

    /// Whether the config lists this provider in `show_providers`, rather
    /// than it only being detected. A detected provider must not do anything
    /// the user would notice.
    pub fn requested(&self) -> bool {
        self.consent != Consent::Quiet
    }

    pub fn is_remote(&self) -> bool {
        matches!(self.exec, Exec::Remote(_))
    }

    /// Whether the probed host is a Mac, where agents keep sign-ins in the
    /// login keychain.
    pub fn is_macos(&mut self) -> bool {
        match self.exec {
            Exec::Local => cfg!(target_os = "macos"),
            Exec::Remote(shell) => shell.macos(),
        }
    }

    /// A declared setting from this machine's config, else from the first of
    /// its environment variables set for this app.
    pub fn setting(&self, name: &str) -> Option<Secret> {
        self.settings
            .and_then(|settings| settings.get(name))
            .cloned()
            .or_else(|| {
                let setting = self.declared(name)?;
                setting.env.iter().find_map(|variable| {
                    std::env::var(variable)
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(SecretString::from)
                })
            })
            .map(Secret::from)
    }

    /// A setting that is not a secret, such as a base URL or a team id.
    pub fn text_setting(&self, name: &str) -> Option<String> {
        match self.setting(name)?.0 {
            Held::Here(value) => Some(value.expose_secret().trim().to_owned()),
            Held::There(_) => None,
        }
    }

    fn declared(&self, name: &str) -> Option<&'static Setting> {
        self.provider
            .service()
            .meta()
            .settings
            .iter()
            .find(|setting| setting.name == name)
    }

    /// An environment variable on the probed host.
    pub fn env(&mut self, name: &str) -> Option<Secret> {
        match self.exec {
            Exec::Local => std::env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| Secret::from(SecretString::from(value))),
            Exec::Remote(shell) => shell.capture(&format!("printenv {}", quote(name))),
        }
    }

    /// A whole file on the probed host, kept as a secret. Trailing newlines
    /// are dropped, as the remote shell's `$(…)` drops them, so a token file
    /// can go straight into a header.
    pub fn file(&mut self, path: &HostPath) -> Option<Secret> {
        match self.exec {
            Exec::Local => read_local(&path.local()?)
                .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
                .map(|text| text.trim_end_matches(['\n', '\r']).to_owned())
                .filter(|text| !text.is_empty())
                .map(|text| Secret::from(SecretString::from(text))),
            Exec::Remote(shell) => shell.capture(&format!("cat -- {}", path.remote())),
        }
    }

    pub fn exists(&mut self, path: &HostPath) -> bool {
        match self.exec {
            Exec::Local => path.local().is_some_and(|path| path.exists()),
            Exec::Remote(shell) => shell
                .run(&format!("[ -e {} ]", path.remote()), STEP_TIMEOUT)
                .is_ok_and(|output| output.success),
        }
    }

    /// A file that holds nothing secret, such as a quota report, brought back.
    pub fn read(&mut self, path: &HostPath) -> Option<String> {
        match self.exec {
            Exec::Local => {
                read_local(&path.local()?).and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
            }
            Exec::Remote(shell) => shell
                .run(&format!("cat -- {}", path.remote()), STEP_TIMEOUT)
                .ok()
                .filter(|output| output.success)
                .map(|output| output.stdout),
        }
    }

    /// A macOS keychain item's password on the probed host.
    /// A macOS keychain generic password on the probed host (`security -w`).
    pub fn keychain(&mut self, service: &str, account: Option<&str>) -> Option<Secret> {
        self.security("find-generic-password", service, account)
    }

    /// A macOS keychain internet password that another app owns, such as an
    /// editor's sign-in. Reading it makes macOS ask the user, so it is only
    /// read once the user allowed it, and a refusal on this machine is
    /// remembered rather than asked again each refresh.
    pub fn foreign_keychain_internet(
        &mut self,
        server: &str,
        account: Option<&str>,
    ) -> Option<Secret> {
        self.foreign("find-internet-password", server, account)
    }

    /// Like [`Probe::foreign_keychain_internet`], for a generic password.
    pub fn foreign_keychain(&mut self, service: &str, account: Option<&str>) -> Option<Secret> {
        self.foreign("find-generic-password", service, account)
    }

    fn foreign(&mut self, kind: &str, service: &str, account: Option<&str>) -> Option<Secret> {
        match self.consent {
            Consent::Quiet => return None,
            Consent::Ask { .. } => {
                self.prompt = Prompt::Withheld;
                return None;
            }
            Consent::Keychain | Consent::Browsers => {}
        }
        let local = matches!(self.exec, Exec::Local);
        let item = [kind, service, account.unwrap_or_default()].join("\n");
        if local && self.cookies.refused(self.provider, &item) {
            self.prompt = Prompt::Refused;
            return None;
        }
        let secret = self.security(kind, service, account);
        // Over SSH macOS cannot show the dialog, so only a local miss is a
        // refusal worth remembering.
        if local && secret.is_none() {
            self.cookies.refuse(self.provider, item);
            self.prompt = Prompt::Refused;
        }
        secret
    }

    /// Why a provider that found no sign-in found none: a read that would
    /// ask macOS was withheld or refused, or there simply is none.
    pub(super) fn missing(&self) -> Error {
        match self.prompt {
            Prompt::Withheld => Error::UsageKeychainAccess,
            Prompt::Refused => Error::UsageKeychainDenied,
            Prompt::None => Error::UsageNotSignedIn,
        }
    }

    fn security(&mut self, kind: &str, service: &str, account: Option<&str>) -> Option<Secret> {
        let mut args = vec![kind, "-s", service, "-w"];
        if let Some(account) = account {
            args.extend(["-a", account]);
        }
        match self.exec {
            Exec::Local => {
                if !cfg!(target_os = "macos") {
                    return None;
                }
                let mut command = Command::new("/usr/bin/security");
                command.args(&args);
                let (success, bytes) =
                    output(&mut command, STEP_TIMEOUT, "read a keychain item").ok()?;
                let text = String::from_utf8(bytes.to_vec()).ok()?;
                let text = text.trim_end_matches('\n');
                (success && !text.is_empty())
                    .then(|| Secret::from(SecretString::from(text.to_owned())))
            }
            Exec::Remote(shell) => shell.capture(&format!(
                "security {} 2>/dev/null",
                args.iter()
                    .map(|arg| quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            )),
        }
    }

    /// A string or number at `path` inside the JSON `source`, kept as a secret.
    pub fn field(&mut self, source: &Secret, path: &[&str]) -> Option<Secret> {
        match (&mut *self.exec, &source.0) {
            (_, Held::Here(text)) => json_field(text.expose_secret(), path)
                .map(|value| Secret::from(SecretString::from(value))),
            (Exec::Remote(shell), Held::There(variable)) => shell.capture(&format!(
                "printf '%s' \"${variable}\" | herdr_field {}",
                path.iter()
                    .map(|key| quote(key))
                    .collect::<Vec<_>>()
                    .join(" ")
            )),
            (Exec::Local, Held::There(_)) => None,
        }
    }

    /// A field that is not secret, such as a plan name or an email, revealed.
    pub fn text(&mut self, source: &Secret, path: &[&str]) -> Option<String> {
        let field = self.field(source, path)?;
        self.reveal(&field)
    }

    /// A non-secret JSON field of a file, without bringing the file back.
    pub fn file_text(&mut self, path: &HostPath, field: &[&str]) -> Option<String> {
        let file = self.file(path)?;
        self.text(&file, field)
    }

    fn reveal(&mut self, secret: &Secret) -> Option<String> {
        let text = match (&mut *self.exec, &secret.0) {
            (_, Held::Here(value)) => value.expose_secret().to_owned(),
            (Exec::Remote(shell), Held::There(variable)) => {
                shell
                    .run(&format!("printf '%s' \"${variable}\""), STEP_TIMEOUT)
                    .ok()
                    .filter(|output| output.success)?
                    .stdout
            }
            (Exec::Local, Held::There(_)) => return None,
        };
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_owned())
    }

    /// A command on the probed host, with the usual per-user install
    /// directories on its PATH. Its output is brought back, so it must not
    /// print secrets.
    pub fn command(&mut self, program: &str, args: &[&str], timeout: Duration) -> Result<Output> {
        match self.exec {
            Exec::Local => {
                let mut command = Command::new(program);
                command
                    .args(args)
                    .env("PATH", local_path())
                    .env("NO_COLOR", "1");
                let (success, bytes) = output(&mut command, timeout, "run a provider command")?;
                Ok(Output {
                    success,
                    stdout: String::from_utf8_lossy(&bytes).into_owned(),
                })
            }
            Exec::Remote(shell) => shell.run(
                &format!(
                    "NO_COLOR=1 {} {} </dev/null 2>/dev/null",
                    quote(program),
                    args.iter()
                        .map(|arg| quote(arg))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                timeout,
            ),
        }
    }

    /// The Cookie header for a web sign-in: the `cookie` setting when set,
    /// else, on this machine and only for providers the config asked for,
    /// the named cookies for `domains` from Chrome or Safari.
    pub fn cookies(&mut self, domains: &[&str], names: &[&str]) -> Option<Secret> {
        if let Some(cookie) = self.setting("cookie") {
            return Some(cookie);
        }
        if !self.browsers() {
            return None;
        }
        let header = self.cookies.header(domains, names);
        self.browsers_answered(header.is_some());
        header.map(|header| Secret::from(SecretString::from(header)))
    }

    /// Like [`Probe::cookies`], but satisfied by whichever of `names` the
    /// browser has, for services that renamed their session cookie.
    pub fn cookies_any(&mut self, domains: &[&str], names: &[&str]) -> Option<Secret> {
        if let Some(cookie) = self.setting("cookie") {
            return Some(cookie);
        }
        if !self.browsers() {
            return None;
        }
        let header = names
            .iter()
            .find_map(|name| self.cookies.header(domains, &[name]));
        self.browsers_answered(header.is_some());
        header.map(|header| Secret::from(SecretString::from(header)))
    }

    /// Whether browser cookies may be read now, noting a read withheld until
    /// the user allows it.
    fn browsers(&mut self) -> bool {
        match self.consent {
            Consent::Browsers => true,
            Consent::Ask { browsers: true } => {
                self.prompt = Prompt::Withheld;
                false
            }
            Consent::Quiet | Consent::Ask { browsers: false } | Consent::Keychain => false,
        }
    }

    /// A browser read that found nothing because a browser's cookie key
    /// could not be read was most likely denied.
    fn browsers_answered(&mut self, found: bool) {
        if !found && self.cookies.key_refused() {
            self.prompt = Prompt::Refused;
        }
    }

    /// One cookie's bare value, for services that want it as a bearer token
    /// or echoed in a header: from the `cookie` setting's header, else from
    /// the browser as [`Probe::cookies`] reads it.
    pub fn cookie_value(&mut self, domains: &[&str], name: &str) -> Option<Secret> {
        let header = match self.setting("cookie") {
            Some(Secret(Held::Here(header))) => Zeroizing::new(header.expose_secret().to_owned()),
            Some(Secret(Held::There(_))) => return None,
            None if self.browsers() => {
                let header = self.cookies.header(domains, &[name]);
                self.browsers_answered(header.is_some());
                Zeroizing::new(header?)
            }
            None => return None,
        };
        cookie_in(&header, name).map(|value| Secret::from(SecretString::from(value)))
    }

    /// A host environment variable that is not secret, such as a local
    /// server address.
    pub fn env_text(&mut self, name: &str) -> Option<String> {
        let value = self.env(name)?;
        self.reveal(&value)
    }

    pub fn http(&mut self, request: Request) -> Result<Response> {
        match self.place(&request)? {
            Place::Here => http_local(&request),
            Place::There => match self.exec {
                Exec::Remote(shell) => shell.http(&request),
                Exec::Local => Err(Error::UsageMixedSecrets),
            },
        }
    }

    /// The body of a successful answer; a failed one becomes its usage
    /// error, as [`Response::ok`] maps it.
    pub fn body(&mut self, request: Request) -> Result<String> {
        self.http(request)?.ok()
    }

    /// Exchanges one credential for another, such as a short-lived API token,
    /// keeping the new one where the request ran.
    pub fn exchange(&mut self, request: Request, path: &[&str]) -> Result<Secret> {
        match self.place(&request)? {
            Place::Here => {
                let body = http_local(&request)?.ok()?;
                json_field(&body, path)
                    .map(|value| Secret::from(SecretString::from(value)))
                    .ok_or(Error::UsageJson(serde_json::error::Category::Data))
            }
            Place::There => match self.exec {
                Exec::Remote(shell) => shell.exchange(&request, path),
                Exec::Local => Err(Error::UsageMixedSecrets),
            },
        }
    }

    /// A request runs where its secrets are: remote secrets on the host,
    /// this machine's settings here, and one without secrets on the host so
    /// it sees what the host sees.
    fn place(&self, request: &Request) -> Result<Place> {
        let (mut here, mut there) = (false, false);
        for secret in request.secrets() {
            match secret.0 {
                Held::Here(_) => here = true,
                Held::There(_) => there = true,
            }
        }
        match (here, there, self.is_remote()) {
            (true, true, _) => Err(Error::UsageMixedSecrets),
            (true, false, _) | (false, _, false) => Ok(Place::Here),
            (false, _, true) => Ok(Place::There),
        }
    }
}

enum Place {
    Here,
    There,
}

/// Agents install into per-user directories an app launched from the Dock
/// does not have on its PATH.
fn local_path() -> std::ffi::OsString {
    crate::local_path::local_path()
}

fn read_local(path: &std::path::Path) -> Option<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    std::fs::File::open(path)
        .ok()?
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= LIMIT).then_some(bytes)
}

/// The value of cookie `name` in a `name=value; …` header.
pub(super) fn cookie_in(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key.trim() == name)
            .then(|| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

/// The string or number at `path`; array steps are indices.
pub(super) fn json_field(text: &str, path: &[&str]) -> Option<String> {
    let mut value: &serde_json::Value = &serde_json::from_str(text).ok()?;
    for key in path {
        value = match value {
            serde_json::Value::Array(items) => items.get(key.parse::<usize>().ok()?)?,
            _ => value.get(key)?,
        };
    }
    let root = match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        _ => return None,
    };
    (!root.is_empty()).then_some(root)
}

fn text_of(parts: &[Part]) -> Option<Zeroizing<String>> {
    let mut text = Zeroizing::new(String::new());
    for part in parts {
        match part {
            Part::Text(value) => text.push_str(value),
            Part::Secret(Secret(Held::Here(value))) => text.push_str(value.expose_secret()),
            Part::Secret(Secret(Held::There(_))) => return None,
        }
    }
    Some(text)
}

fn http_local(request: &Request) -> Result<Response> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(request.timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut headers = Vec::with_capacity(request.headers.len());
    for (name, parts) in &request.headers {
        let text = text_of(parts).ok_or(Error::UsageMixedSecrets)?;
        let mut value = ureq::http::HeaderValue::from_str(&text).map_err(Error::UsageHeader)?;
        value.set_sensitive(parts.iter().any(|part| matches!(part, Part::Secret(_))));
        headers.push((name.as_str(), value));
    }
    let result = match request.method {
        Method::Get => {
            let mut call = agent.get(&request.url);
            for (name, value) in headers {
                call = call.header(name, value);
            }
            call.call()
        }
        Method::Post => {
            let mut call = agent.post(&request.url);
            for (name, value) in headers {
                call = call.header(name, value);
            }
            let body = match &request.body {
                Some(parts) => text_of(parts).ok_or(Error::UsageMixedSecrets)?,
                None => Zeroizing::new(String::new()),
            };
            call.send(body.as_bytes())
        }
    };
    let mut response = result.map_err(Error::UsageNetwork)?;
    let status = response.status().as_u16();
    let mut body = String::new();
    response
        .body_mut()
        .as_reader()
        .take(LIMIT as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|source| Error::UsageNetwork(ureq::Error::Io(source)))?;
    if body.len() > LIMIT {
        return Err(Error::UsageSize);
    }
    Ok(Response { status, body })
}

/// `'text'`, safe as one POSIX shell word.
pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Runs `command` to completion with a deadline, keeping at most `LIMIT`
/// bytes of its standard output. Standard error is discarded: it may echo
/// what the child was reading.
pub(super) fn output(
    command: &mut Command,
    timeout: Duration,
    operation: &'static str,
) -> Result<(bool, Zeroizing<Vec<u8>>)> {
    let process = |source| Error::UsageProcess { operation, source };
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(process)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(process(std::io::Error::other("no output pipe")));
    };
    let (sender, reads) = mpsc::sync_channel(1);
    let reader = thread::Builder::new()
        .name("herdr-usage-output".into())
        .spawn(move || {
            let mut bytes = Zeroizing::new(Vec::new());
            let result = stdout
                .take(LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = sender.send(result);
        });
    if let Err(source) = reader {
        let _ = child.kill();
        let _ = child.wait();
        return Err(process(source));
    }
    let result = match reads.recv_timeout(timeout) {
        Ok(Ok(bytes)) if bytes.len() > LIMIT => Err(Error::UsageSize),
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(source)) => Err(process(source)),
        Err(_) => Err(Error::UsageTimeout),
    };
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            // Killing the child closes the pipe, which ends the reader.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let status = child.wait().map_err(process)?;
    Ok((status.success(), bytes))
}
