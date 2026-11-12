//! PM, 12 Nov 2026: the app asked `GET /api/v1/tmux-servers` before every
//! scoped request (8 times to open one session). On a 2.9.22 daemon each of
//! those probed every tmux server, and one slow probe closed every stream.
//! The list is now remembered per daemon generation for at most `KNOWN_AGE`,
//! and dropped by an events change, a failed request, and a new discovery.
use super::*;
use std::sync::Arc;

const SESSIONS: &str =
    r#"{"version":1,"server":{"serverId":"SERVER","generation":"GENERATION"},"sessions":[]}"#;
fn sessions() -> String {
    let scope = server_scope();
    let body = SESSIONS
        .replace("SERVER", &scope.server_id)
        .replace("GENERATION", &scope.generation);
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
fn lists(requests: &str) -> usize {
    requests.matches("GET /api/v1/tmux-servers HTTP").count()
}
fn discovered(port: u16) -> (Sandbox, Arc<LocalDaemon>) {
    let sandbox = Sandbox::new();
    let daemon = LocalDaemon::discover(&sandbox.record(&value(port))).unwrap();
    (sandbox, Arc::new(daemon))
}

/// Opening a session selects its server for the session list, the open, the
/// lease and the layout: one list answers all of them.
#[test]
fn scoped_requests_share_one_server_list() {
    cached(false, || {
        let (port, worker) = peer_many(5, |index| match index {
            0 => response(&identity()),
            1 => response(&registrations()),
            _ => sessions(),
        });
        let (_sandbox, daemon) = discovered(port);
        for _ in 0..3 {
            let client = daemon.select_server(&server_scope()).unwrap();
            client.sessions().unwrap();
        }
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 1, "{requests}");
        assert_eq!(requests.matches("/sessions?version=2").count(), 3);
    });
}

/// A catalog read is the re-read: it always asks, and what it learns serves
/// the selections that follow it.
#[test]
fn a_catalog_read_always_asks_and_refreshes_what_selections_use() {
    cached(false, || {
        let (port, worker) = peer_many(4, |index| match index {
            0 => response(&identity()),
            3 => sessions(),
            _ => response(&registrations()),
        });
        let (_sandbox, daemon) = discovered(port);
        daemon.list_servers().unwrap();
        daemon.list_servers().unwrap();
        daemon
            .select_server(&server_scope())
            .unwrap()
            .sessions()
            .unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 2, "{requests}");
    });
}

/// Home's catalog (the server list, each server's sessions, the server list
/// again) asked three times per server. A first read now asks twice; one that
/// follows within the list's life asks once, at its end, and a list that
/// changed meanwhile still publishes nothing.
#[test]
fn a_fleet_catalog_asks_twice_when_cold_and_once_when_the_list_is_known() {
    cached(false, || {
        let (port, worker) = peer_many(8, |index| match index {
            0 => response(&identity()),
            1 | 3 | 5 => response(&registrations()),
            7 => response(&serde_json::json!({"version":1,"servers":[]})),
            _ => sessions(),
        });
        let (_sandbox, daemon) = discovered(port);
        let owner = owner::Owner::Local(daemon);
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Cold: list, sessions, list.
        assert_eq!(owner.fleet_catalog(&cancelled).unwrap().sessions.len(), 1);
        // Warm: sessions, list.
        assert_eq!(owner.fleet_catalog(&cancelled).unwrap().sessions.len(), 1);
        // Warm, and the servers changed since: the closing read says so.
        assert!(matches!(
            owner.fleet_catalog(&cancelled),
            Err(Error::ServerChanged)
        ));
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 4, "{requests}");
        assert_eq!(requests.matches("/sessions?version=2").count(), 3);
    });
}

/// The generation is in every scoped URL, so the daemon refuses a request for
/// a generation it retired. That failure drops the list: the next selection
/// asks again and reports the change.
#[test]
fn a_refused_scoped_request_drops_the_list() {
    cached(false, || {
        let (port, worker) = peer_many(4, |index| match index {
            0 => response(&identity()),
            1 => response(&registrations()),
            2 => "HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            _ => response(&serde_json::json!({"version":1,"servers":[]})),
        });
        let (_sandbox, daemon) = discovered(port);
        let client = daemon.select_server(&server_scope()).unwrap();
        assert!(matches!(client.sessions(), Err(Error::RequestStatus(409))));
        assert!(matches!(
            daemon.select_server(&server_scope()),
            Err(Error::ServerChanged)
        ));
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 2, "{requests}");
    });
}

/// The events lane reports a change, or ends: whoever polls it (the app's
/// catalog) finds the list gone and the next selection asks again.
#[test]
fn an_events_change_or_a_lost_events_lane_drops_the_list() {
    for lost in [false, true] {
        cached(false, || {
            let (port, worker) = peer_many(3, |index| match index {
                0 => response(&identity()),
                _ => response(&registrations()),
            });
            let (_sandbox, daemon) = discovered(port);
            daemon.select_server(&server_scope()).unwrap();
            let lane = CatalogWatchWorker::detached(0);
            assert!(lane.poll().unwrap().is_none());
            assert!(servers::remembered(), "a quiet lane dropped the list");
            lane.report_detached(lost);
            assert_eq!(lane.poll().unwrap().map(|r| r.is_err()), Some(lost));
            assert!(!servers::remembered());
            daemon.select_server(&server_scope()).unwrap();
            let requests = worker.join().unwrap();
            assert_eq!(lists(&requests), 2, "{requests}");
        });
    }
}

#[test]
fn a_list_older_than_five_seconds_is_read_again() {
    cached(false, || {
        let (port, worker) = peer_many(3, |index| match index {
            0 => response(&identity()),
            _ => response(&registrations()),
        });
        let (_sandbox, daemon) = discovered(port);
        assert_eq!(servers::KNOWN_AGE, Duration::from_secs(5));
        daemon.select_server(&server_scope()).unwrap();
        servers::backdate(Duration::from_millis(4900));
        daemon.select_server(&server_scope()).unwrap();
        servers::backdate(Duration::from_millis(200));
        daemon.select_server(&server_scope()).unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 2, "{requests}");
    });
}

/// A rewritten record is another daemon: the remembered list of the old one
/// is not used, and nothing is sent.
#[test]
fn a_rewritten_record_ends_the_use_of_the_list_without_a_request() {
    cached(false, || {
        let (port, worker) = peer_many(2, |index| match index {
            0 => response(&identity()),
            _ => response(&registrations()),
        });
        let sandbox = Sandbox::new();
        let path = sandbox.record(&value(port));
        let daemon = Arc::new(LocalDaemon::discover(&path).unwrap());
        daemon.select_server(&server_scope()).unwrap();
        let mut replaced = value(port);
        replaced["authToken"] = "a-replacement-daemon-token".into();
        fs::write(&path, replaced.to_string()).unwrap();
        assert!(matches!(
            daemon.select_server(&server_scope()),
            Err(Error::RecordChanged)
        ));
        assert_eq!(lists(&worker.join().unwrap()), 1);
    });
}

/// A list belongs to the daemon generation that sent it.
#[test]
fn a_list_never_serves_another_daemon() {
    cached(false, || {
        let reply = |index| match index {
            0 => response(&identity()),
            _ => response(&registrations()),
        };
        let (port_a, worker_a) = peer_many(2, reply);
        let (port_b, worker_b) = peer_many(2, reply);
        let (_sandbox_a, a) = discovered(port_a);
        a.select_server(&server_scope()).unwrap();
        let (_sandbox_b, b) = discovered(port_b);
        b.select_server(&server_scope()).unwrap();
        assert_eq!(lists(&worker_a.join().unwrap()), 1);
        assert_eq!(lists(&worker_b.join().unwrap()), 1);
    });
}

/// The app's workers each discover the daemon themselves (catalog, layout,
/// registry). They share one list; a caller that starts over (Refresh, Home,
/// a recovery) drops it for all of them.
#[test]
fn every_owner_of_one_daemon_shares_the_list_until_a_caller_starts_over() {
    cached(false, || {
        let (port, worker) = peer_many(3, |index| match index {
            0 => response(&identity()),
            _ => response(&registrations()),
        });
        let sandbox = Sandbox::new();
        let path = sandbox.record(&value(port));
        let first = Arc::new(LocalDaemon::discover(&path).unwrap());
        first.select_server(&server_scope()).unwrap();
        let again = Arc::new(LocalDaemon::discover(&path).unwrap());
        again.select_server(&server_scope()).unwrap();
        forget_known_servers();
        first.select_server(&server_scope()).unwrap();
        again.select_server(&server_scope()).unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 2, "{requests}");
    });
}

/// A list that was on its way while something dropped the list is not kept:
/// it may be from before the change.
#[test]
fn a_read_that_overlaps_a_drop_is_not_remembered() {
    cached(false, || {
        let (port, worker) = peer_many(3, |index| match index {
            0 => response(&identity()),
            1 => {
                servers::forget_for_tests();
                response(&registrations())
            }
            _ => response(&registrations()),
        });
        let (_sandbox, daemon) = discovered(port);
        daemon.select_server(&server_scope()).unwrap();
        daemon.select_server(&server_scope()).unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(lists(&requests), 2, "{requests}");
    });
}

/// With the cache off (as every scripted-peer test in this crate runs), each
/// selection asks, as before.
#[test]
fn without_the_cache_every_selection_asks() {
    let (port, worker) = peer_many(3, |index| match index {
        0 => response(&identity()),
        _ => response(&registrations()),
    });
    let (_sandbox, daemon) = discovered(port);
    daemon.select_server(&server_scope()).unwrap();
    daemon.select_server(&server_scope()).unwrap();
    assert_eq!(lists(&worker.join().unwrap()), 2);
}
