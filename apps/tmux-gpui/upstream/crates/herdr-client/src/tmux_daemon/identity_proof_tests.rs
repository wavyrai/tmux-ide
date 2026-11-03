//! Card #703: one `/identity` proof per daemon generation, kept at most
//! `PROOF_AGE`, dropped by any failed request, never recorded by a failed or
//! overlapped probe, and never trusted once the record's pid is gone.
use super::*;
use std::sync::PoisonError;

/// The proof is process-wide: tests that turn its cache on take turns.
static IDENTITY_CACHE_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn cached(pid_check: bool, body: impl FnOnce()) {
    let _turn = IDENTITY_CACHE_TESTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    PROOF.lock().unwrap_or_else(PoisonError::into_inner).proven = None;
    IDENTITY_CACHE.with(|cache| cache.set(true));
    PID_CHECK.with(|check| check.set(pid_check));
    body();
    IDENTITY_CACHE.with(|cache| cache.set(false));
    PID_CHECK.with(|check| check.set(false));
}
const SERVER_ERROR: &str =
    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const SHORT_BODY: &str = "HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{";
fn servers(body: &[u8]) -> bool {
    String::from_utf8_lossy(body).contains("\"servers\"")
}

#[test]
fn one_identity_proof_serves_a_daemon_until_a_request_fails() {
    cached(false, || {
        let (port, worker) = peer_many(5, |index| match index {
            0 | 3 => response(&identity()),
            2 => SERVER_ERROR.into(),
            _ => response(&registrations()),
        });
        let sandbox = Sandbox::new();
        let path = sandbox.record(&value(port));
        let daemon = LocalDaemon::discover(&path).unwrap();
        daemon.verify_current().unwrap();
        daemon.get_resource("api/v1/tmux-servers").unwrap();
        daemon.verify_current().unwrap();
        assert!(matches!(
            daemon.get_resource("api/v1/tmux-servers"),
            Err(Error::RequestStatus(500))
        ));
        daemon.verify_current().unwrap();
        daemon.get_resource("api/v1/tmux-servers").unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(requests.matches("GET /identity").count(), 2, "{requests}");
        // A new record is a new daemon generation: refused, never sent credentials.
        let mut replaced = value(port);
        replaced["authToken"] = "a-replacement-daemon-token".into();
        fs::write(&path, replaced.to_string()).unwrap();
        assert!(matches!(daemon.verify_current(), Err(Error::RecordChanged)));
    });
}

/// The proof belongs to one daemon generation: another record is proven itself.
#[test]
fn an_identity_proof_never_covers_another_daemon() {
    cached(false, || {
        let (port_a, worker_a) = peer(|| response(&identity()));
        let (port_b, worker_b) = peer(|| response(&identity()));
        let (sandbox_a, sandbox_b) = (Sandbox::new(), Sandbox::new());
        let a = LocalDaemon::discover(&sandbox_a.record(&value(port_a))).unwrap();
        a.verify_current().unwrap();
        LocalDaemon::discover(&sandbox_b.record(&value(port_b))).unwrap();
        assert!(worker_a.join().unwrap().contains("GET /identity"));
        assert!(worker_b.join().unwrap().contains("GET /identity"));
    });
}

/// Review item 1: a probe that fails (here a different pid answers) records
/// nothing, so the next check probes again before any credential is sent.
#[test]
fn a_failed_identity_proof_is_never_cached() {
    cached(false, || {
        let (port, worker) = peer_many(3, |index| match index {
            0 => {
                let mut other = identity();
                other["pid"] = 124.into();
                response(&other)
            }
            1 => response(&identity()),
            _ => response(&registrations()),
        });
        let sandbox = Sandbox::new();
        let path = sandbox.record(&value(port));
        assert!(matches!(
            LocalDaemon::discover(&path),
            Err(Error::IdentityChanged)
        ));
        let daemon = LocalDaemon::discover(&path).unwrap();
        let body = daemon.get_resource("api/v1/tmux-servers").unwrap();
        assert!(servers(&body), "the second check was skipped");
        let requests = worker.join().unwrap();
        assert_eq!(requests.matches("GET /identity").count(), 2, "{requests}");
        let second = requests.rfind("GET /identity").unwrap();
        let credential = requests.to_lowercase().find("authorization").unwrap();
        assert!(
            credential > second,
            "a credential preceded the second proof"
        );
    });
}

/// Review item 2: every way a credential-bearing request can fail drops the
/// proof. `None` is a refused connection: the peer has already closed. An
/// empty reply closes an accepted connection before the response head.
#[test]
fn every_failed_request_drops_the_proof() {
    type Call = fn(&LocalDaemon) -> bool;
    let get: Call = |d| d.get_resource("api/v1/tmux-servers").is_err();
    let post: Call = |d| {
        d.post_resource_with_options("api/v1/x", b"{}", &[], Duration::from_secs(2))
            .is_err()
    };
    let watch: Call = |d| {
        d.watch_saved_machines(None, &MachineWatchCancellation::default())
            .is_err()
    };
    let preferences: Call = |d| d.fleet_preferences().is_err();
    let cases: [(&str, Option<&'static str>, Call); 16] = [
        ("GET refused", None, get),
        ("GET closed", Some(""), get),
        ("GET status", Some(SERVER_ERROR), get),
        ("GET body", Some(SHORT_BODY), get),
        ("POST refused", None, post),
        ("POST closed", Some(""), post),
        ("POST status", Some(SERVER_ERROR), post),
        ("POST body", Some(SHORT_BODY), post),
        ("long-poll refused", None, watch),
        ("long-poll closed", Some(""), watch),
        ("long-poll status", Some(SERVER_ERROR), watch),
        ("long-poll body", Some(SHORT_BODY), watch),
        ("preferences refused", None, preferences),
        ("preferences closed", Some(""), preferences),
        ("preferences status", Some(SERVER_ERROR), preferences),
        ("preferences body", Some(SHORT_BODY), preferences),
    ];
    cached(false, || {
        for (label, reply, call) in cases {
            let (port, worker) = peer_many(1 + usize::from(reply.is_some()), move |index| {
                if index == 0 {
                    response(&identity())
                } else {
                    reply.unwrap_or_default().into()
                }
            });
            let sandbox = Sandbox::new();
            let daemon = LocalDaemon::discover(&sandbox.record(&value(port))).unwrap();
            assert!(proven(&daemon.fingerprint), "{label}: not proven first");
            if reply.is_none() {
                worker.join().unwrap();
                assert!(call(&daemon), "{label}: the request succeeded");
            } else {
                assert!(call(&daemon), "{label}: the request succeeded");
                worker.join().unwrap();
            }
            assert!(!proven(&daemon.fingerprint), "{label}: the proof survived");
        }
    });
}

/// Review item 3: a request fails while a probe is in flight. The probe then
/// succeeds, but its proof predates the failure and is not recorded.
#[test]
fn a_probe_that_overlaps_a_failure_records_no_proof() {
    cached(false, || {
        let sandbox = Sandbox::new();
        let path = sandbox.0.join("daemon.json");
        let record = path.clone();
        let (port, worker) = peer_many(3, move |index| match index {
            0 => {
                // Another thread's request fails during this probe.
                IDENTITY_CACHE.with(|cache| cache.set(true));
                let (_, fingerprint) = record::read(&record).unwrap();
                disprove(&fingerprint);
                response(&identity())
            }
            1 => response(&identity()),
            _ => response(&registrations()),
        });
        sandbox.record(&value(port));
        let daemon = LocalDaemon::discover(&path).unwrap();
        assert!(!proven(&daemon.fingerprint), "an overlapped proof was kept");
        daemon.verify_current().unwrap();
        let body = daemon.get_resource("api/v1/tmux-servers").unwrap();
        assert!(servers(&body), "the check after the failure was skipped");
        let requests = worker.join().unwrap();
        assert_eq!(requests.matches("GET /identity").count(), 2, "{requests}");
    });
}

/// PM decision on N1: a proof older than `PROOF_AGE` is probed again; a
/// younger one is not.
#[test]
fn a_proof_older_than_five_seconds_is_probed_again() {
    let backdate = |by: Duration| {
        let mut proof = PROOF.lock().unwrap();
        let (fingerprint, _) = proof.proven.unwrap();
        proof.proven = Some((fingerprint, Instant::now().checked_sub(by).unwrap()));
    };
    cached(false, || {
        let (port, worker) = peer_many(3, |index| match index {
            0 | 1 => response(&identity()),
            _ => response(&registrations()),
        });
        let sandbox = Sandbox::new();
        let daemon = LocalDaemon::discover(&sandbox.record(&value(port))).unwrap();
        assert_eq!(PROOF_AGE, Duration::from_secs(5));
        backdate(PROOF_AGE + Duration::from_millis(1));
        daemon.verify_current().unwrap();
        backdate(PROOF_AGE - Duration::from_secs(1));
        daemon.verify_current().unwrap();
        let body = daemon.get_resource("api/v1/tmux-servers").unwrap();
        assert!(
            servers(&body),
            "a stale proof was trusted, or a fresh one probed"
        );
        let requests = worker.join().unwrap();
        assert_eq!(requests.matches("GET /identity").count(), 2, "{requests}");
    });
}

/// PM decision on N1: the daemon dies without a new record and another
/// process binds its port. With a fresh proof still cached, no request
/// reaches that listener, so no Authorization is sent.
#[test]
fn a_dead_owner_gets_no_credentials_even_with_a_fresh_proof() {
    cached(true, || {
        let mut owner = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut record = value(port);
        record["pid"] = owner.id().into();
        let sandbox = Sandbox::new();
        let path = sandbox.record(&record);
        // The cached, fresh proof is the case this guard exists for.
        let (record, fingerprint) = record::read(&path).unwrap();
        let daemon = LocalDaemon {
            base_url: record.endpoint().unwrap(),
            record,
            fingerprint,
            path,
            agent: agent(),
        };
        prove(daemon.fingerprint, proof_epoch(), Instant::now());
        assert!(daemon.verify_current().is_ok(), "a live owner was refused");
        owner.kill().unwrap();
        owner.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        let squatter = loop {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => break listener,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Err(error) => panic!("{error}"),
            }
        };
        squatter.set_nonblocking(true).unwrap();
        assert!(matches!(daemon.verify_current(), Err(Error::OwnerExited)));
        assert!(!proven(&daemon.fingerprint), "the proof outlived its owner");
        assert!(matches!(
            daemon.get_resource("api/v1/tmux-servers"),
            Err(Error::OwnerExited)
        ));
        assert!(matches!(
            daemon.fleet_preferences(),
            Err(Error::OwnerExited)
        ));
        // Review round 2, item 1: mutations (open, create, split) reach the
        // daemon only through this path, without `verify_current`.
        assert!(matches!(
            daemon.post_resource_with_options("api/v1/x", b"{}", &[], Duration::from_secs(2)),
            Err(Error::OwnerExited)
        ));
        assert!(matches!(
            daemon.watch_saved_machines(None, &MachineWatchCancellation::default()),
            Err(Error::OwnerExited)
        ));
        assert!(
            matches!(squatter.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "a request reached the process on the dead owner's port"
        );
    });
}

/// Only "no such process" counts as gone: launchd (pid 1) belongs to root,
/// so `kill(1, 0)` is refused, and it is alive. Pids that can't name one
/// process (0 is our process group) are gone.
#[test]
fn owner_liveness_reads_kill_zero() {
    cached(true, || {
        assert!(owner_alive(std::process::id()));
        assert!(owner_alive(1));
        assert!(!owner_alive(0));
        assert!(!owner_alive(u32::MAX));
    });
}

/// Review round 2, N1: the proof's age counts from when the probe started, so
/// a slow `/identity` reply never stretches the 5 s window.
#[test]
fn a_proofs_age_counts_from_the_probe_start() {
    cached(false, || {
        let (port, worker) = peer(|| {
            thread::sleep(Duration::from_millis(300));
            response(&identity())
        });
        let sandbox = Sandbox::new();
        LocalDaemon::discover(&sandbox.record(&value(port))).unwrap();
        worker.join().unwrap();
        let (_, at) = PROOF.lock().unwrap().proven.unwrap();
        assert!(
            at.elapsed() >= Duration::from_millis(300),
            "the proof was dated after the probe"
        );
    });
}
