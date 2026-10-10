#![allow(clippy::unwrap_used)]

use super::*;

#[test]
fn typed_lines_hold_no_repository_content_and_survive_any_shell() {
    for (kind, force) in [
        (ScriptKind::Setup, false),
        (ScriptKind::Run, false),
        (ScriptKind::Archive, false),
        (ScriptKind::Archive, true),
    ] {
        let line = command_line(kind, force);
        let quoted = line
            .strip_prefix("sh -ec '")
            .and_then(|rest| rest.strip_suffix('\''))
            .unwrap();
        assert!(!quoted.contains(['\'', '\\', '\n']), "{line}");
        assert!(quoted.starts_with(r#"eval "$HERDR_WORKTREE_SCRIPT""#));
    }
    assert!(!command_line(ScriptKind::Run, true).contains("remove"));
    assert!(!command_line(ScriptKind::Archive, false).contains("--force"));
    assert!(command_line(ScriptKind::Archive, true).ends_with("--force'"));
}

#[test]
#[cfg(unix)]
fn archive_line_removes_only_after_the_script_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log");
    // Stands in for the pane's herdr, recording what it was asked.
    let herdr = dir.path().join("herdr");
    std::fs::write(&herdr, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LOG\"\n").unwrap();
    std::fs::set_permissions(&herdr, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let run = |script: &str, force: bool| {
        std::process::Command::new("/bin/sh")
            .args(["-c", command_line(ScriptKind::Archive, force)])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LOG", &log)
            .env("HERDR_BIN_PATH", &herdr)
            .env("HERDR_WORKSPACE_ID", "w7")
            .env(SCRIPT_ENV, script)
            .status()
            .unwrap()
    };
    assert!(!run("echo one >> \"$LOG\"\nfalse\necho two >> \"$LOG\"", false).success());
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "one\n");
    assert!(run("echo 'it''s fine' >> \"$LOG\"", true).success());
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "one\nits fine\nworktree remove --workspace w7 --force\n"
    );
}

#[test]
fn tab_params_carry_the_script_and_paths_as_environment() {
    let checkout = Checkout {
        path: "/w/feat".into(),
        root: Some("/r".into()),
    };
    assert_eq!(
        tab_params("w2", &checkout, ScriptKind::Setup, "npm ci"),
        json!({"workspace_id":"w2","cwd":"/w/feat","label":"setup","focus":true,
            "env":{"HERDR_WORKTREE_SCRIPT":"npm ci","HERDR_WORKTREE_PATH":"/w/feat","HERDR_ROOT_PATH":"/r"}})
    );
    let params = tab_params(
        "w2",
        &Checkout {
            root: None,
            ..checkout
        },
        ScriptKind::Run,
        "make",
    );
    assert_eq!(params["label"], "run");
    assert!(params["env"].get(ROOT_ENV).is_none());
}

#[test]
fn locates_a_workspace_checkout_and_its_main_checkout() {
    let response = json!({"result":{"type":"worktree_list","worktrees":[
        {"path":"/r","is_linked_worktree":false,"is_bare":false,"open_workspace_id":"w1"},
        {"path":"/w/feat","is_linked_worktree":true,"is_bare":false,"open_workspace_id":"w2"},
        {"path":"/w/other","is_linked_worktree":true,"is_bare":false}
    ]}});
    assert_eq!(
        locate(&response, "w2").unwrap(),
        Checkout {
            path: "/w/feat".into(),
            root: Some("/r".into())
        }
    );
    assert_eq!(locate(&response, "w1").unwrap().path, "/r");
    assert!(matches!(
        locate(&response, "w9"),
        Err(crate::Error::WorktreeScriptsCheckout)
    ));
    assert!(matches!(
        locate(&json!({"error":{"code":"x","message":"no"}}), "w2"),
        Err(crate::Error::DaemonResponse(_))
    ));
    // Two entries claiming the workspace identify nothing.
    let ambiguous = json!({"result":{"type":"worktree_list","worktrees":[
        {"path":"/a","is_linked_worktree":true,"is_bare":false,"open_workspace_id":"w2"},
        {"path":"/b","is_linked_worktree":true,"is_bare":false,"open_workspace_id":"w2"}
    ]}});
    assert!(locate(&ambiguous, "w2").is_err());
    // A bare repository has no main checkout to name.
    let bare = json!({"type":"worktree_list","worktrees":[
        {"path":"/r.git","is_linked_worktree":false,"is_bare":true}
    ]});
    assert_eq!(main_checkout(&bare), None);
}

#[test]
fn created_tabs_name_their_pane() {
    let created = json!({"result":{"type":"tab_created","tab":{"tab_id":"w2:t3"},"root_pane":{"pane_id":"w2:p5"}}});
    assert_eq!(
        created_tab(&created).unwrap(),
        ("w2:t3".to_owned(), "w2:p5".to_owned())
    );
    assert!(matches!(
        created_tab(&json!({"result":{"type":"workspace_created"}})),
        Err(crate::Error::WorktreeScriptsResponse)
    ));
    assert!(matches!(
        created_tab(&json!({"error":{"code":"denied","message":"no"}})),
        Err(crate::Error::DaemonResponse(_))
    ));
}
