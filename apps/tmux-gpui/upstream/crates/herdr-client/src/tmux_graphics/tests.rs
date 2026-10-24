#![allow(clippy::unwrap_used)]
mod viewport_revision;
use super::*;
use crate::{
    tmux_delivery::{Update, decode_compact},
    tmux_native_session::CommittedIdentity,
};
use serde_json::{Value, json, value::to_raw_value};
use std::sync::Arc;
const GENERATION: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
fn vectors() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("tests/vectors.json")).unwrap()["cases"]
        .as_array()
        .unwrap()
        .clone()
}
fn committed(vector: &Value) -> CommittedPane {
    let Update::Seed { snapshot, .. } =
        decode_compact(vector["wire"].as_str().unwrap().as_bytes()).unwrap()
    else {
        panic!("seed expected")
    };
    CommittedPane {
        snapshot: Some(Arc::new(snapshot)),
        identity: Arc::new(CommittedIdentity {
            generation: GENERATION.into(),
            incarnation: "pane:1".into(),
            delivery_nonce: "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c".into(),
            canonical_revision: 1,
            canonical_state_hash: "verified-by-terminal-store".into(),
        }),
    }
}
fn graphics() -> Graphics {
    Graphics::new(GENERATION.into(), vec!["pane".into(), "other".into()]).unwrap()
}
fn state(graphics: &mut Graphics, pane: &str, state: &Value, now: Instant) -> GraphicsUpdate {
    graphics
        .accept_control(
            &to_raw_value(&json!({"type":"terminal-graphics","pane":pane,"state":state})).unwrap(),
            now,
        )
        .unwrap()
}
fn blob(
    graphics: &mut Graphics,
    pane: &str,
    image: &Value,
    offset: usize,
    bytes: &[u8],
    now: Instant,
) -> Result<GraphicsUpdate, Error> {
    graphics.accept_control(&to_raw_value(&json!({"type":"terminal-graphics-blob","pane":pane,"blob":{
        "digest":image["digest"],"format":image["format"],"width":image["width"],"height":image["height"],"total":image["bytes"],"offset":offset},"data":STANDARD.encode(bytes)})).unwrap(),now)
}

#[test]
fn production_typescript_placeholder_vectors_match_and_preserve_rich_canonical_placements() {
    for vector in vectors() {
        let now = Instant::now();
        let mut graphics = graphics();
        let committed = committed(&vector);
        graphics.bind("pane", &committed).unwrap();
        state(&mut graphics, "pane", &vector["state"], now);
        let placements = graphics.placements("pane", &committed, now).unwrap();
        let actual = placements
            .placements
            .iter()
            .map(|p| serde_json::to_value(&p.placement).unwrap())
            .collect::<Vec<_>>();
        let expected = vector["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["placement"].clone())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "{}", vector["kind"]);
        assert_eq!(
            committed.snapshot.as_ref().unwrap().placements[0].kind,
            "widget"
        );
        assert!(
            graphics
                .placements("pane", &committed, now)
                .unwrap()
                .requests
                .is_empty()
        );
        if !placements.placements.is_empty() {
            assert_eq!(placements.requests.len(), 1);
        }
        assert!(graphics.takes_cell_pixels());
        assert!(graphics.takes_precise_cell_pixels());
    }
}

#[test]
fn image_bytes_decode_once_and_last_chunk_is_digest_guarded() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    graphics.bind("pane", &committed(vector)).unwrap();
    state(&mut graphics, "pane", &vector["state"], now);
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    let image = &vector["state"]["images"][0];
    let first = blob(&mut graphics, "pane", image, 0, &bytes[..32], now)
        .unwrap()
        .chunk
        .unwrap();
    assert!(!first.complete_verified);
    assert_eq!(first.bytes, &bytes[..32]);
    let final_chunk = blob(&mut graphics, "pane", image, 32, &bytes[32..], now)
        .unwrap()
        .chunk
        .unwrap();
    assert!(final_chunk.complete_verified);
    assert_eq!(first.metadata.image, final_chunk.metadata.image);
    let metadata = serde_json::to_value(final_chunk.metadata).unwrap();
    assert_eq!(metadata["offset"], 32);
    assert!(metadata.get("data").is_none());
    graphics.missing(&[image["digest"].as_str().unwrap().into()]);
    blob(&mut graphics, "pane", image, 0, &bytes[..32], now).unwrap();
    let mut corrupt = bytes[32..].to_vec();
    corrupt[0] ^= 1;
    assert!(matches!(
        blob(&mut graphics, "pane", image, 32, &corrupt, now),
        Err(Error::Digest)
    ));
    assert!(graphics.partials.is_empty());
    assert!(
        !graphics
            .held
            .contains_key(image["digest"].as_str().unwrap())
    );
}

#[test]
fn eviction_and_stall_retry_only_current_visible_digests() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    let committed = committed(vector);
    state(&mut graphics, "pane", &vector["state"], now);
    let first = graphics.placements("pane", &committed, now).unwrap();
    let digest = first.requests[0].digests[0].clone();
    assert!(
        graphics
            .placements("pane", &committed, now)
            .unwrap()
            .requests
            .is_empty()
    );
    assert_eq!(
        graphics.expire(now + Duration::from_secs(4)),
        vec![digest.clone()]
    );
    assert_eq!(
        graphics
            .placements("pane", &committed, now)
            .unwrap()
            .requests[0]
            .digests,
        vec![digest.clone()]
    );
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    blob(
        &mut graphics,
        "pane",
        &vector["state"]["images"][0],
        0,
        &bytes[..4],
        now,
    )
    .unwrap();
    assert!(graphics.expire(now + Duration::from_secs(4)).is_empty());
    assert_eq!(
        graphics.expire(now + Duration::from_secs(11)),
        vec![digest.clone()]
    );
    graphics.missing(std::slice::from_ref(&digest));
    assert_eq!(
        graphics
            .placements("pane", &committed, now)
            .unwrap()
            .requests[0]
            .digests,
        vec![digest]
    );
}

#[test]
fn redraw_requests_new_digest_and_stale_revision_cannot_restore_old_registry() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    let committed = committed(vector);
    state(&mut graphics, "pane", &vector["state"], now);
    let first = graphics.placements("pane", &committed, now).unwrap();
    let mut changed = vector["state"].clone();
    changed["revision"] = json!(2);
    changed["images"][0]["digest"] = json!("a".repeat(32));
    let update = state(&mut graphics, "pane", &changed, now);
    assert_eq!(update.requests[0].digests, vec!["a".repeat(32)]);
    assert!(!state(&mut graphics, "pane", &vector["state"], now).state_changed);
    let next = graphics.placements("pane", &committed, now).unwrap();
    assert_eq!(next.placements[0].image, first.placements[0].image);
    assert_eq!(next.placements[0].placement.digest, "a".repeat(32));
}

#[test]
fn generation_tombstone_and_lifetime_changes_cannot_reuse_images() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    let mut pane = committed(vector);
    state(&mut graphics, "pane", &vector["state"], now);
    let first = graphics.placements("pane", &pane, now).unwrap();
    assert!(!first.placements.is_empty());
    pane.snapshot = None;
    graphics.bind("pane", &pane).unwrap();
    state(&mut graphics, "pane", &vector["state"], now);
    assert!(
        graphics
            .placements("pane", &pane, now)
            .unwrap()
            .placements
            .is_empty()
    );
    let mut next = committed(vector);
    next.identity = Arc::new(CommittedIdentity {
        generation: GENERATION.into(),
        incarnation: "pane:2".into(),
        delivery_nonce: next.identity.delivery_nonce.clone(),
        canonical_revision: 2,
        canonical_state_hash: "new".into(),
    });
    assert!(matches!(graphics.bind("pane", &next), Err(Error::Lifetime)));
    assert!(matches!(
        graphics.placements("pane", &next, now),
        Err(Error::Retired)
    ));
    assert_ne!(
        stable_key(GENERATION, "pane", "pane:1", 5),
        stable_key(GENERATION, "pane", "pane:2", 5)
    );
    let mut graphics = Graphics::new(GENERATION.into(), vec!["pane".into()]).unwrap();
    next.identity = Arc::new(CommittedIdentity {
        generation: "stale".into(),
        incarnation: "pane:2".into(),
        delivery_nonce: next.identity.delivery_nonce.clone(),
        canonical_revision: 2,
        canonical_state_hash: "new".into(),
    });
    assert!(matches!(graphics.bind("pane", &next), Err(Error::Identity)));
}

#[test]
fn inconsistent_chunk_metadata_and_offsets_never_emit_final_bytes() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    graphics.bind("pane", &committed(vector)).unwrap();
    state(&mut graphics, "pane", &vector["state"], now);
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    let image = &vector["state"]["images"][0];
    blob(&mut graphics, "pane", image, 0, &bytes[..16], now).unwrap();
    assert!(matches!(
        blob(&mut graphics, "pane", image, 17, &bytes[16..], now),
        Err(Error::Metadata)
    ));
    assert!(matches!(
        blob(&mut graphics, "pane", image, 4, &bytes[16..32], now),
        Err(Error::Ordering)
    ));
    let mut wrong = image.clone();
    wrong["width"] = json!(2);
    assert!(matches!(
        blob(&mut graphics, "pane", &wrong, 0, &bytes, now),
        Err(Error::Metadata)
    ));
}

#[test]
fn concurrent_identical_digest_transfer_does_not_replace_the_partial_owner() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    let pane = committed(vector);
    for id in ["pane", "other"] {
        graphics.bind(id, &pane).unwrap();
        state(&mut graphics, id, &vector["state"], now);
    }
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    let image = &vector["state"]["images"][0];
    blob(&mut graphics, "pane", image, 0, &bytes[..32], now).unwrap();
    assert!(
        blob(&mut graphics, "other", image, 0, &bytes[..32], now)
            .unwrap()
            .chunk
            .is_none()
    );
    assert!(
        blob(&mut graphics, "other", image, 32, &bytes[32..], now)
            .unwrap()
            .chunk
            .is_none()
    );
    assert!(
        blob(&mut graphics, "pane", image, 32, &bytes[32..], now)
            .unwrap()
            .chunk
            .unwrap()
            .complete_verified
    );
}

#[test]
fn binary_requires_negotiation_and_preserves_digest_and_order_guards() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    graphics.bind("pane", &committed(vector)).unwrap();
    let image = &vector["state"]["images"][0];
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    let frame = |offset: usize, bytes: &[u8]| {
        let header = serde_json::to_vec(&json!({"pane":"pane","blob":{
            "digest":image["digest"],"format":image["format"],"width":image["width"],"height":image["height"],"total":image["bytes"],"offset":offset}})).unwrap();
        let mut frame = b"TGB1".to_vec();
        frame.extend((header.len() as u32).to_be_bytes());
        frame.extend(header);
        frame.extend(bytes);
        frame
    };
    state(&mut graphics, "pane", &vector["state"], now);
    assert!(matches!(
        graphics.accept_binary(&frame(0, &bytes), now),
        Err(Error::Identity)
    ));
    let mut enabled = vector["state"].clone();
    enabled["binaryBlobs"] = json!(true);
    enabled["revision"] = json!(2);
    state(&mut graphics, "pane", &enabled, now);
    let first = graphics
        .accept_binary(&frame(0, &bytes[..32]), now)
        .unwrap()
        .chunk
        .unwrap();
    assert_eq!(first.bytes, &bytes[..32]);
    assert!(!first.complete_verified);
    let last = graphics
        .accept_binary(&frame(32, &bytes[32..]), now)
        .unwrap()
        .chunk
        .unwrap();
    assert!(last.complete_verified);
    assert_eq!(first.metadata.image, last.metadata.image);
    graphics.missing(&[image["digest"].as_str().unwrap().into()]);
    let mut corrupt = bytes.clone();
    corrupt[0] ^= 1;
    assert!(matches!(
        graphics.accept_binary(&frame(0, &corrupt), now),
        Err(Error::Digest)
    ));
    assert!(graphics.partials.is_empty());
    assert!(
        graphics
            .accept_binary(&frame(32, &bytes[32..]), now)
            .is_err()
    );
}

#[test]
fn local_results_require_accepted_state_and_current_lifetime_and_registry() {
    use super::local::{LocalFrame, LocalImages, now_ms};
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    let mut proof = committed(vector);
    graphics.bind("pane", &proof).unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let root = LocalImages {
        root: format!("/private/fixture/local-images-{generation}"),
        generation: generation.clone(),
    };
    let image = &vector["state"]["images"][0];
    let digest = image["digest"].as_str().unwrap();
    let frame=LocalFrame::parse(&json!({"type":"terminal-graphics-local","pane":"pane","generation":generation,"leaseId":uuid::Uuid::new_v4().to_string(),"path":format!("{}/local-images-Ab123x/{digest}{}",root.root,"a".repeat(32)),"expiresAt":now_ms()+30_000,"blob":{"digest":digest,"format":image["format"],"width":image["width"],"height":image["height"],"total":image["bytes"],"offset":0}}).to_string(),&root).unwrap();
    state(&mut graphics, "pane", &vector["state"], now);
    assert!(matches!(
        graphics.local_job(frame.clone()),
        Err(Error::Identity)
    ));
    let mut enabled = vector["state"].clone();
    enabled["localFiles"] = json!(true);
    enabled["revision"] = json!(2);
    state(&mut graphics, "pane", &enabled, now);
    let job = graphics.local_job(frame.clone()).unwrap().unwrap();
    assert!(graphics.local_current(&job));
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    assert!(
        graphics
            .local_chunk(&job, 0, bytes[..32].to_vec(), now)
            .unwrap()
            .is_some()
    );
    let mut removed = enabled.clone();
    removed["images"] = json!([]);
    removed["placements"] = json!([]);
    removed["revision"] = json!(3);
    state(&mut graphics, "pane", &removed, now);
    assert!(!graphics.local_current(&job));
    assert!(
        graphics
            .local_chunk(&job, 32, bytes[32..].to_vec(), now)
            .unwrap()
            .is_none()
    );
    assert!(graphics.local_job(frame).unwrap().is_none());
    assert!(graphics.local_discard(&job));
    assert!(graphics.partials.is_empty());
    assert!(!graphics.local_discard(&job));
    proof.snapshot = None;
    graphics.bind("pane", &proof).unwrap();
    assert!(!graphics.local_current(&job));
}

#[test]
fn maintenance_deadline_tracks_requests_partials_completion_and_removal() {
    let vector = &vectors()[0];
    let now = Instant::now();
    let mut graphics = graphics();
    let proof = committed(vector);
    assert_eq!(graphics.next_expiry(), None);
    state(&mut graphics, "pane", &vector["state"], now);
    let request = graphics.placements("pane", &proof, now).unwrap();
    let digest = &request.requests[0].digests[0];
    assert_eq!(graphics.next_expiry(), Some(now + REQUEST_TIMEOUT));
    let image = &vector["state"]["images"][0];
    let bytes = STANDARD.decode(vector["bytes"].as_str().unwrap()).unwrap();
    blob(
        &mut graphics,
        "pane",
        image,
        0,
        &bytes[..32],
        now + Duration::from_secs(1),
    )
    .unwrap();
    // Progress does not rebuild a timer; its earlier alarm conservatively rechecks once.
    assert_eq!(graphics.next_expiry(), Some(now + REQUEST_TIMEOUT));
    assert!(graphics.expire(now + REQUEST_TIMEOUT).is_empty());
    assert_eq!(
        graphics.next_expiry(),
        Some(now + Duration::from_secs(1) + PARTIAL_TIMEOUT)
    );
    blob(
        &mut graphics,
        "pane",
        image,
        32,
        &bytes[32..],
        now + Duration::from_secs(4),
    )
    .unwrap();
    assert!(graphics.expire(now + Duration::from_secs(11)).is_empty());
    assert_eq!(graphics.next_expiry(), None);
    graphics.missing(std::slice::from_ref(digest));
    graphics
        .placements("pane", &proof, now + Duration::from_secs(12))
        .unwrap();
    assert_eq!(graphics.next_expiry(), Some(now + Duration::from_secs(15)));
    graphics.missing(std::slice::from_ref(digest));
    assert_eq!(graphics.next_expiry(), None);
    graphics
        .placements("pane", &proof, now + Duration::from_secs(16))
        .unwrap();
    graphics.retire();
    assert_eq!(graphics.next_expiry(), None);
}
