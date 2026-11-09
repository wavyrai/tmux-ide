#![allow(clippy::unwrap_used)]
use super::*;

fn catalog(entries: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "version": 1, "revision": 3, "entries": entries })).unwrap()
}

fn descriptor(id: &str, label: &str, owner: &str, dangerous: bool) -> Value {
    json!({
        "version": 1, "id": id, "owner": owner, "label": label, "category": "Tasks",
        "schemas": { "input": "plugin:tasks" }, "dangerous": dangerous,
        "confirmation": if dangerous { "dialog" } else { "none" }
    })
}

#[test]
fn keeps_only_plugin_commands_and_their_params() {
    let bytes = catalog(json!([
        { "descriptor": descriptor("project.launch", "Launch", "daemon", false), "params": [] },
        {
            "descriptor": descriptor("plugin.tasks.new", "New task", "plugin", false),
            "plugin": "tasks",
            "params": [
                { "name": "name", "type": "string", "label": "Branch name", "required": true,
                  "dynamicDefault": false, "dynamicChoices": false },
                { "name": "agent", "type": "choice", "label": "Agent", "required": false,
                  "default": "claude", "dynamicDefault": false, "dynamicChoices": false,
                  "choices": [{ "value": "claude", "label": "Claude" }] },
                { "name": "count", "type": "number", "label": "Count", "required": true,
                  "default": 2, "dynamicDefault": false, "dynamicChoices": true }
            ]
        },
        { "descriptor": descriptor("plugin.tasks.rm", "Remove", "plugin", true), "plugin": "tasks", "params": [] }
    ]));
    let commands = parse_catalog(&bytes).unwrap();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].id, "plugin.tasks.new");
    assert!(!commands[0].dangerous && commands[1].dangerous);
    let params = &commands[0].params;
    assert_eq!(params[0].kind, ParamKind::String);
    assert!(params[0].required);
    assert_eq!(params[1].default, Some(ArgValue::Text("claude".into())));
    assert_eq!(
        params[1].choices,
        vec![Choice {
            value: "claude".into(),
            label: "Claude".into()
        }]
    );
    assert_eq!(params[2].default, Some(ArgValue::Number(2.0)));
    assert!(params[2].dynamic_choices);
}

#[test]
fn strips_control_and_format_characters_from_untrusted_text() {
    let bytes = catalog(json!([{
        "descriptor": descriptor("plugin.x.y", "Safe\u{202e}evil\u{0007}\nlabel", "plugin", false),
        "plugin": "x", "params": []
    }]));
    let commands = parse_catalog(&bytes).unwrap();
    assert_eq!(commands[0].label, "Safe evil  label");
    assert_eq!(clean("\u{200b}\u{feff}", 10), None);
    assert_eq!(clean("a\u{2028}b\u{2029}c", 10).as_deref(), Some("a b c"));
    assert_eq!(clean(&"x".repeat(500), 160).unwrap().chars().count(), 160);
}

#[test]
fn skips_malformed_or_spoofed_entries() {
    let bytes = catalog(json!([
        { "descriptor": descriptor("plugin.x.y", "No plugin field", "plugin", false), "params": [] },
        { "descriptor": descriptor("project.launch", "Built-in claiming a plugin", "plugin", false), "plugin": "x", "params": [] },
        { "descriptor": descriptor("plugin.x.daemon", "Daemon-owned plugin-shaped id", "daemon", false), "plugin": "x", "params": [] },
        { "descriptor": descriptor("plugin.x..y", "Bad id", "plugin", false), "plugin": "x", "params": [] },
        { "descriptor": descriptor("plugin.x.z", "Bad param", "plugin", false), "plugin": "x",
          "params": [{ "name": "Bad Name", "type": "string" }] },
        { "descriptor": descriptor("plugin.x.w", "Unknown type", "plugin", false), "plugin": "x",
          "params": [{ "name": "a", "type": "date" }] }
    ]));
    assert!(parse_catalog(&bytes).unwrap().is_empty());
    assert!(parse_catalog(b"{\"version\":2,\"entries\":[]}").is_err());
    assert!(parse_catalog(b"not json").is_err());
}

#[test]
fn reads_invoke_and_options_outcomes_as_plain_text() {
    assert_eq!(
        parse_invoke(br#"{"ok":true,"value":"made fix-login\u001b[31m"}"#).unwrap(),
        PluginOutcome::Ok(Some("made fix-login [31m".into()))
    );
    assert_eq!(
        parse_invoke(br#"{"ok":true}"#).unwrap(),
        PluginOutcome::Ok(None)
    );
    assert_eq!(
        parse_invoke(br#"{"ok":true,"value":{"a":1}}"#).unwrap(),
        PluginOutcome::Ok(Some("{\"a\":1}".into()))
    );
    assert_eq!(
        parse_invoke(br#"{"ok":false,"error":"E_CONFIRM: must be confirmed"}"#).unwrap(),
        PluginOutcome::Failed("E_CONFIRM: must be confirmed".into())
    );
    assert!(parse_invoke(b"{}").is_err());
    assert_eq!(
        parse_param_options(br#"{"ok":true,"choices":[{"value":"a","label":"A"}],"default":"a"}"#)
            .unwrap(),
        PluginOutcome::Ok(ParamOptions {
            choices: Some(vec![Choice {
                value: "a".into(),
                label: "A".into()
            }]),
            default: Some(ArgValue::Text("a".into())),
        })
    );
}

#[test]
fn builds_invoke_bodies_with_only_tmux_pane_ids_as_context() {
    let args = vec![
        ("name".to_owned(), ArgValue::Text("x".into())),
        ("n".to_owned(), ArgValue::Number(2.0)),
    ];
    let body: Value = serde_json::from_slice(
        &invoke_body(
            "plugin.tasks.new",
            &args,
            &InvokeContext {
                session: Some("demo".into()),
                pane: Some("%12".into()),
            },
            true,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({ "id": "plugin.tasks.new", "args": { "name": "x", "n": 2.0 },
                "context": { "source": "palette", "session": "demo", "pane": "%12" }, "confirmed": true })
    );
    let body: Value = serde_json::from_slice(
        &invoke_body(
            "plugin.tasks.new",
            &[],
            &InvokeContext {
                session: None,
                pane: Some("pane.semantic.123".into()),
            },
            false,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({ "id": "plugin.tasks.new", "args": {}, "context": { "source": "palette" } })
    );
    assert!(invoke_body("project.launch", &[], &InvokeContext::default(), false).is_err());
    assert!(
        invoke_body(
            "plugin.a.b",
            &[("Bad".into(), ArgValue::Bool(true))],
            &InvokeContext::default(),
            false
        )
        .is_err()
    );
    assert!(
        tmux_pane_id("%0") && !tmux_pane_id("%") && !tmux_pane_id("%1a") && !tmux_pane_id("12")
    );
}
