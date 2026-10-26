#![allow(clippy::unwrap_used)]
use super::*;
use gpui_apple::{surface_receiver::Receiver, surface_rendezvous::Registration};
#[test]
fn no_storage_transfer_before_acceptance_and_fallback_keeps_sent_backing() {
    let buffer = buffer();
    let identity = SenderIdentity::current().unwrap();
    let mut attempt = Registration::begin().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let registration = loop {
        if let Some(registration) = attempt.poll().unwrap() {
            break registration;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    };
    let sender = Sender::new(
        std::process::id(),
        registration.slot(),
        identity,
        [1; 16],
        deadline,
    )
    .unwrap();
    let mut peer = Peer {
        panes: vec!["pane.editor".into()],
        sender,
        frames: Frames::default(),
        pending: BTreeMap::new(),
        sent: BTreeSet::new(),
        sequence: 0,
        stopped: false,
        rejected: 0,
    };
    let mut receiver = Receiver::new(registration, identity, [1; 16], deadline).unwrap();
    while !peer.sender.ready() {
        assert!(Instant::now() < deadline);
        peer.poll(Instant::now()).unwrap();
        receiver.poll(Instant::now()).unwrap();
    }
    let d = peer.frames.stage(buffer.clone(), [1; 16], 1).unwrap();
    peer.pending.insert(1, false);
    peer.poll(Instant::now()).unwrap();
    assert!(receiver.try_receive().unwrap().is_none());
    peer.offered(1, false).unwrap();
    assert_eq!(peer.frames.outstanding(), 0);
    assert_eq!(peer.rejected, 1);
    peer.frames.stage(buffer, [2; 16], 2).unwrap();
    peer.pending.insert(2, false);
    peer.offered(2, true).unwrap();
    peer.poll(Instant::now()).unwrap();
    let delivered = receiver.try_receive().unwrap().unwrap();
    assert_eq!(delivered.sequence, 2);
    assert_eq!(peer.frames.retained_bytes(), d.allocation_bytes);
    peer.fallback();
    assert_eq!(peer.frames.retained_bytes(), d.allocation_bytes);
    peer.poll(Instant::now()).unwrap();
    peer.retired(2).unwrap();
    assert_eq!(peer.frames.outstanding(), 0);
    drop(delivered);
}

#[allow(unsafe_code)]
fn buffer() -> CFRetained<CVPixelBuffer> {
    use objc2_core_foundation::{CFDictionary, CFType};
    use objc2_core_video::{
        CVPixelBufferCreate, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelFormatType_32BGRA,
        kCVReturnSuccess,
    };
    let attributes = CFDictionary::from_slices(
        &[unsafe { kCVPixelBufferIOSurfacePropertiesKey }],
        &[&*CFDictionary::<CFType, CFType>::empty()],
    );
    let mut raw = std::ptr::null_mut();
    // Fresh owned CoreVideo allocation; no mutable pointer escapes this fixture.
    assert_eq!(
        unsafe {
            CVPixelBufferCreate(
                None,
                16,
                16,
                kCVPixelFormatType_32BGRA,
                Some(attributes.as_opaque()),
                std::ptr::NonNull::from(&mut raw),
            )
        },
        kCVReturnSuccess
    );
    unsafe { CFRetained::from_raw(std::ptr::NonNull::new(raw).unwrap()) }
}
