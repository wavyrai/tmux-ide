//! Field lookup in the OneConsole gateway's nested, loosely typed JSON, shared
//! with the Alibaba Coding Plan and Qwen Cloud.

use crate::usage::{service::Timestamp, values::number};
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

/// Expands strings that hold JSON, as the gateway nests stringified frames.
pub(in crate::usage::providers) fn expand(value: Value) -> Value {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if (trimmed.starts_with('{') || trimmed.starts_with('['))
                && let Ok(inner) = serde_json::from_str::<Value>(trimmed)
            {
                return expand(inner);
            }
            Value::String(text)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, expand(value)))
                .collect(),
        ),
        other => other,
    }
}

/// The first object, each checked before its descendants, for which `pick`
/// finds something.
pub(super) fn first_match<'a, T>(
    value: &'a Value,
    arrays: bool,
    pick: &impl Fn(&'a Map<String, Value>) -> Option<T>,
) -> Option<T> {
    match value {
        Value::Object(object) => pick(object).or_else(|| {
            object
                .values()
                .find_map(|nested| first_match(nested, arrays, pick))
        }),
        Value::Array(items) if arrays => items
            .iter()
            .find_map(|nested| first_match(nested, arrays, pick)),
        _ => None,
    }
}

/// The first object holding any of `keys`.
pub(in crate::usage::providers) fn find_object<'a>(
    value: &'a Value,
    keys: &[&str],
) -> Option<&'a Map<String, Value>> {
    first_match(value, true, &|object: &'a Map<String, Value>| {
        keys.iter()
            .any(|key| object.contains_key(*key))
            .then_some(object)
    })
}

/// The first of `keys`, in order at each object, that `convert` accepts.
pub(in crate::usage::providers) fn find_value<'a, T>(
    value: &'a Value,
    keys: &[&str],
    arrays: bool,
    convert: impl Fn(&'a Value) -> Option<T>,
) -> Option<T> {
    first_match(value, arrays, &|object: &'a Map<String, Value>| {
        first(object, keys, &convert)
    })
}

pub(in crate::usage::providers) fn first<'a, T>(
    object: &'a Map<String, Value>,
    keys: &[&str],
    convert: impl Fn(&'a Value) -> Option<T>,
) -> Option<T> {
    keys.iter().find_map(|key| convert(object.get(*key)?))
}

pub(in crate::usage::providers) fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Epoch seconds or milliseconds, ISO 8601, or `yyyy-MM-dd[ HH:mm[:ss]]`.
pub(in crate::usage::providers) fn date(value: &Value) -> Option<SystemTime> {
    if let Some(number) = number(value).filter(|number| *number > 0.) {
        let seconds = if number >= 1e12 {
            number / 1000.
        } else {
            number
        };
        return SystemTime::UNIX_EPOCH.checked_add(Duration::try_from_secs_f64(seconds).ok()?);
    }
    let text = value.as_str()?.trim();
    Timestamp::Text(text.to_owned()).time().or_else(|| {
        let at = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M")
            .ok()
            .or_else(|| {
                chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
                    .ok()?
                    .and_hms_opt(0, 0, 0)
            })?;
        let seconds = u64::try_from(at.and_utc().timestamp()).ok()?;
        SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
    })
}
