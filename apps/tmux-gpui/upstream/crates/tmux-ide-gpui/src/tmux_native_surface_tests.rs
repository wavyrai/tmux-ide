#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::{
    tmux_delivery::{Update, decode_compact},
    tmux_graphics::{surface_leases::Pool, surface_offer},
    tmux_native_session::CommittedIdentity,
    tmux_topology::{CopyRegion, Region},
};
use objc2_core_foundation::{CFDictionary, CFType};
use objc2_core_video::{
    CVPixelBufferCreate, CVPixelBufferGetIOSurface, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelFormatType_32BGRA, kCVReturnSuccess,
};
#[path = "tmux_native_surface_worker_tests.rs"]
mod worker;
#[allow(unsafe_code)] // Owned CoreVideo test allocation; no CPU pixel-pointer access.
pub(crate) fn fixture() -> (Image, Pool, PresentedWindow) {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../herdr-client/src/tmux_graphics/tests/vectors.json"
    ))
    .unwrap();
    let Update::Seed { snapshot, .. } =
        decode_compact(vectors["cases"][0]["wire"].as_str().unwrap().as_bytes()).unwrap()
    else {
        panic!("seed")
    };
    let attributes = CFDictionary::from_slices(
        &[unsafe { kCVPixelBufferIOSurfacePropertiesKey }],
        &[&*CFDictionary::<CFType, CFType>::empty()],
    );
    let mut raw = std::ptr::null_mut();
    // Test fixture owns one fresh buffer; no CPU pixel pointers or mutation.
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
    let buffer = unsafe { CFRetained::from_raw(std::ptr::NonNull::new(raw).unwrap()) };
    let surface = CVPixelBufferGetIOSurface(Some(&buffer)).unwrap();
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/native-surface-offers.json"
    ))
    .unwrap();
    let mut offer = vectors["cases"][0]["offer"].clone();
    offer["stride"] = serde_json::json!(surface.bytes_per_row());
    offer["allocationBytes"] = serde_json::json!(surface.alloc_size());
    let current = Arc::new(CommittedPane {
        snapshot: Some(Arc::new(snapshot)),
        identity: Arc::new(CommittedIdentity {
            generation: offer["generation"].as_str().unwrap().into(),
            incarnation: offer["incarnation"].as_str().unwrap().into(),
            delivery_nonce: offer["deliveryNonce"].as_str().unwrap().into(),
            canonical_revision: 7,
            canonical_state_hash: offer["canonicalStateHash"].as_str().unwrap().into(),
        }),
    });
    let mut pool = Pool::default();
    let accepted = surface_offer::accept(
        &serde_json::to_vec(&offer).unwrap(),
        "pane.native",
        &current,
        &mut pool,
    )
    .unwrap();
    let port = SurfacePort::from_surface(&surface).unwrap();
    let image = Image::import(accepted, port, "pane.native", &current).unwrap();
    let snapshot = current.snapshot.as_ref().unwrap();
    let window = PresentedWindow {
        coherent: true,
        paint: Arc::new(WindowPaint {
            window: "window.native".into(),
            selected_pane: "pane.native".into(),
            cols: snapshot.cols + 3,
            rows: snapshot.rows + 2,
            regions: vec![Region {
                pane: "pane.native".into(),
                left: 3,
                top: 1,
                width: snapshot.cols,
                height: snapshot.rows + 1,
                content_top: 2,
                content_rows: snapshot.rows,
                source: Arc::clone(&current),
            }],
            copy_region: CopyRegion {
                pane: "pane.native".into(),
                left: 3,
                top: 2,
                width: snapshot.cols,
                height: snapshot.rows,
                wrapped: vec![false; snapshot.rows],
            },
            cursor: snapshot.cursor.clone(),
            modes: snapshot.modes.clone(),
            mode_keys: None,
            zoomed: false,
        }),
    };
    (image, pool, window)
}
#[test]
fn imported_buffer_crosses_worker_boundary_and_retires_after_last_paint_owner() {
    let (image, mut pool, window) = std::thread::spawn(fixture).join().unwrap();
    let paint = image.project(&window, 0).unwrap();
    assert_eq!(
        paint.placement(),
        Placement {
            row: 2,
            column: 3,
            rows: 1,
            columns: 1
        }
    );
    assert!(Arc::ptr_eq(paint.source(), &window.paint));
    drop(image);
    assert!(pool.next_retirement().is_none());
    std::thread::spawn(move || drop(paint)).join().unwrap();
    assert_eq!(pool.next_retirement().unwrap().sequence, 1);
    assert_eq!(pool.reserved_bytes(), 0);
}
#[test]
fn projection_rejects_history_incoherence_and_equal_but_replaced_identity() {
    let (image, _pool, mut window) = fixture();
    assert!(image.project(&window, 1).is_none());
    window.coherent = false;
    assert!(image.project(&window, 0).is_none());
    let (_, _, replacement) = fixture();
    assert!(image.project(&replacement, 0).is_none());
    window.coherent = true;
    image.live.store(false, Ordering::Release);
    assert!(image.project(&window, 0).is_none());
}

#[test]
fn connection_joins_kernel_delivery_and_defers_ack_until_paint_release() {
    connection_retirement(false);
}
#[test]
fn disconnected_connection_suppresses_late_buffer_retirement() {
    connection_retirement(true);
}
fn connection_retirement(disconnect: bool) {
    use gpui_apple::{
        surface_inbox::{SendStatus, SenderIdentity},
        surface_rendezvous::Registration,
        surface_sender::Sender,
    };
    use std::time::{Duration, Instant};
    use uuid::Uuid;
    let (source, _source_pool, window) = fixture();
    let current = &window.paint.regions[0].source;
    let mut attempt = Registration::begin().unwrap();
    let mut connection = loop {
        if let Some(registration) = attempt.poll().unwrap() {
            break connection::Connection::new(
                Uuid::parse_str(&current.identity.generation).unwrap(),
                registration,
            )
            .unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let descriptor: serde_json::Value =
        serde_json::from_str(&connection.receiver_frame().unwrap()).unwrap();
    let peer = SenderIdentity::current().unwrap();
    let raw = serde_json::to_vec(&serde_json::json!({
        "type":"terminal-surface-peer", "version":1,
        "generation":descriptor["generation"], "connectionNonce":descriptor["connectionNonce"],
        "auditToken":peer.token(),
    }))
    .unwrap();
    connection.accept_peer(&raw).unwrap();
    connection.accept_peer(&raw).unwrap(); // Duplicate must not replace endpoints.
    let now = Instant::now();
    let mut sender = Sender::new(
        std::process::id(),
        descriptor["slot"].as_u64().unwrap() as u8,
        peer,
        *Uuid::parse_str(descriptor["challenge"].as_str().unwrap())
            .unwrap()
            .as_bytes(),
        now + Duration::from_secs(5),
    )
    .unwrap();
    assert!(!sender.poll(now).unwrap());
    assert!(connection.poll(now).unwrap().is_none());
    assert!(sender.poll(now).unwrap());
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/native-surface-offers.json"
    ))
    .unwrap();
    let mut offer = vectors["cases"][0]["offer"].clone();
    let surface = CVPixelBufferGetIOSurface(Some(&source.buffer.0)).unwrap();
    offer["stride"] = serde_json::json!(surface.bytes_per_row());
    offer["allocationBytes"] = serde_json::json!(surface.alloc_size());
    connection
        .admit(
            &serde_json::to_vec(&offer).unwrap(),
            "pane.native",
            current,
            now,
        )
        .unwrap();
    let port = SurfacePort::from_surface(&surface).unwrap();
    assert_eq!(
        sender
            .try_send(
                &port,
                *Uuid::parse_str(offer["storageTicket"].as_str().unwrap())
                    .unwrap()
                    .as_bytes(),
                1,
            )
            .unwrap(),
        SendStatus::Queued
    );
    let imported = connection
        .receive(now, |pane| {
            assert_eq!(pane, "pane.native");
            Some(Arc::clone(current))
        })
        .unwrap()
        .unwrap();
    let paint = imported.project(&window, 0).unwrap();
    drop(imported);
    assert!(connection.next_retirement().unwrap().is_none());
    // Fallback revokes native endpoints, but the original socket still retires
    // buffers that were successfully imported before falling back.
    connection
        .fallback(herdr_client::tmux_graphics::surface_control::FallbackReason::Storage)
        .unwrap();
    assert!(
        connection
            .receive(now, |_| panic!("no native read after fallback"))
            .unwrap()
            .is_none()
    );
    if disconnect {
        connection.close();
    }
    drop(paint);
    if !disconnect {
        let ack: serde_json::Value =
            serde_json::from_str(&connection.next_retirement().unwrap().unwrap()).unwrap();
        assert_eq!(
            ack,
            serde_json::json!({"type":"terminal-surface-retired","version":1,"sequence":1,"generation":descriptor["generation"],"connectionNonce":descriptor["connectionNonce"]})
        );
    }
    assert!(connection.next_retirement().unwrap().is_none());
    connection.close();
    assert!(connection.receiver_frame().is_err());
}

#[path = "tmux_native_surface_resize_tests.rs"]
mod resize;
