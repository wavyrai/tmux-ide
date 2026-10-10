//! Embedded development icon; app bundles use their native Info.plist icon.
//! The same artwork identifies the build in the About box on every platform.
pub(super) const PNG: &[u8] = if env!("HERDR_BUILD_WORKTREE").as_bytes()[0] == b'1' {
    include_bytes!("../../../assets/icons/herdr-worktree-1024.png")
} else {
    include_bytes!("../../../assets/icons/herdr-ui-icon-clean.png")
};

// AppKit selects a directly rendered representation for the Dock's size and
// backing scale, rather than downsampling the About box's single large PNG.
#[cfg(target_os = "macos")]
const ICNS: &[u8] = if env!("HERDR_BUILD_WORKTREE").as_bytes()[0] == b'1' {
    include_bytes!("../../../assets/icons/Herdr-worktree.icns")
} else {
    include_bytes!("../../../assets/icons/Herdr.icns")
};

#[cfg(target_os = "macos")]
pub fn install() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{NSBundle, NSData, NSProcessInfo, NSString};

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    NSProcessInfo::processInfo().setProcessName(&NSString::from_str("Herdr"));
    if NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("CFBundleIconFile"))
        .is_some()
    {
        return;
    }
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(ICNS)) else {
        tracing::error!("Unable to decode the embedded Herdr icon");
        return;
    };
    // SAFETY: GPUI has initialized AppKit, the main-thread marker gates access,
    // and the setter receives a live, non-null NSImage (never None).
    #[allow(unsafe_code)]
    unsafe {
        NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&image));
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install() {}

#[cfg(all(target_os = "macos", feature = "integration-test"))]
pub fn verify_native() -> anyhow::Result<()> {
    use anyhow::Context as _;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let mtm = MainThreadMarker::new().context("icon check must run on the main thread")?;
    let image = NSApplication::sharedApplication(mtm)
        .applicationIconImage()
        .context("NSApplication has no icon")?;
    let size = image.size();
    if !image.isValid() || size.width != 512. || size.height != 512. {
        anyhow::bail!("invalid native icon: {size:?}");
    }
    eprintln!("ICON native PASS: valid NSApplication image, 512x512 points");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::PNG;

    #[cfg(target_os = "macos")]
    #[test]
    #[allow(clippy::expect_used)]
    fn dock_icons_decode_with_all_standard_and_retina_representations() {
        use objc2::AnyThread;
        use objc2_app_kit::NSImage;
        use objc2_foundation::NSData;

        let stable = include_bytes!("../../../assets/icons/Herdr.icns").as_slice();
        let worktree = include_bytes!("../../../assets/icons/Herdr-worktree.icns").as_slice();
        assert_ne!(stable, worktree);
        assert_eq!(
            super::ICNS,
            if env!("HERDR_BUILD_WORKTREE") == "1" {
                worktree
            } else {
                stable
            }
        );
        for bytes in [stable, worktree] {
            let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))
                .expect("embedded ICNS must decode in AppKit");
            assert!(image.isValid());
            assert_eq!(image.size().width, 512.);
            assert_eq!(image.size().height, 512.);
            let representations = image.representations();
            assert_eq!(representations.len(), 10);
            for points in [16, 32, 128, 256, 512] {
                for scale in [1, 2] {
                    assert!(
                        representations.iter().any(|rep| {
                            rep.pixelsWide() == points * scale
                                && rep.pixelsHigh() == points * scale
                                && rep.size().width == points as f64
                                && rep.size().height == points as f64
                        }),
                        "missing {points}pt @{scale}x representation"
                    );
                }
            }
        }
    }

    #[test]
    fn embedded_icon_is_a_nonempty_1024_square_png() {
        let stable = include_bytes!("../../../assets/icons/herdr-ui-icon-clean.png").as_slice();
        let worktree = include_bytes!("../../../assets/icons/herdr-worktree-1024.png").as_slice();
        assert_ne!(stable, worktree);
        for png in [stable, worktree] {
            assert!(png.len() > 33);
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(&png[12..16], b"IHDR");
            assert_eq!(&png[16..20], &1024_u32.to_be_bytes());
            assert_eq!(&png[20..24], &1024_u32.to_be_bytes());
        }
        assert_eq!(
            PNG,
            if env!("HERDR_BUILD_WORKTREE") == "1" {
                worktree
            } else {
                stable
            }
        );
    }
}
