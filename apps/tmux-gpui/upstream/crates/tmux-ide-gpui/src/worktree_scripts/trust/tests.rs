#![allow(clippy::unwrap_used)]

use super::*;

fn grant(endpoint: &str, digest: &str) -> Grant {
    Grant {
        endpoint: endpoint.into(),
        repo_key: "/r/.git".into(),
        digest: digest.into(),
    }
}

fn loaded(path: Option<PathBuf>) -> Trust {
    let mut trust = Trust::at(path);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while trust.loaded.is_some() {
        assert!(std::time::Instant::now() < deadline, "ledger never loaded");
        trust.poll();
        thread::yield_now();
    }
    trust
}

#[test]
fn trust_is_per_endpoint_repository_and_digest_and_survives_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE);
    let mut trust = loaded(Some(path.clone()));
    assert!(!trust.trusts(&grant("local", "a")));
    trust.grant(grant("local", "a"));
    assert!(trust.trusts(&grant("local", "a")));
    // Another host, or a changed file, is asked about again.
    assert!(!trust.trusts(&grant("ssh:box", "a")));
    assert!(!trust.trusts(&grant("local", "b")));
    drop(trust);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut reread = loaded(Some(path.clone()));
        if reread.trusts(&grant("local", "a")) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "grant never saved");
        thread::yield_now();
    }
}

#[test]
fn grants_are_bounded_and_deduplicated() {
    let mut trust = loaded(None);
    trust.grant(grant("local", "a"));
    trust.grant(grant("local", "a"));
    assert_eq!(trust.grants.len(), 1);
    for index in 0..LIMIT + 3 {
        trust.grant(grant("local", &index.to_string()));
    }
    assert_eq!(trust.grants.len(), LIMIT);
    assert!(!trust.trusts(&grant("local", "a")));
    assert!(trust.trusts(&grant("local", &(LIMIT + 2).to_string())));
}
