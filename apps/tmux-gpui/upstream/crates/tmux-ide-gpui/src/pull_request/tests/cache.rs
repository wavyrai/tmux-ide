use super::*;
use crate::pull_request::cache::{CACHE_LIMIT, ERROR_BACKOFF, REFRESH};

fn input(branch: &str) -> Input {
    Input {
        checkout: None,
        repo_key: Some("/repo/.git".into()),
        branch: branch.into(),
    }
}

struct Peer {
    cache: Cache,
    incoming: mpsc::Receiver<(u64, Input, Origin, Arc<secrecy::SecretString>)>,
    outgoing: mpsc::SyncSender<(u64, Result, Option<Duration>)>,
}

impl Peer {
    fn new() -> Self {
        let (requests, incoming) = mpsc::sync_channel(1);
        let (outgoing, results) = mpsc::sync_channel(1);
        let mut cache = Cache::default();
        cache.lookup.worker = Some(Worker { requests, results });
        cache.scope(
            (0, 1, "boot".into()),
            Arc::new("fixture".into()),
            Origin::Local,
        );
        Self {
            cache,
            incoming,
            outgoing,
        }
    }

    fn complete(&mut self, now: Instant, result: Result, cooldown: Option<Duration>) -> Input {
        let (generation, input, _, _) = self.incoming.try_recv().unwrap();
        self.outgoing.send((generation, result, cooldown)).unwrap();
        self.cache.poll(now);
        input
    }
}

#[test]
fn explicit_refresh_keeps_cached_details_and_coalesces_in_flight_requests() {
    let mut peer = Peer::new();
    let now = Instant::now();
    let input = input("feature");
    peer.cache.seed(input.clone(), fixture().unwrap(), now);
    peer.cache.refresh(input.clone(), now);
    peer.cache.refresh(input.clone(), now);
    assert_eq!(peer.cache.queue.len(), 1);
    assert!(!peer.cache.scan_due(now));
    assert!(peer.incoming.try_recv().is_err(), "input only queues work");
    peer.cache.poll(now);
    assert_eq!(
        peer.cache
            .peek(input.repo_key.as_deref().unwrap(), &input.branch)
            .unwrap()
            .number,
        8
    );
    peer.cache.refresh(input.clone(), now);
    assert!(peer.cache.queue.is_empty(), "reuse the in-flight lookup");
    let mut updated = fixture().unwrap();
    updated.is_draft = true;
    updated.checks_summary = "2 pending".into();
    peer.complete(now, Ok(Some(updated)), None);
    let pr = peer
        .cache
        .peek(input.repo_key.as_deref().unwrap(), &input.branch)
        .unwrap();
    assert!(pr.is_draft);
    assert_eq!(pr.checks_summary, "2 pending");
    assert!(peer.incoming.try_recv().is_err());
}

#[test]
fn explicit_refresh_respects_account_backoff_and_bounds_the_queue() {
    let mut peer = Peer::new();
    let now = Instant::now();
    let input = input("feature");
    peer.cache.seed(input.clone(), fixture().unwrap(), now);
    peer.cache.paused_until = Some(now + ERROR_BACKOFF);
    peer.cache
        .schedule((0..CACHE_LIMIT).map(|i| self::input(&i.to_string())), now);
    peer.cache.refresh(input.clone(), now);
    assert_eq!(peer.cache.queue.len(), CACHE_LIMIT);
    assert_eq!(peer.cache.queue.front(), Some(&input));
    peer.cache.poll(now);
    assert!(peer.incoming.try_recv().is_err());
    peer.cache.poll(now + ERROR_BACKOFF);
    assert_eq!(peer.complete(now + ERROR_BACKOFF, Ok(None), None), input);
    assert!(
        peer.cache
            .peek(input.repo_key.as_deref().unwrap(), &input.branch)
            .is_none()
    );
}

#[test]
fn loading_covers_queued_and_in_flight_lookups_but_not_a_paused_account() {
    let mut peer = Peer::new();
    let now = Instant::now();
    let input = input("feature");
    assert!(!peer.cache.loading(&input, now));
    peer.cache.refresh(input.clone(), now);
    assert!(peer.cache.loading(&input, now), "queued for dispatch");
    peer.cache.paused_until = Some(now + ERROR_BACKOFF);
    assert!(!peer.cache.loading(&input, now), "a paused account waits");
    peer.cache.paused_until = None;
    peer.cache.poll(now);
    assert!(peer.cache.loading(&input, now), "in flight");
    assert!(!peer.cache.loading(&self::input("other"), now));
    peer.complete(now, Ok(Some(fixture().unwrap())), None);
    assert!(!peer.cache.loading(&input, now));
}

#[test]
fn cache_prefetches_without_menu_and_refreshes_at_ttl_with_stale_data() {
    let mut peer = Peer::new();
    let now = Instant::now();
    let input = input("feature");
    peer.cache.schedule([input.clone(), input.clone()], now);
    assert_eq!(peer.cache.queue.len(), 1);
    peer.cache.poll(now);
    assert_eq!(
        peer.complete(now, Ok(Some(fixture().unwrap())), None),
        input
    );
    let mut view = Lookup::default();
    peer.cache.present(&input, &mut view, now);
    assert_eq!(view.value.as_ref().unwrap().number, 8);
    assert!(!view.loading);
    assert!(peer.incoming.try_recv().is_err(), "menu read is I/O free");
    peer.cache
        .schedule([input.clone()], now + REFRESH - Duration::from_secs(1));
    peer.cache.poll(now + REFRESH - Duration::from_secs(1));
    assert!(peer.incoming.try_recv().is_err());
    let due = now + REFRESH;
    peer.cache.schedule([input.clone()], due);
    peer.cache.poll(due);
    peer.cache.present(&input, &mut view, due);
    assert!(
        view.value.is_some(),
        "refresh does not replace cached data with loading"
    );
    peer.complete(
        due,
        Err(std::io::Error::other("network unavailable").into()),
        None,
    );
    peer.cache.present(&input, &mut view, due);
    assert!(view.value.is_some());
    assert!(view.message.is_some());
    peer.cache.schedule(
        [input.clone()],
        due + ERROR_BACKOFF - Duration::from_secs(1),
    );
    assert!(peer.cache.queue.is_empty());
    peer.cache.schedule([input.clone()], due + ERROR_BACKOFF);
    peer.cache.poll(due + ERROR_BACKOFF);
    peer.complete(due + ERROR_BACKOFF, Ok(None), None);
    peer.cache.present(&input, &mut view, due + ERROR_BACKOFF);
    assert!(view.value.is_none() && view.message.is_none() && !view.loading);
    peer.cache.schedule([input], due + ERROR_BACKOFF);
    assert!(
        peer.cache.queue.is_empty(),
        "negative results also have a TTL"
    );
}

#[test]
fn cache_fences_auth_scope_removed_branch_and_late_results() {
    let now = Instant::now();
    for change in 0..7 {
        let mut peer = Peer::new();
        peer.cache.seed(input("cached"), fixture().unwrap(), now);
        peer.cache.schedule([input("old")], now);
        peer.cache.poll(now);
        let (generation, _, _, _) = peer.incoming.try_recv().unwrap();
        let token = peer.cache.token.as_ref().unwrap().clone();
        match change {
            0 => peer.cache.clear(), // sign-out/disconnect
            1 => peer.cache.scope(
                (0, 1, "boot".into()),
                Arc::new("other-account".into()),
                Origin::Local,
            ),
            2 => peer
                .cache
                .scope((1, 1, "boot".into()), token, Origin::Local),
            3 => peer
                .cache
                .scope((0, 2, "boot".into()), token, Origin::Local),
            4 => peer
                .cache
                .scope((0, 1, "new-boot".into()), token, Origin::Local),
            5 => peer
                .cache
                .scope((0, 1, "boot".into()), token, Origin::Ssh("host".into())),
            _ => peer.cache.retain(|input| input.branch == "new"),
        }
        assert!(peer.cache.entries.is_empty());
        assert!(peer.cache.queue.is_empty());
        peer.outgoing
            .send((generation, Ok(Some(fixture().unwrap())), None))
            .unwrap();
        peer.cache.poll(now);
        assert!(
            peer.cache.entries.is_empty(),
            "late result restored sensitive data: {change}"
        );
        assert!(peer.incoming.try_recv().is_err());
    }
}

#[test]
fn signout_drains_private_results_without_starting_queued_work() {
    let mut peer = Peer::new();
    let now = Instant::now();
    peer.cache.schedule([input("active"), input("queued")], now);
    peer.cache.poll(now);
    let (generation, _, _, _) = peer.incoming.try_recv().unwrap();
    peer.outgoing
        .send((generation, Ok(Some(fixture().unwrap())), None))
        .unwrap();
    peer.cache.clear();
    assert!(!peer.cache.lookup.busy);
    assert!(
        peer.cache
            .lookup
            .worker
            .as_ref()
            .unwrap()
            .results
            .try_recv()
            .is_err()
    );
    assert!(peer.incoming.try_recv().is_err());
    assert!(peer.cache.token.is_none());
}

#[test]
fn cache_is_bounded_lru_and_does_not_refetch_fresh_entries_under_pressure() {
    let mut peer = Peer::new();
    let now = Instant::now();
    peer.cache
        .schedule((0..CACHE_LIMIT * 2).map(|i| input(&i.to_string())), now);
    assert_eq!(peer.cache.queue.len(), CACHE_LIMIT);
    peer.cache.poll(now);
    for _ in 0..CACHE_LIMIT {
        peer.complete(now, Ok(None), None);
    }
    assert_eq!(peer.cache.entries.len(), CACHE_LIMIT);
    assert!(peer.incoming.try_recv().is_err());
    peer.cache.schedule([input("overflow")], now);
    peer.cache.poll(now);
    assert!(
        peer.incoming.try_recv().is_err(),
        "do not evict fresh data to hammer GitHub"
    );
    let mut view = Lookup::default();
    peer.cache
        .present(&input("0"), &mut view, now + Duration::from_secs(1));
    peer.cache.schedule([input("overflow")], now + REFRESH);
    peer.cache.poll(now + REFRESH);
    peer.complete(now + REFRESH, Ok(None), None);
    assert_eq!(peer.cache.entries.len(), CACHE_LIMIT);
    assert!(peer.cache.entries.iter().any(|e| e.input.branch == "0"));
    assert!(!peer.cache.entries.iter().any(|e| e.input.branch == "1"));
    assert!(
        peer.cache
            .entries
            .iter()
            .any(|e| e.input.branch == "overflow")
    );
}

#[test]
fn local_failures_do_not_starve_other_repos_but_rate_limits_pause_account() {
    let mut peer = Peer::new();
    let now = Instant::now();
    peer.cache.schedule(
        [input("local-error"), input("limited"), input("waiting")],
        now,
    );
    peer.cache.poll(now);
    assert_eq!(
        peer.complete(now, Err(Error::PrOrigin), None).branch,
        "local-error"
    );
    assert_eq!(
        peer.complete(
            now,
            Err(Error::GitHubRateLimit),
            Some(Duration::from_secs(3600))
        )
        .branch,
        "limited"
    );
    peer.cache.poll(now + Duration::from_secs(3599));
    assert!(peer.incoming.try_recv().is_err());
    let mut view = Lookup::default();
    peer.cache.present(&input("waiting"), &mut view, now);
    assert!(view.message.as_deref().unwrap().contains("paused"));
    peer.cache.poll(now + Duration::from_secs(3600));
    assert_eq!(
        peer.complete(now + Duration::from_secs(3600), Ok(None), None)
            .branch,
        "waiting"
    );
}
