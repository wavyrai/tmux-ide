//! Display metadata only; never compatibility or terminal authority.
use serde::Deserialize;

pub(super) fn safe_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 || !value.is_ascii() {
        return false;
    }
    let base = value.split(['-', '+']).next().unwrap_or_default();
    let mut parts = base.split('.');
    let numeric = |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit());
    if !(0..3).all(|_| parts.next().is_some_and(numeric)) || parts.next().is_some() {
        return false;
    }
    let suffix = &value[base.len()..];
    suffix.is_empty()
        || (suffix.len() > 1
            && suffix[1..]
                .split(['.', '-', '+'])
                .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric())))
}
fn deserialize_version<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if value.as_deref().is_some_and(|value| !safe_version(value)) {
        return Err(serde::de::Error::custom("Invalid diagnostic version"));
    }
    Ok(value)
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Versions {
    #[serde(deserialize_with = "deserialize_version")]
    pub daemon_version: Option<String>,
}

#[cfg(target_os = "macos")]
pub(super) fn native_bundle() -> (Option<String>, Option<String>) {
    use objc2_foundation::{NSBundle, NSString};
    let bundle = NSBundle::mainBundle();
    let string = |key| {
        let object = bundle.objectForInfoDictionaryKey(&NSString::from_str(key))?;
        let value = object.downcast_ref::<NSString>()?;
        if value.length() > 128 {
            return None;
        }
        Some(value.to_string())
    };
    let Some(id) = string("CFBundleIdentifier") else {
        return (None, None);
    };
    if id != "com.tmux-ide.gpui" && !id.starts_with("com.tmux-ide.gpui.") {
        return (None, None);
    }
    let version = string("CFBundleShortVersionString").filter(|value| safe_version(value));
    let build = string("CFBundleVersion").filter(|value| {
        !value.is_empty() && value.len() <= 18 && value.bytes().all(|c| c.is_ascii_digit())
    });
    (version, build)
}
#[cfg(not(target_os = "macos"))]
pub(super) fn native_bundle() -> (Option<String>, Option<String>) {
    (None, None)
}
