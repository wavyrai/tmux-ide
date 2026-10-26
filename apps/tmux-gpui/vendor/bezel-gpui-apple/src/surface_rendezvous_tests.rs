use super::*;
use crate::surface_inbox::SenderIdentity;
fn register() -> Registration {
    let mut attempt = Registration::begin().unwrap();
    loop {
        if let Some(registration) = attempt.poll().unwrap() {
            return registration;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
static REGISTRATIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn process_scoped_registration_supports_proof_and_revokes_its_receive_right() {
    let _guard = REGISTRATIONS.lock().unwrap();
    let mut registration = register();
    let endpoint = lookup_unverified(std::process::id(), registration.slot())
        .unwrap()
        .unwrap();
    let (mut reply, reply_endpoint) = Inbox::new().unwrap();
    let peer = SenderIdentity::current().unwrap();
    assert_eq!(
        endpoint.try_send_proof(&reply_endpoint, [1; 16]).unwrap(),
        SendStatus::Queued
    );
    let received = registration
        .inbox()
        .unwrap()
        .try_receive_endpoint(peer, [1; 16])
        .unwrap()
        .unwrap();
    let (_pixels, pixels_endpoint) = Inbox::new().unwrap();
    assert_eq!(
        received
            .try_send_endpoint(&pixels_endpoint, [1; 16])
            .unwrap(),
        SendStatus::Queued
    );
    assert!(reply.try_receive_endpoint(peer, [1; 16]).unwrap().is_some());
    drop(registration);
    assert!(endpoint.try_send_proof(&reply_endpoint, [2; 16]).is_err());
}

#[test]
fn rendezvous_rejects_unbounded_process_and_service_inputs() {
    assert!(lookup_unverified(0, 0).is_err());
    assert!(lookup_unverified(u32::MAX, 0).is_err());
    assert!(lookup_unverified(std::process::id(), 32).is_err());
}

#[test]
fn registration_capacity_and_replacement_preserve_revocation() {
    let _guard = REGISTRATIONS.lock().unwrap();
    let mut registrations: Vec<_> = (0..SLOTS).map(|_| register()).collect();
    assert!(Registration::new().is_err());
    let old = registrations.pop().unwrap();
    let slot = old.slot();
    let old_endpoint = lookup_unverified(std::process::id(), slot)
        .unwrap()
        .unwrap();
    drop(old);
    let mut replacement = register();
    assert_eq!(replacement.slot(), slot);
    let (_reply, endpoint) = Inbox::new().unwrap();
    assert!(old_endpoint.try_send_proof(&endpoint, [1; 16]).is_err());
    let new_endpoint = lookup_unverified(std::process::id(), slot)
        .unwrap()
        .unwrap();
    assert_eq!(
        new_endpoint.try_send_proof(&endpoint, [2; 16]).unwrap(),
        SendStatus::Queued
    );
    assert!(
        replacement
            .inbox()
            .unwrap()
            .try_receive_endpoint(SenderIdentity::current().unwrap(), [2; 16])
            .unwrap()
            .is_some()
    );
    drop(replacement);
    drop(registrations);
    assert_eq!(OCCUPIED.load(Ordering::Acquire), 0);
}

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "owned subprocess for rendezvous crash qualification"]
fn registration_crash_holder() {
    use std::io::Read;
    assert_eq!(
        std::env::var("TMUX_IDE_SURFACE_TEST_CRASH").as_deref(),
        Ok("owned")
    );
    let registration = register();
    assert_eq!(registration.slot(), 0);
    // Parent holds stdin open until it kills this exact child. Rust destructors
    // do not run: the test exercises kernel/process cleanup, not Drop.
    let mut input = Vec::new();
    std::io::stdin().take(1).read_to_end(&mut input).unwrap();
}

#[test]
fn killed_receiver_revokes_capabilities_without_touching_parent_registration() {
    let _guard = REGISTRATIONS.lock().unwrap();
    let parent = register();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "surface_rendezvous::tests::registration_crash_holder",
            "--ignored",
        ])
        .env("TMUX_IDE_SURFACE_TEST_CRASH", "owned")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut child = OwnedChild(child);
    let pid = child.0.id();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let stale = loop {
        if let Some(endpoint) = lookup_unverified(pid, 0).unwrap() {
            break endpoint;
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "owned receiver exited before registration"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "owned receiver failed to register"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let (_reply, endpoint) = Inbox::new().unwrap();
    assert!(stale.try_send_proof(&endpoint, [1; 16]).is_err());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while lookup_unverified(pid, 0).unwrap().is_some() {
        assert!(
            std::time::Instant::now() < deadline,
            "dead receiver remained discoverable"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(
        lookup_unverified(std::process::id(), parent.slot())
            .unwrap()
            .is_some()
    );
}
