#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn dropping_publication_owner_fences_retained_paint_before_transport_close() {
    let (driver, inbox) = Driver::new(Uuid::from_u128(1));
    let (mut image, mut pool, window) = crate::tmux_native_surface::tests::fixture();
    driver.live.store(true, Ordering::Release);
    image.live = Arc::clone(&driver.live);
    image.publication = Arc::clone(&driver.publication);
    let paint = image.project(&window, 0).unwrap();
    drop(inbox);
    assert!(!paint.publication.load(Ordering::Acquire));
    assert!(image.project(&window, 0).is_none());
    drop(image);
    assert!(pool.next_retirement().is_none());
    drop(paint);
    assert_eq!(pool.next_retirement().unwrap().sequence, 1);
}
