#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};
#[test]
fn remote_owner_reuses_catalog_validation_without_local_authority() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let identity = serde_json::json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z"});
    let mut daemon = identity.clone();
    daemon.as_object_mut().unwrap().remove("ok");
    daemon["port"] = 4111.into();
    daemon["bindHostname"] = "127.0.0.1".into();
    daemon["authToken"] = "secret-fixture".into();
    let descriptor = crate::tmux_ssh::RemoteDescriptor::parse(
        &serde_json::to_vec(&serde_json::json!({"version":1,"daemon":daemon})).unwrap(),
        None,
    )
    .unwrap();
    let scope = crate::tmux_handoff::ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    };
    let served_scope = scope.clone();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let servers = serde_json::json!({"version":1,"servers":[{"state":"online","serverId":served_scope.server_id,"label":"Remote","generation":served_scope.generation}]});
        let sessions = serde_json::json!({"version":1,"server":{"serverId":served_scope.server_id,"generation":served_scope.generation},"sessions":[{"liveSessionId":format!("live-session.{}", "a".repeat(20)),"sessionName":"remote-fixture","workspaceName":null,"paneCount":1}]});
        let session_path = format!(
            "/api/v1/tmux-servers/{}/{}/sessions",
            served_scope.server_id, served_scope.generation
        );
        for (index, (path, body)) in [
            ("/identity", identity),
            ("/api/v1/tmux-servers", servers.clone()),
            ("/api/v1/tmux-servers", servers),
            (session_path.as_str(), sessions),
        ]
        .into_iter()
        .enumerate()
        {
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
            }
            let request = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
            assert!(request.starts_with(&format!("get {path} ")));
            assert_eq!(
                request.contains("authorization: bearer secret-fixture"),
                index != 0
            );
            let body = serde_json::to_vec(&body).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let owner = Owner::Remote(route.clone());
    assert!(matches!(owner.local(), Err(Error::LocalAuthorityRequired)));
    assert!(matches!(
        owner.verify_current(),
        Err(Error::LocalAuthorityRequired)
    ));
    assert!(
        matches!(&owner.list_servers().unwrap()[0], ServerRegistration::Online {scope:actual,..} if actual==&scope)
    );
    let client = owner.select_server(&scope).unwrap();
    let sessions = client.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_name, "remote-fixture");
    client.retire();
    assert!(matches!(client.sessions(), Err(Error::Retired)));
    drop(client);
    drop(owner);
    let Ok(route) = Arc::try_unwrap(route) else {
        panic!("route still retained")
    };
    route.shutdown_fixture().unwrap();
    server.join().unwrap();
}
