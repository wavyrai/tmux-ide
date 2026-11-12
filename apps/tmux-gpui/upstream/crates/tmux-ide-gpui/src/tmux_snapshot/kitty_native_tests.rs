use super::*;
use herdr_client::tmux_graphics::{Blob, Format as NativeFormat, ImageChunk, ImageMetadata};
const DIGEST: &str = "00000000000000ff00000000000000ff";
fn chunk(offset: usize, bytes: Vec<u8>, verified: bool) -> ImageChunk {
    ImageChunk {
        metadata: ImageMetadata {
            blob: Blob {
                digest: DIGEST.into(),
                format: NativeFormat::Rgba,
                width: 2,
                height: 2,
                total: 16,
                offset,
            },
            image: "generation:pane:incarnation:1".into(),
        },
        bytes,
        complete_verified: verified,
    }
}
#[test]
fn native_final_chunk_requires_verification_before_image_is_visible() -> Result<(), Error> {
    let store = Store::default();
    store.accept_native(chunk(0, vec![7; 8], false))?;
    assert!(store.lock().keys.is_empty());
    assert!(store.accept_native(chunk(8, vec![7; 8], false)).is_err());
    assert!(store.lock().keys.is_empty());
    store.accept_native(chunk(8, vec![7; 8], true))?;
    assert!(store.lock().keys.contains_key(DIGEST));
    Ok(())
}
#[test]
fn native_invalidation_drops_partial_complete_and_pending_inflation() -> Result<(), Error> {
    let store = Store::default();
    store.accept_native(chunk(0, vec![7; 8], false))?;
    store.invalidate_native(&[DIGEST.into()]);
    assert!(store.lock().partials.is_empty());
    store.accept_native(chunk(0, vec![7; 16], true))?;
    store.invalidate_native(&[DIGEST.into()]);
    assert!(store.lock().keys.is_empty());
    // Model an inflater that already released its queue lock before invalidation.
    Store::insert_ready(
        &store.0,
        DIGEST.into(),
        Some("generation:pane:incarnation:1".into()),
        Ready {
            format: SurfaceGraphicsFormat::Rgba,
            width: 2,
            height: 2,
            data: vec![7; 16],
        },
    );
    assert!(store.lock().keys.is_empty());
    Ok(())
}
#[test]
fn native_retirement_drops_all_cached_images() -> Result<(), Error> {
    let store = Store::default();
    store.accept_native(chunk(0, vec![7; 16], true))?;
    store.retire_native();
    let inner = store.lock();
    assert!(inner.keys.is_empty());
    assert!(inner.arrivals.is_empty());
    assert_eq!(inner.bytes, 0);
    Ok(())
}

/// Counts the store's wakes of the window's idle UI task (#714).
fn counted(store: &Store) -> Arc<std::sync::atomic::AtomicUsize> {
    let wakes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = wakes.clone();
    store.on_change(move || {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    wakes
}

/// Chunks from the reader thread, invalidation and retirement each wake the
/// idle UI task: none of them comes with a publication.
#[test]
fn native_arrivals_invalidation_and_retirement_wake_the_ui_task() -> Result<(), Error> {
    use std::sync::atomic::Ordering::SeqCst;
    let store = Store::default();
    let wakes = counted(&store);
    store.accept_native(chunk(0, vec![7; 8], false))?;
    assert_eq!(wakes.load(SeqCst), 1, "a partial arrival");
    store.accept_native(chunk(8, vec![7; 8], true))?;
    assert_eq!(wakes.load(SeqCst), 2, "the final chunk");
    assert!(store.pending());
    store.invalidate_native(&[DIGEST.into()]);
    assert_eq!(wakes.load(SeqCst), 3, "invalidation");
    store.retire_native();
    assert_eq!(wakes.load(SeqCst), 4, "retirement");
    Ok(())
}
