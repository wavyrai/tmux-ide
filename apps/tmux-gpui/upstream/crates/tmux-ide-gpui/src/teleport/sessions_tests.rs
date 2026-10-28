use super::*;
use herdr_client::ConnectTarget;
use std::fs;

struct Homes {
    _temp: tempfile::TempDir,
    source: Host,
    destination: Host,
    source_home: std::path::PathBuf,
    destination_home: std::path::PathBuf,
}

fn homes() -> Homes {
    let temp = tempfile::tempdir().unwrap();
    let source_home = temp.path().join("source home");
    let destination_home = temp.path().join("destination home");
    fs::create_dir_all(&source_home).unwrap();
    fs::create_dir_all(&destination_home).unwrap();
    let host = |home: &Path| {
        let mut host = Host::new(&ConnectTarget::Local).unwrap();
        // Empty values fall back to $HOME, as `${VAR:-default}` does.
        host.env = vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("CLAUDE_CONFIG_DIR".into(), String::new()),
            ("CODEX_HOME".into(), String::new()),
            ("COPILOT_HOME".into(), String::new()),
        ];
        host
    };
    Homes {
        source: host(&source_home),
        destination: host(&destination_home),
        source_home,
        destination_home,
        _temp: temp,
    }
}

fn session(agent: &str, kind: SessionKind, value: &str) -> AgentSession {
    AgentSession {
        agent: agent.into(),
        kind,
        source: format!("herdr:{agent}"),
        value: value.into(),
    }
}

const FROM: &str = "/Users/me/.herdr/worktrees/app/feat";
const TO: &str = "/home/me/.herdr/worktrees/app/feat";

fn route<'a>(homes: &'a Homes, cwd: &'a str) -> Route<'a> {
    Route {
        source: &homes.source,
        destination: &homes.destination,
        from: FROM,
        to: TO,
        cwd,
    }
}

#[test]
fn claude_transcripts_move_to_the_destination_project_directory() {
    let homes = homes();
    let id = "8b2f421b-57e5-431d-b308-4ec956a18cae";
    let project = homes
        .source_home
        .join(".claude/projects")
        .join(claude_project_dir(FROM));
    fs::create_dir_all(project.join(id).join("subagents")).unwrap();
    fs::write(
        project.join(format!("{id}.jsonl")),
        format!(
            "{{\"cwd\":\"{FROM}\",\"sessionId\":\"{id}\"}}\n{{\"file\":\"{FROM}/src/a.rs\"}}\n"
        ),
    )
    .unwrap();
    fs::write(
        project.join(id).join("subagents/agent-1.jsonl"),
        format!("{{\"cwd\":\"{FROM}\"}}\n"),
    )
    .unwrap();
    let cwd = format!("{TO}/crates");
    let reference = move_session(
        AgentKind::Claude,
        &session("claude", SessionKind::Id, id),
        &route(&homes, &cwd),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(reference, id);
    let moved = homes
        .destination_home
        .join(".claude/projects")
        .join(claude_project_dir(&cwd));
    assert_eq!(
        fs::read_to_string(moved.join(format!("{id}.jsonl"))).unwrap(),
        format!("{{\"cwd\":\"{TO}\",\"sessionId\":\"{id}\"}}\n{{\"file\":\"{TO}/src/a.rs\"}}\n")
    );
    assert_eq!(
        fs::read_to_string(moved.join(id).join("subagents/agent-1.jsonl")).unwrap(),
        format!("{{\"cwd\":\"{TO}\"}}\n")
    );
}

#[test]
fn codex_rollouts_keep_their_dated_path() {
    let homes = homes();
    let id = "019d1f09-c867-7830-885a-2f163b1af69c";
    let day = homes.source_home.join(".codex/sessions/2026/03/24");
    fs::create_dir_all(&day).unwrap();
    let name = format!("rollout-2026-03-24T08-50-28-{id}.jsonl");
    fs::write(
        day.join(&name),
        format!("{{\"payload\":{{\"cwd\":\"{FROM}\"}}}}\n"),
    )
    .unwrap();
    move_session(
        AgentKind::Codex,
        &session("codex", SessionKind::Id, id),
        &route(&homes, TO),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(
            homes
                .destination_home
                .join(".codex/sessions/2026/03/24")
                .join(name)
        )
        .unwrap(),
        format!("{{\"payload\":{{\"cwd\":\"{TO}\"}}}}\n")
    );
}

#[test]
fn pi_sessions_land_in_the_destination_cwd_directory() {
    let homes = homes();
    let dir = homes
        .source_home
        .join(".pi/agent/sessions")
        .join(pi_session_dir(FROM));
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("2026-09-15T06-52-47-493Z_01a0a3d6.jsonl");
    fs::write(
        &file,
        format!("{{\"type\":\"session\",\"cwd\":\"{FROM}\"}}\n"),
    )
    .unwrap();
    let reference = move_session(
        AgentKind::Pi,
        &session("pi", SessionKind::Path, file.to_str().unwrap()),
        &route(&homes, TO),
        &AtomicBool::new(false),
    )
    .unwrap();
    let expected = homes
        .destination_home
        .join(".pi/agent/sessions")
        .join(pi_session_dir(TO))
        .join("2026-09-15T06-52-47-493Z_01a0a3d6.jsonl");
    assert_eq!(reference, expected.to_str().unwrap());
    assert_eq!(
        fs::read_to_string(expected).unwrap(),
        format!("{{\"type\":\"session\",\"cwd\":\"{TO}\"}}\n")
    );
}

#[test]
fn copilot_session_directories_move_whole() {
    let homes = homes();
    let id = "edf9d762-608a-4508-beb3-b3fd328cd493";
    let dir = homes.source_home.join(".copilot/session-state").join(id);
    fs::create_dir_all(dir.join("checkpoints")).unwrap();
    fs::write(
        dir.join("workspace.yaml"),
        format!("id: {id}\ncwd: {FROM}\ngit_root: {FROM}\n"),
    )
    .unwrap();
    fs::write(
        dir.join("events.jsonl"),
        format!("{{\"type\":\"session.start\",\"cwd\":\"{FROM}\"}}\n"),
    )
    .unwrap();
    fs::write(dir.join("checkpoints/index.md"), "# Checkpoints\n").unwrap();
    let reference = move_session(
        AgentKind::Copilot,
        &session("copilot", SessionKind::Id, id),
        &route(&homes, TO),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(reference, id);
    let moved = homes
        .destination_home
        .join(".copilot/session-state")
        .join(id);
    assert_eq!(
        fs::read_to_string(moved.join("workspace.yaml")).unwrap(),
        format!("id: {id}\ncwd: {TO}\ngit_root: {TO}\n")
    );
    assert_eq!(
        fs::read_to_string(moved.join("events.jsonl")).unwrap(),
        format!("{{\"type\":\"session.start\",\"cwd\":\"{TO}\"}}\n")
    );
    assert_eq!(
        fs::read_to_string(moved.join("checkpoints/index.md")).unwrap(),
        "# Checkpoints\n"
    );
}

#[test]
fn letta_conversations_stay_on_their_server() {
    let homes = homes();
    let reference = move_session(
        AgentKind::Letta,
        &session("letta", SessionKind::Id, "default:agent-1"),
        &route(&homes, TO),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(reference, "default:agent-1");
    assert!(
        fs::read_dir(&homes.destination_home)
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn missing_sessions_and_unsafe_ids_are_typed() {
    let homes = homes();
    let cancelled = AtomicBool::new(false);
    for agent in [AgentKind::Claude, AgentKind::Codex, AgentKind::Copilot] {
        let result = move_session(
            agent,
            &session(agent.name(), SessionKind::Id, "absent"),
            &route(&homes, TO),
            &cancelled,
        );
        assert!(
            matches!(result, Err(Error::SessionMissing { .. })),
            "{result:?}"
        );
    }
    let result = move_session(
        AgentKind::Claude,
        &session("claude", SessionKind::Id, "../../etc/passwd"),
        &route(&homes, TO),
        &cancelled,
    );
    assert!(matches!(
        result,
        Err(Error::SessionMissing { agent: "claude" })
    ));
    let result = move_session(
        AgentKind::Copilot,
        &session("copilot", SessionKind::Id, "../config.json"),
        &route(&homes, TO),
        &cancelled,
    );
    assert!(matches!(
        result,
        Err(Error::SessionMissing { agent: "copilot" })
    ));
    // An id that a command could read as an option never reaches a script,
    // even when a session file of that name exists.
    let planted = [
        homes
            .source_home
            .join(".claude/projects/p/--remove-files.jsonl"),
        homes
            .source_home
            .join(".copilot/session-state/--remove-files/events.jsonl"),
    ];
    for file in &planted {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "{}\n").unwrap();
    }
    for agent in [AgentKind::Claude, AgentKind::Codex, AgentKind::Copilot] {
        let result = move_session(
            agent,
            &session(agent.name(), SessionKind::Id, "--remove-files"),
            &route(&homes, TO),
            &cancelled,
        );
        assert!(
            matches!(result, Err(Error::SessionMissing { .. })),
            "{result:?}"
        );
    }
    assert!(planted.iter().all(|file| file.exists()));
    // Agents whose storage is unconfirmed never move a session.
    let result = move_session(
        AgentKind::Droid,
        &session("droid", SessionKind::Id, "abc"),
        &route(&homes, TO),
        &cancelled,
    );
    assert!(matches!(
        result,
        Err(Error::SessionMissing { agent: "droid" })
    ));
}

#[test]
fn rewritten_archives_drop_unsafe_entries() {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, body) in [
        ("ok.jsonl", FROM),
        ("../escape.jsonl", "x"),
        ("bin.dat", FROM),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        // `append_data` refuses `..`, so write the raw name into the header.
        header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        builder.append(&header, body.as_bytes()).unwrap();
    }
    let archive = builder.into_inner().unwrap();
    let rewritten = rewrite_archive(&archive, FROM, TO).unwrap();
    let mut names = Vec::new();
    let mut reader = tar::Archive::new(rewritten.as_slice());
    for entry in reader.entries().unwrap() {
        let mut entry = entry.unwrap();
        let name = entry.path().unwrap().to_string_lossy().into_owned();
        let mut body = String::new();
        entry.read_to_string(&mut body).unwrap();
        names.push((name, body));
    }
    assert_eq!(
        names,
        [
            ("ok.jsonl".to_owned(), TO.to_owned()),
            ("bin.dat".to_owned(), FROM.to_owned())
        ]
    );
}
