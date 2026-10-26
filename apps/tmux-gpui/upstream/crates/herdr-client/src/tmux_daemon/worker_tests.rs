use super::*;
use crate::tmux_daemon::{CatalogAction, CatalogResult, CatalogWorker, WorkerError};

pub(super) fn await_result(worker: &mut CatalogWorker) -> Result<CatalogResult, Error> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(result) = worker.poll().unwrap() {
            return result;
        }
        assert!(Instant::now() < deadline, "catalog response timed out");
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn cancelled_catalog_cannot_restore_a_selection_or_replay_a_busy_mutation() {
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let (port, peer) = peer_many(3, move |index| match index {
        0 => response(&identity()),
        1 => {
            entered.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(5)).unwrap();
            response(&registrations())
        }
        _ => response(&serde_json::json!({"version":1,"servers":[]})),
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let mut worker = CatalogWorker::spawn(path).unwrap();
    worker.submit(CatalogAction::Servers).unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(
        worker.submit(CatalogAction::Create {
            scope: server_scope(),
            operation_id: uuid::Uuid::new_v4(),
            display_name: "must not run".into()
        }),
        Err(WorkerError::Busy)
    ));
    worker.cancel();
    worker.submit(CatalogAction::Servers).unwrap();
    release.send(()).unwrap();
    assert!(
        matches!(await_result(&mut worker).unwrap(), CatalogResult::Servers(entries) if entries.is_empty())
    );
    assert!(worker.poll().unwrap().is_none());
    drop(worker);
    let requests = peer.join().unwrap();
    assert!(!requests.contains("POST "));
    assert_eq!(requests.matches("GET ").count(), 3);
}
#[test]
fn dropping_catalog_worker_does_not_wait_for_a_held_http_response() {
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let (port, peer) = peer_many(2, move |index| {
        if index == 0 {
            return response(&identity());
        }
        entered.send(()).unwrap();
        // Drop must return before this response is released. No timing assertion
        // or assumed HTTP latency is needed to prove the ownership ordering.
        held.recv_timeout(Duration::from_secs(5)).unwrap();
        response(&registrations())
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let mut worker = CatalogWorker::spawn(path).unwrap();
    worker.submit(CatalogAction::Servers).unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(worker);
    release.send(()).unwrap();
    assert_eq!(peer.join().unwrap().matches("GET ").count(), 2);
}

#[test]
fn owner_replacement_requires_explicit_reset_and_reuses_the_worker() {
    let (old_port, old_peer) = peer_many(2, |index| {
        response(&if index == 0 {
            identity()
        } else {
            registrations()
        })
    });
    let (new_port, new_peer) = peer_many(2, |index| {
        response(&if index == 0 {
            identity()
        } else {
            registrations()
        })
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(old_port));
    let mut worker = CatalogWorker::spawn(path.clone()).unwrap();
    worker.submit(CatalogAction::Servers).unwrap();
    assert!(matches!(
        await_result(&mut worker).unwrap(),
        CatalogResult::Servers(_)
    ));
    old_peer.join().unwrap();
    fs::write(&path, serde_json::to_vec(&value(new_port)).unwrap()).unwrap();
    worker.submit(CatalogAction::Servers).unwrap();
    assert!(matches!(
        await_result(&mut worker),
        Err(Error::RecordChanged)
    ));
    worker.reset();
    worker.submit(CatalogAction::Servers).unwrap();
    assert!(matches!(
        await_result(&mut worker).unwrap(),
        CatalogResult::Servers(_)
    ));
    assert_eq!(new_peer.join().unwrap().matches("GET ").count(), 2);
}

#[test]
fn cancelling_during_session_validation_prevents_the_later_admission_post() {
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let live = "live-session.0123456789abcdef0123";
    let (port, peer) = peer_many(4, move |index| match index {
        0 => response(&identity()),
        2 => {
            entered.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(5)).unwrap();
            let scope = server_scope();
            response(
                &serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"sessions":[{"liveSessionId":live,"sessionName":"fixture","workspaceName":null,"paneCount":1}]}),
            )
        }
        _ => response(&registrations()),
    });
    let sandbox = Sandbox::new();
    let mut worker = CatalogWorker::spawn(sandbox.record(&value(port))).unwrap();
    worker
        .submit(CatalogAction::Open {
            scope: server_scope(),
            live_session_id: live.into(),
        })
        .unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.cancel();
    worker.submit(CatalogAction::Servers).unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        await_result(&mut worker).unwrap(),
        CatalogResult::Servers(_)
    ));
    let requests = peer.join().unwrap();
    assert_eq!(requests.matches("GET ").count(), 4);
    assert!(!requests.contains("POST "));
}
