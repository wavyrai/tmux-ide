use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
fn sessions(changed: bool) -> serde_json::Value {
    serde_json::json!({"version":1,"server":server_scope(),"sessions":[{
        "liveSessionId":format!("live-session.{}",if changed {"b"} else {"a"}.repeat(20)),
        "sessionName":"fixture","workspaceName":"docs/site","paneCount":1
    }]})
}
fn shell() -> serde_json::Value {
    serde_json::json!({"version":1,"server":server_scope(),"resource":{
        "project":{"name":"Fixture"},"workspace":{"sidebar":{"agents":[]}},
        "terminalInventory":{"activeResourceId":null,"resources":[]}
    }})
}
fn exercise(changed: bool, cancel: bool) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let (port, peer) = peer_many(if cancel { 4 } else { 5 }, move |index| {
        response(&match index {
            0 => identity(),
            1 => registrations(),
            2 => sessions(false),
            3 => {
                if cancel {
                    flag.store(true, Ordering::Release);
                }
                shell()
            }
            _ => sessions(changed),
        })
    });
    let sandbox = Sandbox::new();
    let daemon = Arc::new(LocalDaemon::discover(&sandbox.record(&value(port))).unwrap());
    let mut client = daemon.select_server(&server_scope()).unwrap();
    client.bind_request(cancelled);
    let result = client.observe_agents(&format!("live-session.{}", "a".repeat(20)), "docs/site");
    if cancel {
        assert!(matches!(result, Err(Error::Retired)));
    } else if changed {
        assert!(matches!(result, Err(Error::ServerChanged)));
    } else {
        assert_eq!(result.unwrap().project_name, "Fixture");
    }
    let requests = peer.join().unwrap();
    assert!(!requests.contains("POST "));
    assert!(requests.contains(&format!(
        "/application-shell/docs%2Fsite?liveSessionId=live-session.{} ",
        "a".repeat(20)
    )));
    assert_eq!(requests.matches("GET ").count(), if cancel { 4 } else { 5 });
    for request in requests.split("GET ").skip(1) {
        if request.starts_with("/identity ") {
            assert!(!request.to_lowercase().contains("authorization:"));
        } else {
            assert!(request.contains("Bearer must-never-be-sent-to-identity"));
        }
    }
}
#[test]
fn scoped_agent_observation_is_authenticated_and_read_only() {
    exercise(false, false);
}
#[test]
fn changed_live_session_rejects_observed_agents() {
    exercise(true, false);
}
#[test]
fn canceled_observation_discards_shell_and_stops_further_reads() {
    exercise(false, true);
}

fn agent_shell(birth: &str) -> serde_json::Value {
    let mut value = shell();
    value["resource"]["workspace"]["sidebar"]["agents"] = serde_json::json!([{
        "id":"agent.one","name":"Fixture agent","harness":"custom","activity":"idle","attention":false,"paneId":"pane.one"
    }]);
    value["resource"]["terminalInventory"] = serde_json::json!({"activeResourceId":null,"resources":[{
        "id":"pane.one","title":"Agent","kind":"agent","active":false,
        "attachability":{"status":"available","semanticPaneId":"pane.one"},"interactionEndpoint":null,
        "nativeIdentity":{"serverEpoch":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","paneBirthId":birth}
    }]});
    value
}
fn changed_agent_open(after_admission: bool) {
    let (port, peer) = peer_many(if after_admission { 11 } else { 5 }, move |index| {
        response(&match index {
            0 => identity(),
            1 => registrations(),
            3 => agent_shell(if after_admission { "1" } else { "2" }),
            6 => {
                serde_json::json!({"version":1,"server":server_scope(),"workspaceName":"fixture","liveSessionId":format!("live-session.{}","a".repeat(20))})
            }
            9 => agent_shell("2"),
            _ => {
                let mut rows = sessions(false);
                rows["sessions"][0]["workspaceName"] = "fixture".into();
                rows
            }
        })
    });
    let sandbox = Sandbox::new();
    let daemon = Arc::new(LocalDaemon::discover(&sandbox.record(&value(port))).unwrap());
    let selected = daemon.select_server(&server_scope()).unwrap();
    let selection = AgentSelection {
        catalog_identity: owner::Owner::Local(daemon.clone()).catalog_identity(),
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        workspace_name: "fixture".into(),
        agent: ObservedAgent {
            id: "agent.one".into(),
            name: "Fixture agent".into(),
            harness: ObservedHarness::Custom,
            activity: AgentActivity::Idle,
            attention: false,
            pane_id: Some("pane.one".into()),
            window_id: None,
            native_identity: Some(ObservedNativePane {
                server_epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                pane_birth_id: "1".into(),
            }),
            interaction_endpoint: None,
            team: None,
        },
    };
    assert!(matches!(
        selected.open_observed_agent(&selection),
        Err(Error::ServerChanged)
    ));
    let requests = peer.join().unwrap();
    assert_eq!(
        requests.matches("POST ").count(),
        usize::from(after_admission)
    );
    assert!(!requests.contains("/inventory/"));
    assert!(!requests.contains("capabilities"));
}
#[test]
fn changed_agent_lifetime_prevents_session_admission() {
    changed_agent_open(false);
}
#[test]
fn changed_agent_after_admission_prevents_pane_selection() {
    changed_agent_open(true);
}
