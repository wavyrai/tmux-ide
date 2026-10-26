use super::*;
use crate::tmux_daemon::{CatalogAction, CatalogResult, CatalogWorker};
fn session_rows() -> serde_json::Value {
    serde_json::json!({"version":1,"server":server_scope(),"sessions":[{
        "liveSessionId":format!("live-session.{}", "a".repeat(20)),
        "sessionName":"fixture", "workspaceName":null,"paneCount":2
    }]})
}
#[test]
fn fleet_catalog_publishes_complete_scoped_rows_without_opening_terminals() {
    let (port, peer) = peer_many(9, |index| {
        response(&match index {
            0 | 1 | 3 | 6 | 8 => identity(),
            5 => session_rows(),
            _ => registrations(),
        })
    });
    let sandbox = Sandbox::new();
    let mut worker = CatalogWorker::spawn(sandbox.record(&value(port))).unwrap();
    worker.submit(CatalogAction::FleetCatalog).unwrap();
    let CatalogResult::FleetCatalog(result) = worker_tests::await_result(&mut worker).unwrap()
    else {
        panic!("wrong catalog result")
    };
    assert_eq!(result.servers.len(), 1);
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].scope, server_scope());
    assert_eq!(result.sessions[0].sessions[0].session_name, "fixture");
    let requests = peer.join().unwrap();
    assert_eq!(requests.matches("GET ").count(), 9);
    assert!(!requests.contains("POST "));
}
#[test]
fn registration_change_during_scan_discards_all_gathered_rows() {
    let (port, peer) = peer_many(9, |index| {
        response(&match index {
            0 | 1 | 3 | 6 | 8 => identity(),
            5 => session_rows(),
            7 => serde_json::json!({"version":1,"servers":[]}),
            _ => registrations(),
        })
    });
    let sandbox = Sandbox::new();
    let mut worker = CatalogWorker::spawn(sandbox.record(&value(port))).unwrap();
    worker.submit(CatalogAction::FleetCatalog).unwrap();
    assert!(matches!(
        worker_tests::await_result(&mut worker),
        Err(Error::ServerChanged)
    ));
    peer.join().unwrap();
}
#[test]
fn canceled_scan_cannot_publish_or_continue_to_final_verification() {
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let (port, peer) = peer_many(7, move |index| {
        response(&match index {
            0 | 1 | 3 => identity(),
            5 => {
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(5)).unwrap();
                session_rows()
            }
            // Only the next explicitly submitted Servers operation reaches this request.
            6 => serde_json::json!({"version":1,"servers":[]}),
            _ => registrations(),
        })
    });
    let sandbox = Sandbox::new();
    let mut worker = CatalogWorker::spawn(sandbox.record(&value(port))).unwrap();
    worker.submit(CatalogAction::FleetCatalog).unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.cancel();
    worker.submit(CatalogAction::Servers).unwrap();
    release.send(()).unwrap();
    assert!(
        matches!(worker_tests::await_result(&mut worker).unwrap(), CatalogResult::Servers(rows) if rows.is_empty())
    );
    assert!(worker.poll().unwrap().is_none());
    assert_eq!(peer.join().unwrap().matches("GET ").count(), 7);
}
