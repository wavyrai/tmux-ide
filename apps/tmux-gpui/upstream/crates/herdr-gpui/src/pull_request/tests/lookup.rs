use super::*;

#[test]
fn worker_discards_stale_results_and_runs_only_requested_jobs() {
    let (requests, incoming) = mpsc::sync_channel(1);
    let (outgoing, results) = mpsc::sync_channel(1);
    let mut lookup = Lookup::default();
    lookup.worker = Some(Worker { requests, results });
    let input = Input {
        checkout: Some("/fixture".into()),
        repo_key: Some("/fixture/.git".into()),
        branch: "feature".into(),
    };
    lookup.request(input.clone(), Origin::Local, Arc::new("fixture".into()));
    lookup.poll();
    let (old, _, _, _) = incoming.try_recv().unwrap();
    lookup.clear();
    lookup.request(input, Origin::Local, Arc::new("fixture".into()));
    lookup.poll();
    assert!(incoming.try_recv().is_err(), "single in-flight request");
    outgoing
        .send((old, Ok(Some(fixture().unwrap())), None))
        .unwrap();
    lookup.poll();
    assert!(lookup.value.is_none());
    assert!(lookup.loading);
    let (current, _, _, _) = incoming.try_recv().unwrap();
    outgoing
        .send((current, Ok(Some(fixture().unwrap())), None))
        .unwrap();
    assert!(lookup.poll());
    assert!(!lookup.loading);
    assert_eq!(lookup.value.as_ref().unwrap().number, 8);
    assert!(!lookup.poll());
    assert!(incoming.try_recv().is_err(), "no automatic polling");
    lookup.clear();
    assert!(lookup.value.is_none());
}
