//! tmux-ide GPU regression: packed formats retain single-pixel color detail.
use super::*;
use objc2_core_foundation::{CFDictionary, CFType};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelFormatType_32BGRA,
};
fn packed(format: u32) -> CFRetained<CVPixelBuffer> {
    packed_pixels(format, expected)
}
fn packed_pixels(
    format: u32,
    pixels: impl Fn(usize, usize) -> [u8; 4],
) -> CFRetained<CVPixelBuffer> {
    let attributes = CFDictionary::from_slices(
        &[unsafe { kCVPixelBufferIOSurfacePropertiesKey }],
        &[&*CFDictionary::<CFType, CFType>::empty()],
    );
    let mut buffer = ptr::null_mut();
    assert_eq!(
        unsafe {
            CVPixelBufferCreate(
                None,
                16,
                16,
                format,
                Some(attributes.as_opaque()),
                ptr::NonNull::from(&mut buffer),
            )
        },
        kCVReturnSuccess
    );
    let buffer = unsafe { CFRetained::from_raw(ptr::NonNull::new(buffer).unwrap()) };
    unsafe {
        assert_eq!(
            CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::empty()),
            kCVReturnSuccess
        );
        let stride = CVPixelBufferGetBytesPerRow(&buffer);
        let bytes = slice::from_raw_parts_mut(
            CVPixelBufferGetBaseAddress(&buffer).cast::<u8>(),
            stride * 16,
        );
        for y in 0..16 {
            for x in 0..16 {
                let mut pixel = pixels(x, y);
                if format == kCVPixelFormatType_32BGRA {
                    pixel.swap(0, 2);
                }
                bytes[y * stride + x * 4..y * stride + x * 4 + 4].copy_from_slice(&pixel);
            }
        }
        assert_eq!(
            CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::empty()),
            kCVReturnSuccess
        );
    }
    buffer
}
fn expected(x: usize, y: usize) -> [u8; 4] {
    if (x + y) % 2 == 0 {
        [245, 16, 33, 255]
    } else {
        [12, 91, 239, 255]
    }
}
#[test]
fn packed_bgra_preserves_adjacent_pixel_colors() {
    let mut scene = Scene::default();
    for (index, format) in [kCVPixelFormatType_32BGRA, kCVPixelFormatType_32BGRA]
        .into_iter()
        .enumerate()
    {
        let bounds = Bounds {
            origin: point(ScaledPixels(index as f32 * 16.0), ScaledPixels(0.0)),
            size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
        };
        scene.insert_primitive(PaintSurface {
            order: 0,
            bounds,
            content_mask: ContentMask::new(bounds),
            image_buffer: packed(format),
        });
    }
    scene.finish();
    let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
    let image = renderer
        .render_scene_to_image(&scene, size(DevicePixels(32), DevicePixels(16)))
        .unwrap();
    for (x, y, pixel) in image.enumerate_pixels() {
        for (actual, wanted) in pixel
            .0
            .into_iter()
            .zip(expected(x as usize % 16, y as usize))
        {
            assert!(actual.abs_diff(wanted) <= 1, "pixel {x},{y}: {pixel:?}");
        }
    }
}

#[test]
fn submitted_surface_buffer_is_held_until_gpu_completion() {
    objc2::rc::autoreleasepool(|_| {
        let buffer = packed(kCVPixelFormatType_32BGRA);
        let owner = Arc::new(());
        let weak = Arc::downgrade(&owner);
        crate::surface_owner::retain_surface_owner(&buffer, owner).unwrap();
        assert!(crate::surface_owner::retain_surface_owner(&buffer, Arc::new(())).is_err());
        let bounds = Bounds {
            origin: Point::default(),
            size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
        };
        let mut scene = Scene::default();
        scene.insert_primitive(PaintSurface {
            order: 0,
            bounds,
            content_mask: ContentMask::new(bounds),
            image_buffer: buffer.clone(),
        });
        scene.finish();
        let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
        let descriptor = metal::TextureDescriptor::new();
        descriptor.set_width(16);
        descriptor.set_height(16);
        descriptor.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
        descriptor.set_usage(metal::MTLTextureUsage::RenderTarget);
        descriptor.set_storage_mode(metal::MTLStorageMode::Shared);
        let texture = renderer.device.new_texture(&descriptor);
        let command = renderer
            .render_frame(&scene, &texture, size(DevicePixels(16), DevicePixels(16)))
            .unwrap();
        drop(scene);
        renderer.core_video_texture_cache.flush(0);
        assert!(
            buffer.retain_count() >= 2,
            "submitted storage lost its owner before commit"
        );
        assert!(
            weak.upgrade().is_some(),
            "storage owner retired before GPU submission"
        );
        command.commit();
        command.wait_until_completed();
        renderer.core_video_texture_cache.flush(0);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while buffer.retain_count() > 1 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            buffer.retain_count(),
            1,
            "completion must release the submitted buffer owner"
        );
        assert!(
            weak.upgrade().is_some(),
            "remaining buffer still owns storage"
        );
        drop(buffer);
        assert!(
            weak.upgrade().is_none(),
            "final buffer release must retire storage"
        );
    });
}

fn nv12() -> CFRetained<CVPixelBuffer> {
    use objc2_core_video::{
        CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
    };
    let attributes = CFDictionary::from_slices(
        &[unsafe { kCVPixelBufferIOSurfacePropertiesKey }],
        &[&*CFDictionary::<CFType, CFType>::empty()],
    );
    let mut buffer = ptr::null_mut();
    assert_eq!(
        unsafe {
            CVPixelBufferCreate(
                None,
                16,
                16,
                kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                Some(attributes.as_opaque()),
                ptr::NonNull::from(&mut buffer),
            )
        },
        kCVReturnSuccess
    );
    let buffer = unsafe { CFRetained::from_raw(ptr::NonNull::new(buffer).unwrap()) };
    unsafe {
        assert_eq!(
            CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::empty()),
            kCVReturnSuccess
        );
        for plane in 0..2 {
            let length = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane)
                * CVPixelBufferGetHeightOfPlane(&buffer, plane);
            slice::from_raw_parts_mut(
                CVPixelBufferGetBaseAddressOfPlane(&buffer, plane).cast::<u8>(),
                length,
            )
            .fill(128);
        }
        assert_eq!(
            CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::empty()),
            kCVReturnSuccess
        );
    }
    buffer
}
#[test]
fn mixed_packed_and_nv12_surfaces_select_their_own_pipeline() {
    let mut scene = Scene::default();
    for index in 0..4 {
        let bounds = Bounds {
            origin: point(ScaledPixels(index as f32 * 16.0), ScaledPixels(0.0)),
            size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
        };
        scene.insert_primitive(PaintSurface {
            order: index,
            bounds,
            content_mask: ContentMask::new(bounds),
            image_buffer: if index % 2 == 0 {
                packed(kCVPixelFormatType_32BGRA)
            } else {
                nv12()
            },
        });
    }
    scene.finish();
    let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
    let image = renderer
        .render_scene_to_image(&scene, size(DevicePixels(64), DevicePixels(16)))
        .unwrap();
    for (x, y, pixel) in image.enumerate_pixels() {
        let wanted = if x / 16 % 2 == 0 {
            expected(x as usize % 16, y as usize)
        } else {
            [128, 128, 128, 255]
        };
        for (actual, wanted) in pixel.0.into_iter().zip(wanted) {
            assert!(actual.abs_diff(wanted) <= 2, "pixel {x},{y}: {pixel:?}");
        }
    }
}

#[test]
fn packed_straight_alpha_blends_and_respects_content_mask() {
    let bounds = Bounds {
        origin: Point::default(),
        size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
    };
    let mut scene = Scene::default();
    // Opaque blue backdrop ensures that alpha-zero pixels do not overwrite RGB.
    scene.insert_primitive(PaintSurface {
        order: 0,
        bounds,
        content_mask: ContentMask::new(bounds),
        image_buffer: packed_pixels(kCVPixelFormatType_32BGRA, |_, _| [0, 0, 255, 255]),
    });
    scene.insert_primitive(PaintSurface {
        order: 1,
        bounds,
        content_mask: ContentMask::new(Bounds {
            origin: point(ScaledPixels(4.0), ScaledPixels(4.0)),
            size: size(ScaledPixels(8.0), ScaledPixels(8.0)),
        }),
        image_buffer: packed_pixels(kCVPixelFormatType_32BGRA, |x, _| {
            [255, 0, 0, if x < 8 { 128 } else { 0 }]
        }),
    });
    scene.finish();
    let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
    let image = renderer
        .render_scene_to_image(&scene, size(DevicePixels(16), DevicePixels(16)))
        .unwrap();
    for (x, y, pixel) in image.enumerate_pixels() {
        let wanted = if (4..8).contains(&x) && (4..12).contains(&y) {
            [128, 0, 127, 255]
        } else {
            [0, 0, 255, 255]
        };
        for (actual, wanted) in pixel.0.into_iter().zip(wanted) {
            assert!(actual.abs_diff(wanted) <= 1, "pixel {x},{y}: {pixel:?}");
        }
    }
}

#[test]
fn unsupported_surface_fails_without_poisoning_next_draw() {
    let bounds = Bounds {
        origin: Point::default(),
        size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
    };
    let mut scene = Scene::default();
    scene.insert_primitive(PaintSurface {
        order: 0,
        bounds,
        content_mask: ContentMask::new(bounds),
        image_buffer: packed(objc2_core_video::kCVPixelFormatType_32ARGB),
    });
    scene.finish();
    let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
    let result = renderer.render_scene_to_image(&scene, size(DevicePixels(16), DevicePixels(16)));
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("unsupported CoreVideo")
    );
    let mut scene = Scene::default();
    scene.insert_primitive(PaintSurface {
        order: 0,
        bounds,
        content_mask: ContentMask::new(bounds),
        image_buffer: packed(kCVPixelFormatType_32BGRA),
    });
    scene.finish();
    let image = renderer
        .render_scene_to_image(&scene, size(DevicePixels(16), DevicePixels(16)))
        .unwrap();
    assert_eq!(image.get_pixel(0, 0).0, expected(0, 0));
}

#[test]
fn mach_surface_import_validates_allocation_and_paints_without_copying() {
    use crate::surface_port::SurfacePort;
    use objc2_core_video::CVPixelBufferGetIOSurface;
    let original = packed(kCVPixelFormatType_32BGRA);
    let surface = CVPixelBufferGetIOSurface(Some(&original)).unwrap();
    let owner = Arc::new(());
    let weak = Arc::downgrade(&owner);
    let (mut inbox, sender) = crate::surface_inbox::Inbox::new().unwrap();
    let outgoing = SurfacePort::from_surface(&surface).unwrap();
    assert_eq!(
        sender.try_send(&outgoing, [9; 16], 1).unwrap(),
        crate::surface_inbox::SendStatus::Queued
    );
    drop(outgoing);
    let received = inbox.try_receive([9; 16], 1).unwrap().unwrap();
    drop(sender);
    drop(inbox);
    let imported = received
        .import(
            surface.width(),
            surface.height(),
            surface.bytes_per_row(),
            surface.alloc_size(),
            owner,
        )
        .unwrap();
    let imported_surface = CVPixelBufferGetIOSurface(Some(&imported)).unwrap();
    // IOSurface identity is only compared inside this process for the test; the
    // importer itself receives a Mach right and never looks up a numeric ID.
    assert_eq!(surface.id(), imported_surface.id());
    drop(original);
    let bounds = Bounds {
        origin: Point::default(),
        size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
    };
    let mut scene = Scene::default();
    scene.insert_primitive(PaintSurface {
        order: 0,
        bounds,
        content_mask: ContentMask::new(bounds),
        image_buffer: imported,
    });
    scene.finish();
    let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
    let image = renderer
        .render_scene_to_image(&scene, size(DevicePixels(16), DevicePixels(16)))
        .unwrap();
    assert_eq!(image.get_pixel(0, 0).0, expected(0, 0));
    assert_eq!(image.get_pixel(1, 0).0, expected(1, 0));
    assert!(weak.upgrade().is_some());
    drop(scene);
    renderer.core_video_texture_cache.flush(0);
    drop(renderer);
    assert!(weak.upgrade().is_none());
}
#[test]
fn mach_surface_import_rejects_wrong_storage_and_releases_owner() {
    use crate::surface_port::SurfacePort;
    use objc2_core_video::CVPixelBufferGetIOSurface;
    let original = packed(kCVPixelFormatType_32BGRA);
    let surface = CVPixelBufferGetIOSurface(Some(&original)).unwrap();
    for (width, height, stride, bytes) in [
        (17, 16, surface.bytes_per_row(), surface.alloc_size()),
        (16, 17, surface.bytes_per_row(), surface.alloc_size()),
        (16, 16, surface.bytes_per_row() + 64, surface.alloc_size()),
        (16, 16, surface.bytes_per_row(), surface.alloc_size() + 4096),
    ] {
        let owner = Arc::new(());
        let weak = Arc::downgrade(&owner);
        assert!(
            SurfacePort::from_surface(&surface)
                .unwrap()
                .import(width, height, stride, bytes, owner)
                .is_err()
        );
        assert!(weak.upgrade().is_none());
    }
    let planar = nv12();
    let surface = CVPixelBufferGetIOSurface(Some(&planar)).unwrap();
    assert!(
        SurfacePort::from_surface(&surface)
            .unwrap()
            .import(
                surface.width(),
                surface.height(),
                surface.bytes_per_row(),
                surface.alloc_size(),
                Arc::new(())
            )
            .is_err()
    );
}

// Cross-process fixture only. Endpoint distribution uses an owned child's stdin,
// not the application's (still unwired) authenticated control connection.
#[cfg(target_os = "macos")]
struct TestChild(std::process::Child);
#[cfg(target_os = "macos")]
impl Drop for TestChild {
    fn drop(&mut self) {
        // Only the exact helper spawned by this fixture is killed/reaped.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
#[ignore = "owned helper invoked only by native_surface_cross_process"]
#[cfg(target_os = "macos")]
fn native_surface_child() {
    assert_eq!(
        std::env::var("TMUX_IDE_SURFACE_TEST_CHILD").as_deref(),
        Ok("1"),
        "fixture requires its owned coordinator"
    );
    use std::io::BufRead;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut line = String::new();
    input.read_line(&mut line).unwrap();
    let (pid, slot) = line.trim().split_once(':').unwrap();
    let pid: u32 = pid.parse().unwrap();
    let slot: u8 = slot.parse().unwrap();
    line.clear();
    input.read_line(&mut line).unwrap();
    let words: Vec<u32> = line
        .trim()
        .split(',')
        .map(|word| word.parse().unwrap())
        .collect();
    let receiver =
        crate::surface_inbox::SenderIdentity::from_authenticated_token(words.try_into().unwrap())
            .unwrap();
    let token = crate::surface_inbox::SenderIdentity::current()
        .unwrap()
        .token();
    println!(
        "TMUX_SURFACE_SENDER={}",
        token.map(|word| word.to_string()).join(",")
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut sender =
        crate::surface_sender::Sender::new(pid, slot, receiver, [7; 16], deadline).unwrap();
    while !sender.poll(std::time::Instant::now()).unwrap() {
        std::thread::sleep(Duration::from_millis(5));
    }
    // Allocate and transfer pixels only after verifying the receiver's kernel identity.
    let buffer = packed(kCVPixelFormatType_32BGRA);
    let mut frames = crate::surface_frames::Frames::default();
    let descriptor = frames.stage(buffer, [7; 16], 1).unwrap();
    assert_eq!(
        frames.try_send(&mut sender, 1).unwrap(),
        crate::surface_inbox::SendStatus::Queued
    );
    assert!(frames.try_send(&mut sender, 1).is_err());
    assert_eq!(frames.retained_bytes(), descriptor.allocation_bytes);
    assert_eq!(frames.outstanding(), 1);
    // Keep producer storage immutable until the parent confirms GPU retirement.
    line.clear();
    input.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "retired");
    let recycled = frames.retire(1).unwrap();
    assert_eq!(frames.retained_bytes(), 0);
    assert!(frames.retire(1).is_err());
    drop(recycled);
}
#[test]
#[ignore = "owned coordinator invoked only by native_surface_cross_process"]
#[cfg(target_os = "macos")]
fn native_surface_cross_process_worker() {
    assert_eq!(
        std::env::var("TMUX_IDE_SURFACE_TEST_COORDINATOR").as_deref(),
        Ok("1"),
        "fixture requires its owned parent"
    );
    use std::io::Write;
    let registration = crate::surface_rendezvous::Registration::new().unwrap();
    println!("TMUX_SURFACE_REGISTRATION={}", registration.slot());
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "metal_renderer::packed_surface_tests::native_surface_child",
            "--ignored",
            "--nocapture",
        ])
        .env("TMUX_IDE_SURFACE_TEST_CHILD", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut child = TestChild(child);
    let mut input = child.0.stdin.take().unwrap();
    writeln!(input, "{}:{}", std::process::id(), registration.slot()).unwrap();
    writeln!(
        input,
        "{}",
        crate::surface_inbox::SenderIdentity::current()
            .unwrap()
            .token()
            .map(|word| word.to_string())
            .join(",")
    )
    .unwrap();
    let (sender, _producer_output) = fixture_sender(&mut child);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut receiver =
        crate::surface_receiver::Receiver::new(registration, sender, [7; 16], deadline).unwrap();
    while !receiver.poll(std::time::Instant::now()).unwrap() {
        assert!(child.0.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(5));
    }
    let received = loop {
        if let Some(received) = receiver.try_receive().unwrap() {
            // Private child stdout establishes the expected producer identity;
            // the kernel trailer must match before the right reaches import.
            assert!(received.sender == sender);
            // Production must bind this ticket to an authenticated control offer.
            assert_eq!(received.ticket, [7; 16]);
            assert_eq!(received.sequence, 1);
            break received.surface;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "child surface handoff timed out"
        );
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "surface helper exited before handoff"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    // Matching fixed fixture allocation, independent of the child port name.
    let probe = packed(kCVPixelFormatType_32BGRA);
    let layout = objc2_core_video::CVPixelBufferGetIOSurface(Some(&probe)).unwrap();
    let owner = Arc::new(());
    let retired = Arc::downgrade(&owner);
    let imported = received
        .import(
            layout.width(),
            layout.height(),
            layout.bytes_per_row(),
            layout.alloc_size(),
            owner,
        )
        .unwrap();
    let bounds = Bounds {
        origin: Point::default(),
        size: size(ScaledPixels(16.0), ScaledPixels(16.0)),
    };
    let mut scene = Scene::default();
    scene.insert_primitive(PaintSurface {
        order: 0,
        bounds,
        content_mask: ContentMask::new(bounds),
        image_buffer: imported,
    });
    scene.finish();
    let mut renderer = MetalRenderer::new_headless(Arc::new(Mutex::new(Default::default())));
    let image = renderer
        .render_scene_to_image(&scene, size(DevicePixels(16), DevicePixels(16)))
        .unwrap();
    for (x, y, pixel) in image.enumerate_pixels() {
        assert_eq!(pixel.0, expected(x as usize, y as usize));
    }
    assert!(retired.upgrade().is_some());
    assert!(
        child.0.try_wait().unwrap().is_none(),
        "producer must wait for retirement"
    );
    drop(scene);
    renderer.core_video_texture_cache.flush(0);
    drop(renderer);
    assert!(retired.upgrade().is_none());
    writeln!(input, "retired").unwrap();
    drop(input);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "surface helper retirement timed out"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(receiver);
}

#[test]
#[ignore = "opt-in: owned native surface processes and kernel rendezvous"]
#[cfg(target_os = "macos")]
fn native_surface_cross_process() {
    use std::io::Read;
    let parent_registration = crate::surface_rendezvous::Registration::new().unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "metal_renderer::packed_surface_tests::native_surface_cross_process_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("TMUX_IDE_SURFACE_TEST_COORDINATOR", "1")
        .env("RUST_BACKTRACE", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut child = TestChild(child);
    let output = child.0.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(16 * 1024).read_to_end(&mut bytes).unwrap();
        bytes
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.0.kill();
            let _ = child.0.wait();
            let _ = reader.join();
            panic!("surface coordinator timed out");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let bytes = reader.join().unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let names: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("TMUX_SURFACE_REGISTRATION="))
        .collect();
    assert_eq!(
        names.len(),
        1,
        "coordinator did not report its owned registration"
    );
    let slot: u8 = names[0].parse().unwrap();
    assert_eq!(
        slot,
        parent_registration.slot(),
        "fixture must exercise identical slots in distinct processes"
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if crate::surface_rendezvous::lookup_unverified(child.0.id(), slot)
            .unwrap()
            .is_none()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "process-scoped endpoint survived receiver exit"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(status.success(), "surface coordinator failed");
    assert!(
        crate::surface_rendezvous::lookup_unverified(
            std::process::id(),
            parent_registration.slot()
        )
        .unwrap()
        .is_some(),
        "receiver exit must not remove another process's same-slot registration"
    );
}

#[cfg(target_os = "macos")]
#[path = "surface_fixture_sender.rs"]
mod fixture_sender_reader;
#[cfg(target_os = "macos")]
use fixture_sender_reader::fixture_sender;

#[cfg(target_os = "macos")]
#[path = "surface_frames_tests.rs"]
mod producer_frames;
