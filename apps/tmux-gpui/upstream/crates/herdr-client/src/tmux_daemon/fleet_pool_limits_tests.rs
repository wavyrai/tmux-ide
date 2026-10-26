#![allow(clippy::unwrap_used)]
use super::*;
fn source() -> CatalogSource {
    // Guaranteed absent owned fixture path; no discovery ever falls back to HOME.
    CatalogSource::Local(
        std::env::temp_dir().join(format!("absent-fleet-{}", uuid::Uuid::new_v4())),
    )
}
#[test]
fn connection_work_and_refresh_queue_are_bounded() {
    let mut pool = FleetCatalogPool::default();
    for n in 0..MAX_ROUTES {
        pool.insert(n.to_string(), source()).unwrap();
    }
    assert!(matches!(
        pool.insert("overflow".into(), source()),
        Err(FleetPoolError::Route)
    ));
    assert!(matches!(
        pool.insert("0".into(), source()),
        Err(FleetPoolError::Route)
    ));
    pool.poll().unwrap();
    assert_eq!(
        pool.entries
            .values()
            .filter(|entry| entry.worker.is_some())
            .count(),
        MAX_ACTIVE
    );
    for _ in 0..100 {
        for n in 0..MAX_ROUTES {
            pool.refresh(&n.to_string()).unwrap();
        }
    }
    assert_eq!(pool.queue.len(), MAX_ROUTES);
    pool.shutdown().unwrap();
    assert!(!pool.busy());
    assert!(pool.entries.is_empty());
    assert!(pool.queue.is_empty());
}

#[cfg(unix)]
#[test]
fn observation_borrows_the_same_remote_owner_and_retirement_stops_it() {
    use std::sync::{Arc, atomic::AtomicBool};
    let mut pool = FleetCatalogPool::default();
    let original = CatalogSource::remote(
        crate::tmux_ssh::SshTarget::parse("fixture.invalid").unwrap(),
        None,
    );
    let epoch = pool.insert("remote".into(), original.clone()).unwrap();
    let identity = CatalogIdentity {
        instance_id: uuid::Uuid::new_v4().to_string(),
        environment_id: None,
    };
    assert!(
        pool.observation_source("remote", epoch, &identity)
            .is_none()
    );
    // Model only the successfully accepted catalog; no network work is started.
    pool.entries.get_mut("remote").unwrap().catalog_identity = Some(identity.clone());
    let borrowed = pool.observation_source("remote", epoch, &identity).unwrap();
    let (CatalogSource::Remote(a), CatalogSource::Remote(b)) = (&original, &borrowed) else {
        panic!("remote sources expected")
    };
    assert!(Arc::ptr_eq(a, b));
    assert!(
        pool.observation_source("remote", uuid::Uuid::new_v4(), &identity)
            .is_none()
    );
    pool.remove("remote").unwrap();
    assert!(
        pool.observation_source("remote", epoch, &identity)
            .is_none()
    );
    // A retained borrow cannot reopen an SSH process after the owner retires it.
    assert!(matches!(
        borrowed.discover(&Arc::new(AtomicBool::new(false))),
        Err(Error::Retired)
    ));
}
