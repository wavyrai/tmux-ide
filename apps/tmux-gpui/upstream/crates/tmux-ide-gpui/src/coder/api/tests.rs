#![allow(clippy::unwrap_used)]
use super::*;

fn workspace(transition: &str, status: &str, job: &str, agents: &str) -> Workspace {
    serde_json::from_str(&format!(
        r#"{{"id":"w1","name":"herdr-box","owner_name":"me","unknown":1,
            "latest_build":{{"transition":"{transition}","status":"{status}",
            "job":{{"status":"{job}","error":"boom\nline"}},
            "resources":[{{"agents":null}},{{"agents":{agents}}}]}}}}"#
    ))
    .unwrap()
}

fn agent(status: &str, lifecycle: &str) -> String {
    format!(
        r#"[{{"id":"a1","name":"main","status":"{status}","lifecycle_state":"{lifecycle}","operating_system":"linux"}}]"#
    )
}

#[test]
fn a_workspace_is_ready_only_when_an_agent_is_connected_and_started() {
    let ready = workspace(
        "start",
        "running",
        "succeeded",
        &agent("connected", "ready"),
    );
    assert_eq!(
        ready.readiness(),
        Readiness::Ready {
            agent: "main".into(),
            warning: None
        }
    );
    let starting = workspace(
        "start",
        "running",
        "succeeded",
        &agent("connected", "starting"),
    );
    assert_eq!(
        starting.readiness(),
        Readiness::Building(BuildStatus::Running)
    );
    let connecting = workspace(
        "start",
        "running",
        "succeeded",
        &agent("connecting", "created"),
    );
    assert_eq!(
        connecting.readiness(),
        Readiness::Building(BuildStatus::Running)
    );
    let script = workspace(
        "start",
        "running",
        "succeeded",
        &agent("connected", "start_error"),
    );
    assert_eq!(
        script.readiness(),
        Readiness::Ready {
            agent: "main".into(),
            warning: Some(Lifecycle::StartError)
        }
    );
    let future = workspace(
        "start",
        "running",
        "succeeded",
        &agent("connected", "hibernating"),
    );
    assert_eq!(
        future.readiness(),
        Readiness::Building(BuildStatus::Running)
    );
}

#[test]
fn build_states_map_to_waiting_stopped_failed_or_deleted() {
    let pending = workspace("start", "pending", "pending", "[]");
    assert_eq!(
        pending.readiness(),
        Readiness::Building(BuildStatus::Pending)
    );
    assert_eq!(
        workspace("stop", "stopped", "succeeded", "[]").readiness(),
        Readiness::Stopped
    );
    assert_eq!(
        workspace("stop", "stopping", "running", "[]").readiness(),
        Readiness::Building(BuildStatus::Stopping)
    );
    assert_eq!(
        workspace("start", "failed", "failed", "[]").readiness(),
        Readiness::Failed("boom line".into())
    );
    assert_eq!(
        workspace("delete", "deleting", "running", "[]").readiness(),
        Readiness::Deleted
    );
    assert_eq!(
        workspace("start", "running", "succeeded", "[]").readiness(),
        Readiness::Failed("the template defines no workspace agent".into())
    );
    assert!(matches!(
        workspace("start", "running", "succeeded", &agent("connected", "off")).readiness(),
        Readiness::Failed(_)
    ));
    assert_eq!(
        workspace("start", "someday", "succeeded", "[]").readiness(),
        Readiness::Building(BuildStatus::Unknown)
    );
}

#[test]
fn presets_use_codersdk_field_names_and_templates_label_themselves() {
    let presets: Vec<Preset> = serde_json::from_str(
        r#"[{"ID":"p1","Name":"Small","Default":false,"Parameters":[]},{"ID":"p2","Name":"Large","Default":true}]"#,
    )
    .unwrap();
    assert_eq!(presets[1].id, "p2");
    assert!(presets[1].default);
    let template: Template = serde_json::from_str(
        r#"{"id":"t1","name":"docker","display_name":"","active_version_id":"v1"}"#,
    )
    .unwrap();
    assert_eq!(template.label(), "docker");
}

#[test]
fn path_segments_reject_anything_but_identifiers() {
    assert!(segment("0b0c1b3e-8f1a-4d6e-9d4a-8f0f6f0c2a11").is_ok());
    for value in ["", "../x", "a/b", "a?b", "a b", &"a".repeat(129)] {
        assert!(segment(value).is_err(), "{value}");
    }
}

#[test]
fn create_request_omits_an_absent_preset() {
    let body = serde_json::to_value(CreateWorkspace {
        name: "herdr-box",
        template_id: "t1",
        template_version_preset_id: None,
    })
    .unwrap();
    assert_eq!(
        body,
        serde_json::json!({"name":"herdr-box","template_id":"t1"})
    );
    assert_eq!(
        serde_json::to_value(CreateBuild {
            transition: Transition::Start
        })
        .unwrap(),
        serde_json::json!({"transition":"start"})
    );
}
