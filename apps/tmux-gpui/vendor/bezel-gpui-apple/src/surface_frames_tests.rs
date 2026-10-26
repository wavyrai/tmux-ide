use super::*;
use crate::{
    surface_frames::Frames,
    surface_inbox::{SendStatus, SenderIdentity},
    surface_receiver::Receiver,
    surface_rendezvous::Registration,
    surface_sender::Sender,
};
fn registration() -> Registration {
    let mut attempt = Registration::begin().unwrap();
    loop {
        if let Some(registration) = attempt.poll().unwrap() {
            return registration;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn frames_bound_actual_storage_and_reject_replay_before_publication() {
    let mut frames = Frames::default();
    let descriptor = frames
        .stage(packed(kCVPixelFormatType_32BGRA), [1; 16], 1)
        .unwrap();
    assert!(
        frames
            .stage(packed(kCVPixelFormatType_32BGRA), [1; 16], 1)
            .is_err()
    );
    assert!(
        frames
            .stage(packed(kCVPixelFormatType_32BGRA), [0; 16], 2)
            .is_err()
    );
    for sequence in 2..=8 {
        frames
            .stage(
                packed(kCVPixelFormatType_32BGRA),
                [sequence as u8; 16],
                sequence,
            )
            .unwrap();
    }
    assert_eq!(frames.outstanding(), 8);
    assert_eq!(frames.retained_bytes(), 8 * descriptor.allocation_bytes);
    assert!(
        frames
            .stage(packed(kCVPixelFormatType_32BGRA), [9; 16], 9)
            .is_err()
    );
    assert!(frames.retire(10).is_err());
    drop(frames.retire(1).unwrap());
    frames
        .stage(packed(kCVPixelFormatType_32BGRA), [9; 16], 9)
        .unwrap();
    assert!(frames.retire(1).is_err());
    frames.close();
    assert_eq!(frames.retained_bytes(), 0);
    assert_eq!(frames.outstanding(), 0);
    assert!(
        frames
            .stage(packed(kCVPixelFormatType_32BGRA), [10; 16], 10)
            .is_err()
    );
}
#[test]
fn fallback_drops_unsent_buffers_but_keeps_transferred_storage_until_retirement() {
    let registration = registration();
    let peer = SenderIdentity::current().unwrap();
    let now = std::time::Instant::now();
    let deadline = now + Duration::from_secs(5);
    let mut sender = Sender::new(
        std::process::id(),
        registration.slot(),
        peer,
        [1; 16],
        deadline,
    )
    .unwrap();
    assert!(!sender.poll(now).unwrap());
    let mut receiver = Receiver::new(registration, peer, [1; 16], deadline).unwrap();
    assert!(receiver.poll(now).unwrap());
    assert!(sender.poll(now).unwrap());
    let mut frames = Frames::default();
    let first = packed(kCVPixelFormatType_32BGRA);
    let first_owner = Arc::new(());
    let first_weak = Arc::downgrade(&first_owner);
    crate::surface_owner::retain_surface_owner(&first, first_owner).unwrap();
    let descriptor = frames.stage(first, [1; 16], 1).unwrap();
    let second = packed(kCVPixelFormatType_32BGRA);
    let second_owner = Arc::new(());
    let second_weak = Arc::downgrade(&second_owner);
    crate::surface_owner::retain_surface_owner(&second, second_owner).unwrap();
    frames.stage(second, [2; 16], 2).unwrap();
    assert!(frames.try_send(&mut sender, 2).is_err());
    assert_eq!(frames.try_send(&mut sender, 1).unwrap(), SendStatus::Queued);
    assert_eq!(
        frames.try_send(&mut sender, 2).unwrap(),
        SendStatus::Backpressured
    );
    assert_eq!(frames.retained_bytes(), 2 * descriptor.allocation_bytes);
    assert!(frames.discard_unsent(1).is_err());
    frames.discard_unsent(2).unwrap();
    assert!(frames.discard_unsent(2).is_err());
    frames.stage(packed(kCVPixelFormatType_32BGRA), [3; 16], 3).unwrap();
    assert_eq!(frames.retained_bytes(), 2 * descriptor.allocation_bytes);
    frames.fallback();
    assert_eq!(frames.retained_bytes(), descriptor.allocation_bytes);
    assert!(second_weak.upgrade().is_none());
    assert!(first_weak.upgrade().is_some());
    assert!(frames.try_send(&mut sender, 2).is_err());
    let delivered = receiver.try_receive().unwrap().unwrap();
    assert_eq!(delivered.sequence, 1);
    drop(delivered);
    let recycled = frames.retire(1).unwrap();
    assert!(first_weak.upgrade().is_some());
    drop(recycled);
    assert!(first_weak.upgrade().is_none());
    assert_eq!(frames.retained_bytes(), 0);
}
