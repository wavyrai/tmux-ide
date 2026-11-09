//! Plugin commands from the local daemon's command catalog, and the two
//! owner-only routes that run them: invoke and param-options. Same owner
//! credential handling as the other local resources; nothing new.
//!
//! Plugin text (labels, categories, descriptions, choices, results) is
//! untrusted: it is bounded, and control and format characters (including
//! bidi overrides) are removed before anything is shown.
use super::{Error, LocalDaemon};
use serde_json::{Map, Value, json};
use std::{sync::LazyLock, time::Duration};

const RESPONSE_LIMIT: u64 = 8 * 1024 * 1024;
const REQUEST_LIMIT: usize = 256 * 1024;
const MAX_COMMANDS: usize = 2000;
const MAX_PARAMS: usize = 32;
const MAX_CHOICES: usize = 500;

#[derive(Clone, Debug, PartialEq)]
pub struct PluginCommand {
    pub id: String,
    pub label: String,
    pub category: String,
    pub plugin: String,
    pub dangerous: bool,
    pub params: Vec<PluginParam>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    String,
    Text,
    Number,
    Boolean,
    Choice,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArgValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

impl ArgValue {
    fn from_json(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(Self::Text(clean(text, 10_000)?)),
            Value::Number(number) => number.as_f64().filter(|n| n.is_finite()).map(Self::Number),
            Value::Bool(flag) => Some(Self::Bool(*flag)),
            _ => None,
        }
    }
    fn to_json(&self) -> Value {
        match self {
            Self::Text(text) => json!(text),
            Self::Number(number) => json!(number),
            Self::Bool(flag) => json!(flag),
        }
    }
    /// Plain-text display form.
    pub fn display(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Number(number) => number.to_string(),
            Self::Bool(true) => "Yes".into(),
            Self::Bool(false) => "No".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginParam {
    pub name: String,
    pub kind: ParamKind,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub default: Option<ArgValue>,
    pub dynamic_default: bool,
    pub choices: Vec<Choice>,
    pub dynamic_choices: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InvokeContext {
    pub session: Option<String>,
    /// A tmux pane id like `%3`, so `ide.exec{context = ctx.pane}` works.
    pub pane: Option<String>,
}

/// What the plugin answered. A refusal or a plugin error is not a transport error.
#[derive(Clone, Debug, PartialEq)]
pub enum PluginOutcome<T> {
    Ok(T),
    Failed(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParamOptions {
    pub choices: Option<Vec<Choice>>,
    pub default: Option<ArgValue>,
}

/// Bounded, single-line, plain text: control and format characters removed.
pub fn clean(text: &str, limit: usize) -> Option<String> {
    static FORBIDDEN: LazyLock<Result<regex::Regex, regex::Error>> =
        LazyLock::new(|| regex::Regex::new(r"[\p{Cc}\p{Cf}]"));
    let regex = FORBIDDEN.as_ref().ok()?;
    let cleaned: String = regex.replace_all(text, " ").chars().take(limit).collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn str_field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn command_id(id: &str) -> bool {
    id.len() <= 160
        && id.starts_with("plugin.")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !id.contains("..")
        && !id.ends_with('.')
}

fn param_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !name.as_bytes()[0].is_ascii_digit()
}

fn choices(value: Option<&Value>) -> Vec<Choice> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_CHOICES)
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let value = str_field(object, "value")?
                        .chars()
                        .take(500)
                        .collect::<String>();
                    let label = clean(str_field(object, "label")?, 200)?;
                    Some(Choice { value, label })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn param(value: &Value) -> Option<PluginParam> {
    let object = value.as_object()?;
    let name = str_field(object, "name")?;
    if !param_name(name) {
        return None;
    }
    let kind = match str_field(object, "type")? {
        "string" => ParamKind::String,
        "text" => ParamKind::Text,
        "number" => ParamKind::Number,
        "boolean" => ParamKind::Boolean,
        "choice" => ParamKind::Choice,
        _ => return None,
    };
    Some(PluginParam {
        name: name.to_owned(),
        kind,
        label: clean(str_field(object, "label").unwrap_or(name), 120)?,
        description: str_field(object, "description").and_then(|d| clean(d, 500)),
        required: object
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        default: object.get("default").and_then(ArgValue::from_json),
        dynamic_default: object.get("dynamicDefault").and_then(Value::as_bool) == Some(true),
        choices: choices(object.get("choices")),
        dynamic_choices: object.get("dynamicChoices").and_then(Value::as_bool) == Some(true),
    })
}

/// The plugin entries of a command-catalog resource. Malformed entries are
/// skipped; built-in commands are not plugin commands.
pub fn parse_catalog(bytes: &[u8]) -> Result<Vec<PluginCommand>, Error> {
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return Err(Error::ResourceFormat);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(Error::ResourceFormat);
    }
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .ok_or(Error::ResourceFormat)?;
    Ok(entries
        .iter()
        .take(MAX_COMMANDS)
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let plugin = str_field(entry, "plugin")?;
            let descriptor = entry.get("descriptor")?.as_object()?;
            if str_field(descriptor, "owner") != Some("plugin") {
                return None;
            }
            let id = str_field(descriptor, "id")?;
            if !command_id(id) {
                return None;
            }
            let params = entry.get("params")?.as_array()?;
            if params.len() > MAX_PARAMS {
                return None;
            }
            Some(PluginCommand {
                id: id.to_owned(),
                label: clean(str_field(descriptor, "label")?, 160)?,
                category: clean(str_field(descriptor, "category").unwrap_or("Plugins"), 80)?,
                plugin: clean(plugin, 64)?,
                dangerous: descriptor.get("dangerous").and_then(Value::as_bool) == Some(true),
                params: params.iter().map(param).collect::<Option<Vec<_>>>()?,
            })
        })
        .collect())
}

/// `{ok, value | error}` from the invoke route, as plain text for the note line.
pub fn parse_invoke(bytes: &[u8]) -> Result<PluginOutcome<Option<String>>, Error> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(PluginOutcome::Ok(value.get("value").and_then(
            |v| match v {
                Value::String(text) => clean(text, 300),
                Value::Null => None,
                other => clean(&other.to_string(), 300),
            },
        ))),
        Some(false) => Ok(PluginOutcome::Failed(
            value
                .get("error")
                .and_then(Value::as_str)
                .and_then(|e| clean(e, 300))
                .unwrap_or_else(|| "The plugin failed".into()),
        )),
        None => Err(Error::ResourceFormat),
    }
}

pub fn parse_param_options(bytes: &[u8]) -> Result<PluginOutcome<ParamOptions>, Error> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(PluginOutcome::Ok(ParamOptions {
            choices: value.get("choices").map(|c| choices(Some(c))),
            default: value.get("default").and_then(ArgValue::from_json),
        })),
        Some(false) => Ok(PluginOutcome::Failed(
            value
                .get("error")
                .and_then(Value::as_str)
                .and_then(|e| clean(e, 300))
                .unwrap_or_else(|| "The plugin could not list choices".into()),
        )),
        None => Err(Error::ResourceFormat),
    }
}

fn context_json(context: &InvokeContext) -> Value {
    let mut object = Map::new();
    object.insert("source".into(), json!("palette"));
    if let Some(session) = &context.session {
        object.insert(
            "session".into(),
            json!(session.chars().take(200).collect::<String>()),
        );
    }
    if let Some(pane) = context.pane.as_ref().filter(|pane| tmux_pane_id(pane)) {
        object.insert("pane".into(), json!(pane));
    }
    Value::Object(object)
}

/// A tmux pane id like `%12`; anything else is not passed as `ctx.pane`.
pub fn tmux_pane_id(pane: &str) -> bool {
    pane.len() >= 2
        && pane.len() <= 10
        && pane.starts_with('%')
        && pane[1..].bytes().all(|b| b.is_ascii_digit())
}

/// The invoke request body.
pub fn invoke_body(
    id: &str,
    args: &[(String, ArgValue)],
    context: &InvokeContext,
    confirmed: bool,
) -> Result<Vec<u8>, Error> {
    if !command_id(id) {
        return Err(Error::ActionInput);
    }
    let mut map = Map::new();
    for (name, value) in args {
        if !param_name(name) {
            return Err(Error::ActionInput);
        }
        map.insert(name.clone(), value.to_json());
    }
    let mut body = json!({ "id": id, "args": map, "context": context_json(context) });
    if confirmed {
        body["confirmed"] = json!(true);
    }
    let bytes = serde_json::to_vec(&body).map_err(|_| Error::ActionInput)?;
    if bytes.len() > REQUEST_LIMIT {
        return Err(Error::ActionInput);
    }
    Ok(bytes)
}

impl LocalDaemon {
    fn plugin_request(
        &self,
        path: &str,
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Vec<u8>, Error> {
        self.verify_current()?;
        let endpoint = self.base_url.join(path).map_err(|_| Error::Endpoint)?;
        self.check_record()?;
        let mut response = if let Some(body) = body {
            self.agent
                .post(endpoint.as_str())
                .header("Authorization", self.record.authorization()?)
                .header("Content-Type", "application/json")
                .header("Cache-Control", "no-store")
                .config()
                .timeout_global(Some(timeout))
                .http_status_as_error(false)
                .build()
                .send(&body[..])
        } else {
            self.agent
                .get(endpoint.as_str())
                .header("Authorization", self.record.authorization()?)
                .header("Cache-Control", "no-store")
                .config()
                .timeout_global(Some(timeout))
                .http_status_as_error(false)
                .build()
                .call()
        }
        .map_err(|error| self.failed(Error::Network(error)))?;
        let status = response.status().as_u16();
        let bytes = response
            .body_mut()
            .with_config()
            .limit(RESPONSE_LIMIT)
            .read_to_vec()
            .map_err(|error| self.failed(Error::Network(error)))?;
        if status != 200 {
            return Err(Error::RequestStatus(status));
        }
        Ok(bytes)
    }

    /// Plugin commands from the command catalog; empty when plugins are off.
    pub fn plugin_commands(&self) -> Result<Vec<PluginCommand>, Error> {
        match self.plugin_request(
            "api/resources/command-catalog",
            None,
            Duration::from_secs(3),
        ) {
            Ok(bytes) => parse_catalog(&bytes),
            Err(Error::RequestStatus(503)) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// Run a plugin command. `confirmed` must be true only after the person confirmed it.
    pub fn invoke_plugin_command(
        &self,
        id: &str,
        args: &[(String, ArgValue)],
        context: &InvokeContext,
        confirmed: bool,
    ) -> Result<PluginOutcome<Option<String>>, Error> {
        let body = invoke_body(id, args, context, confirmed)?;
        let bytes = self.plugin_request(
            "api/v2/commands/invoke",
            Some(body),
            Duration::from_secs(60),
        )?;
        parse_invoke(&bytes)
    }

    /// Choices and default for one parameter, asked of the plugin.
    pub fn plugin_param_options(
        &self,
        id: &str,
        param: &str,
        context: &InvokeContext,
    ) -> Result<PluginOutcome<ParamOptions>, Error> {
        if !command_id(id) || !param_name(param) {
            return Err(Error::ActionInput);
        }
        let body = serde_json::to_vec(
            &json!({ "id": id, "param": param, "context": context_json(context) }),
        )
        .map_err(|_| Error::ActionInput)?;
        let bytes = self.plugin_request(
            "api/v2/commands/param-options",
            Some(body),
            Duration::from_secs(30),
        )?;
        parse_param_options(&bytes)
    }
}

#[cfg(test)]
#[path = "plugin_commands_tests.rs"]
mod tests;
