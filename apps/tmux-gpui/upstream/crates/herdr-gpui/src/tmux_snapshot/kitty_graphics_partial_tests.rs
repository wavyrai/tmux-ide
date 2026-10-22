use super::*;
fn begin(store: &Store, digest: &str) -> Result<(), Error> {
    store.accept_line(format!("{{\"kittyImageChunk\":{{\"digest\":\"{digest}\",\"format\":\"png\",\"width\":1,\"height\":1,\"total\":{},\"offset\":0,\"data\":\"AA==\"}}}}",MAX_PARTIAL_BYTES/2).as_bytes())
}
#[test]
fn partial_reservations_are_bounded_and_restart_preserves_other_transfers() -> Result<(), Error> {
    let store = Store::default();
    let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let c = "cccccccccccccccccccccccccccccccc";
    begin(&store, a)?;
    begin(&store, b)?;
    begin(&store, a)?;
    assert!(store.lock().partials.contains_key(b));
    begin(&store, c)?;
    let inner = store.lock();
    assert_eq!(inner.partials.len(), 2);
    assert!(inner.partials.contains_key(a));
    assert!(inner.partials.contains_key(c));
    assert!(inner.partials.values().map(|p| p.total).sum::<usize>() <= MAX_PARTIAL_BYTES);
    assert!(
        inner
            .partials
            .values()
            .map(|p| p.data.capacity())
            .sum::<usize>()
            <= MAX_PARTIAL_BYTES
    );
    Ok(())
}
