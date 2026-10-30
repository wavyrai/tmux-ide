use super::*;
use crate::protocol::{SurfaceGraphicsSource, SurfaceGraphicsTarget};

fn key(image_id: u32, format: SurfaceGraphicsFormat) -> SurfaceGraphicsAssetKey {
    let data_len = match format {
        SurfaceGraphicsFormat::Rgb => 2 * 2 * 3,
        SurfaceGraphicsFormat::Rgba => 2 * 2 * 4,
        SurfaceGraphicsFormat::Png => 8,
    };
    SurfaceGraphicsAssetKey {
        source: SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane {
                pane_id: "p1".into(),
            },
            image_id,
        },
        image_width: 2,
        image_height: 2,
        format,
        data_len,
        data_fingerprint: u64::from(image_id),
    }
}

fn asset(key: &SurfaceGraphicsAssetKey) -> SurfaceGraphicsAsset {
    SurfaceGraphicsAsset {
        key: key.clone(),
        data: vec![7; key.data_len as usize],
    }
}

#[test]
fn assets_must_match_their_key_exactly() {
    let rgba = key(1, SurfaceGraphicsFormat::Rgba);
    assert!(valid_asset(&rgba, &[0; 16]));
    assert!(!valid_asset(&rgba, &[0; 15]));
    assert!(!valid_asset(&rgba, &[]));
    let mut lying = rgba.clone();
    lying.data_len = 12;
    assert!(!valid_asset(&lying, &[0; 12]));
    let rgb = key(2, SurfaceGraphicsFormat::Rgb);
    assert!(valid_asset(&rgb, &[0; 12]));
    let png = key(3, SurfaceGraphicsFormat::Png);
    assert!(valid_asset(&png, &[0; 8]));
    let mut wide = png.clone();
    wide.image_width = MAX_IMAGE_SIDE + 1;
    assert!(!valid_asset(&wide, &[0; 8]));
    let mut empty = png;
    empty.image_height = 0;
    assert!(!valid_asset(&empty, &[0; 8]));
    // Overflowing pixel counts are rejected rather than wrapped.
    let mut huge = key(4, SurfaceGraphicsFormat::Rgba);
    huge.image_width = MAX_IMAGE_SIDE;
    huge.image_height = MAX_IMAGE_SIDE;
    assert!(!valid_asset(&huge, &[0; 16]));
}

#[test]
fn collected_images_keep_only_valid_assets() {
    let (a, b) = (
        key(1, SurfaceGraphicsFormat::Rgba),
        key(2, SurfaceGraphicsFormat::Rgb),
    );
    let mut bad = asset(&b);
    bad.data.push(0);
    let images: SurfaceImages = [asset(&a), bad].into_iter().collect();
    assert_eq!(images.len(), 1);
    assert!(images.get(&a).is_some());
}
