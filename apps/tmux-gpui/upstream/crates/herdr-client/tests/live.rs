//! Explicitly opt-in: never discovers or attaches to an existing daemon.
//! The daemon under test is a POSIX process with a POSIX sandbox, so the whole
//! harness compiles on Unix only.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "../../test-support/sandbox.rs"]
mod sandbox;

use herdr_client::{
    Client, ClientEvent, ConnectOptions, ConnectTarget, Method, connect,
    protocol::{
        ClientKeyCode, ClientKeyKind, ClientPaneInputEvent, ClientShellSnapshot, ClientSurfaceSize,
    },
};
use sandbox::{Sandbox, daemon_binary, stop_children};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::Child,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(20);

/// Verify the CLI contract used by the picker against an explicitly selected
/// installation. Every command has the sandbox's cleared, private environment.
#[test]
#[ignore = "requires HERDR_TEST_BINARY; creates only an isolated named session"]
fn named_session_create_and_delete_cli_contract() {
    let binary = daemon_binary();
    let mut daemon = Daemon {
        sandbox: Sandbox::new(),
        child: None,
    };
    let name = "picker-test";
    let socket = daemon
        .sandbox
        .dir
        .join("config/herdr/sessions")
        .join(name)
        .join("herdr-client.sock");
    daemon.child = Some(
        daemon
            .sandbox
            .command(&binary, "daemon.log")
            .args(["--session", name, "server"])
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + TIMEOUT;
    while herdr_client::Stream::connect(&socket).is_err() {
        assert!(daemon.child.as_mut().unwrap().try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline, "named session never started");
        thread::sleep(Duration::from_millis(20));
    }
    let delete = |name: &str| {
        daemon
            .sandbox
            .command(&binary, "delete.log")
            .args(["session", "delete", "--json", "--", name])
            .status()
            .unwrap()
    };
    assert!(!delete("default").success());
    assert!(
        !delete(name).success(),
        "a running session must be preserved"
    );
    assert!(socket.parent().unwrap().is_dir());
    // Exercise the GUI's explicit stop of this test-owned named session only.
    // Drop still kills/reaps the exact child on every failure path.
    let stop = || {
        daemon
            .sandbox
            .command(&binary, "stop.log")
            .args(["session", "stop", "--json", "--", name])
            .status()
            .unwrap()
    };
    assert!(stop().success());
    let deadline = Instant::now() + TIMEOUT;
    while daemon.child.as_mut().unwrap().try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "stopped daemon did not exit");
        thread::sleep(Duration::from_millis(20));
    }
    daemon.child = None;
    assert!(
        !stop().success(),
        "stopping an already-stopped session is a CLI refusal"
    );
    assert!(delete(name).success());
    assert!(!socket.parent().unwrap().exists());
    assert!(
        delete(name).success(),
        "deletion of a missing name is idempotent"
    );
}

struct Daemon {
    sandbox: Sandbox,
    child: Option<Child>,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        stop_children([&mut self.child]);
        if thread::panicking()
            && let Ok(log) = fs::read_to_string(self.sandbox.dir.join("daemon.log"))
        {
            eprintln!("isolated daemon output:\n{log}");
        }
    }
}

impl Daemon {
    fn start() -> Self {
        let binary = daemon_binary();
        let mut daemon = Self {
            sandbox: Sandbox::new(),
            child: None,
        };
        daemon.child = Some(
            daemon
                .sandbox
                .command(binary, "daemon.log")
                .arg("server")
                .spawn()
                .unwrap(),
        );
        daemon
            .sandbox
            .wait_for_daemon(daemon.child.as_mut().unwrap(), TIMEOUT);
        daemon
    }

    fn socket(&self) -> PathBuf {
        self.sandbox.socket()
    }
}

struct Session {
    client: Client,
    snapshot: Option<Arc<ClientShellSnapshot>>,
}

impl Session {
    fn open(daemon: &Daemon) -> Self {
        let mut session = Self {
            client: connect(
                ConnectTarget::Socket(daemon.socket()),
                ConnectOptions::default(),
            )
            .unwrap(),
            snapshot: None,
        };
        session.until("stable welcome", |event| {
            if let ClientEvent::Connected(welcome) = event {
                eprintln!("stable endpoint welcome: {welcome:?}");
                assert_eq!(welcome.generation, 1);
                true
            } else {
                false
            }
        });
        session.until("initial snapshot", |event| {
            matches!(event, ClientEvent::Snapshot(_))
        });
        assert!(
            session
                .snapshot
                .as_ref()
                .unwrap()
                .config_diagnostic
                .is_none()
        );
        session.until("initial surface", |event| {
            matches!(event, ClientEvent::Surface(_))
        });
        session
    }

    fn until(&mut self, label: &str, mut predicate: impl FnMut(&ClientEvent) -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let event = self
                .client
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!("waiting for {label}: {error}; snapshot={:?}", self.snapshot)
                });
            match &event {
                ClientEvent::Disconnected { reason, .. } => {
                    panic!("{label}: disconnected: {reason}")
                }
                ClientEvent::CommandRejected { reason, .. } => {
                    panic!("{label}: rejected: {reason}")
                }
                ClientEvent::Snapshot(snapshot) => self.snapshot = Some(snapshot.clone()),
                ClientEvent::Surface(surface) => {
                    let snapshot = self.snapshot.as_ref().unwrap();
                    assert_eq!(surface.boot_id, snapshot.boot_id);
                    assert_eq!(surface.projection_revision, snapshot.revision);
                    surface.frame.validate().unwrap();
                }
                _ => {}
            }
            if predicate(&event) {
                return;
            }
            assert!(Instant::now() < deadline, "waiting for {label}");
        }
    }

    fn response(&mut self, id: String) -> Value {
        let mut result = None;
        self.until("API response", |event| {
            if let ClientEvent::Response {
                request_id,
                response,
            } = event
            {
                assert_eq!(*request_id, id);
                assert!(response.get("error").is_none(), "{response}");
                result = Some(response["result"].clone());
                true
            } else {
                false
            }
        });
        result.unwrap()
    }

    fn focused(&mut self, workspace: &str, tab: &str) {
        let matches = |s: &ClientShellSnapshot| {
            s.focused_workspace_id.as_deref() == Some(workspace)
                && s.focused_tab_id.as_deref() == Some(tab)
        };
        if !matches(self.snapshot.as_ref().unwrap()) {
            self.until(
                "focus snapshot",
                |event| matches!(event, ClientEvent::Snapshot(s) if matches(s)),
            );
        }
        eprintln!("focus verified: workspace={workspace} tab={tab}");
    }

    fn detach(self) {
        self.client.handle.disconnect();
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match self
                .client
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                Err(error) => panic!("detach did not close worker: {error}"),
                Ok(_) => {}
            }
        }
    }
}

#[test]
#[ignore = "requires explicit HERDR_TEST_BINARY; spawns an isolated live daemon"]
fn stable_endpoint_live() {
    let mut daemon = Daemon::start();
    let mut session = Session::open(&daemon);
    let snapshot = session.snapshot.as_ref().unwrap();
    let boot = snapshot.boot_id.clone();
    let workspace = snapshot.focused_workspace_id.clone().unwrap();
    let tab = snapshot.focused_tab_id.clone().unwrap();
    let pane = snapshot.focused_pane_id.clone().unwrap();

    // Split the literal so terminal input echo alone cannot satisfy the assertion.
    let marker = format!("HERDR_LIVE_{}_OK", std::process::id());
    session
        .client
        .handle
        .send_input(
            &boot,
            &pane,
            vec![
                ClientPaneInputEvent::TextCommit(format!(
                    "echo HERDR_LIVE_{}\"_OK\"",
                    std::process::id()
                )),
                ClientPaneInputEvent::Key {
                    code: ClientKeyCode::Enter,
                    modifiers: 0,
                    kind: ClientKeyKind::Press,
                    repeat_count: 1,
                    shifted_codepoint: None,
                    generated_text: None,
                    tracks_release: false,
                    physical_key_id: None,
                    windows_record: None,
                },
            ],
        )
        .unwrap();
    session.until("shell echo marker", |event| {
        matches!(event, ClientEvent::Surface(s) if s.frame.cells.chunks(usize::from(s.frame.width)).any(|row|
            row.iter().map(|cell| cell.symbol.as_str()).collect::<String>().trim() == marker))
    });
    eprintln!("semantic TextCommit + Enter produced shell output: {marker}");

    let id = session.client.handle.request(&boot, Method::TabCreate,
        json!({"workspace_id": workspace, "cwd": daemon.sandbox.dir, "focus": true, "label": "live-tab"})).unwrap();
    let result = session.response(id);
    let second_tab = result["tab"]["tab_id"]
        .as_str()
        .expect("created tab ID")
        .to_owned();
    session.focused(&workspace, &second_tab);
    let id = session.client.handle.focus_tab(&boot, &tab).unwrap();
    session.response(id);
    session.focused(&workspace, &tab);
    let id = session.client.handle.focus_tab(&boot, &second_tab).unwrap();
    session.response(id);
    session.focused(&workspace, &second_tab);

    let id = session
        .client
        .handle
        .request(
            &boot,
            Method::WorkspaceCreate,
            json!({"cwd": daemon.sandbox.dir, "focus": true, "label": "live-workspace"}),
        )
        .unwrap();
    let result = session.response(id);
    let second_workspace = result["workspace"]["workspace_id"]
        .as_str()
        .expect("created workspace ID")
        .to_owned();
    if session
        .snapshot
        .as_ref()
        .unwrap()
        .focused_workspace_id
        .as_deref()
        != Some(&second_workspace)
    {
        session.until("created workspace snapshot", |event| matches!(event,
            ClientEvent::Snapshot(s) if s.focused_workspace_id.as_deref() == Some(&second_workspace)));
    }
    let second_workspace_tab = session
        .snapshot
        .as_ref()
        .unwrap()
        .focused_tab_id
        .clone()
        .unwrap();
    let id = session
        .client
        .handle
        .focus_workspace(&boot, &workspace)
        .unwrap();
    session.response(id);
    session.focused(&workspace, &second_tab);
    let id = session
        .client
        .handle
        .focus_workspace(&boot, &second_workspace)
        .unwrap();
    session.response(id);
    session.focused(&second_workspace, &second_workspace_tab);

    session
        .client
        .handle
        .resize(
            &boot,
            ConnectOptions {
                surface_size: ClientSurfaceSize {
                    cols: 100,
                    rows: 30,
                },
                ..ConnectOptions::default()
            },
        )
        .unwrap();
    session.until("100x30 surface", |event| {
        matches!(event,
        ClientEvent::Surface(s) if s.frame.width == 100 && s.frame.height == 30)
    });
    eprintln!("resize verified: 100x30 surface");

    session.detach();
    assert!(daemon.child.as_mut().unwrap().try_wait().unwrap().is_none());
    let reattached = Session::open(&daemon);
    assert_eq!(reattached.snapshot.as_ref().unwrap().boot_id, boot);
    assert_eq!(reattached.snapshot.as_ref().unwrap().workspaces.len(), 2);
    assert_eq!(reattached.snapshot.as_ref().unwrap().tabs.len(), 3);
    reattached.detach();
    assert!(daemon.child.as_mut().unwrap().try_wait().unwrap().is_none());
    eprintln!(
        "detach verified: daemon alive; reconnected to same boot {boot} with 2 workspaces / 3 tabs"
    );
}

#[test]
#[ignore = "requires explicit HERDR_TEST_BINARY; spawns an isolated live daemon"]
fn daemon_completion_status_live() {
    use herdr_client::protocol::AgentStatus;
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
    };
    let daemon = Daemon::start();
    let mut session = Session::open(&daemon);
    let initial = session.snapshot.as_ref().unwrap();
    let boot = initial.boot_id.clone();
    let pane = initial.focused_pane_id.clone().unwrap();
    let mut previous_sequence = None;
    for (seq, wire_status) in [(1, "working"), (2, "blocked"), (3, "idle")] {
        // Agent hooks use the JSON API, not the shell's UI-only command allowlist.
        let mut api = UnixStream::connect(daemon.sandbox.dir.join("a.sock")).unwrap();
        api.set_read_timeout(Some(TIMEOUT)).unwrap();
        writeln!(
            api,
            "{}",
            json!({
                "id": format!("state-{seq}"), "method": "pane.report_agent",
                "params": {"pane_id": pane, "source": "claude-hook", "agent": "claude",
                    "state": wire_status, "seq": seq}
            })
        )
        .unwrap();
        let mut response = String::new();
        BufReader::new(api).read_line(&mut response).unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert!(response.get("error").is_none(), "{response}");
        let matches = |snapshot: &ClientShellSnapshot| {
            snapshot.agents.iter().any(|agent| {
                agent.pane_id == pane
                    && previous_sequence.is_none_or(|previous| agent.state_change_seq > previous)
                    && match wire_status {
                        "working" => agent.agent_status == AgentStatus::Working,
                        "blocked" => agent.agent_status == AgentStatus::Blocked,
                        // The daemon decides whether a finished agent is still
                        // unseen; the client reports whichever it sends.
                        _ => matches!(agent.agent_status, AgentStatus::Idle | AgentStatus::Done),
                    }
            })
        };
        if !matches(session.snapshot.as_ref().unwrap()) {
            session.until("agent status snapshot", |event| {
                matches!(event,
                ClientEvent::Snapshot(snapshot) if matches(snapshot))
            });
        }
        let snapshot = session.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.boot_id, boot);
        let agent = snapshot
            .agents
            .iter()
            .find(|agent| agent.pane_id == pane)
            .unwrap();
        previous_sequence = Some(agent.state_change_seq);
        // No client-side rewrite: the workspace row carries the daemon's own
        // aggregate, so every client of this daemon shows the same dot.
        assert_eq!(snapshot.workspaces[0].agent_status, agent.agent_status);
        eprintln!(
            "live status: wire={wire_status} status={:?} seq={}",
            agent.agent_status, agent.state_change_seq
        );
    }
    session.detach();
}
