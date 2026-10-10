use super::*;
use crate::protocol::{
    FrameData, SurfaceGraphicsPlacement, SurfaceGraphicsSource, SurfaceGraphicsTarget,
};

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

fn placement(key: &SurfaceGraphicsAssetKey) -> SurfaceGraphicsPlacement {
    SurfaceGraphicsPlacement {
        asset: key.clone(),
        logical_placement_id: 1,
        x: 0,
        y: 0,
        cols: 2,
        rows: 1,
        source_x: 0,
        source_y: 0,
        source_width: 0,
        source_height: 0,
        x_offset: 0,
        y_offset: 0,
        z: 0,
        scrollback_offset: 0,
    }
}

fn surface(scene: SurfaceGraphicsScene) -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: FrameData {
            cells: vec![],
            width: 0,
            height: 0,
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: scene,
    }
}

fn placed(keys: &[&SurfaceGraphicsAssetKey], with_bytes: bool) -> PaneSurfaceFrame {
    surface(SurfaceGraphicsScene {
        assets: if with_bytes {
            keys.iter().map(|key| asset(key)).collect()
        } else {
            vec![]
        },
        placements: keys.iter().map(|key| placement(key)).collect(),
        retained_assets: vec![],
    })
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
fn bytes_outlive_the_surface_that_carried_them() {
    let mut store = ImageStore::default();
    let a = key(1, SurfaceGraphicsFormat::Rgba);
    let mut first = placed(&[&a], true);
    assert!(store.receive(&mut first));
    assert!(
        first.graphics.assets.is_empty(),
        "bytes move out of the surface"
    );
    let serial = store.published().get(&a).unwrap().serial();
    // Later surfaces only name the key.
    let mut next = placed(&[&a], false);
    assert!(!store.receive(&mut next));
    assert!(!store.show());
    assert_eq!(store.published().get(&a).unwrap().serial(), serial);
    // A resend of a key already held changes nothing.
    let mut resent = placed(&[&a], true);
    assert!(!store.receive(&mut resent));
    assert_eq!(store.published().get(&a).unwrap().serial(), serial);
}

#[test]
fn unreferenced_and_invalid_assets_are_dropped() {
    let mut store = ImageStore::default();
    let (a, b) = (
        key(1, SurfaceGraphicsFormat::Rgba),
        key(2, SurfaceGraphicsFormat::Rgba),
    );
    let mut frame = placed(&[&a], true);
    frame.graphics.assets.push(asset(&b));
    let mut bad = asset(&a);
    bad.data.pop();
    frame.graphics.assets.insert(0, bad);
    store.receive(&mut frame);
    let images = store.published();
    assert_eq!(images.len(), 1);
    assert_eq!(images.get(&a).unwrap().data().len(), 16);
    assert!(images.get(&b).is_none());
}

#[test]
fn retained_keys_keep_their_bytes_until_released() {
    let mut store = ImageStore::default();
    let a = key(1, SurfaceGraphicsFormat::Rgba);
    store.receive(&mut placed(&[&a], true));
    store.show();
    let mut offscreen = surface(SurfaceGraphicsScene {
        retained_assets: vec![a.clone()],
        ..Default::default()
    });
    assert!(!store.receive(&mut offscreen));
    assert!(!store.show());
    assert!(store.published().get(&a).is_some());
    assert!(!store.receive(&mut surface(SurfaceGraphicsScene::default())));
    assert!(store.show());
    assert!(store.published().is_empty());
    assert_eq!(store.bytes, 0);
}

#[test]
fn a_shown_surface_keeps_its_images_until_its_successor_is_shown() {
    let mut store = ImageStore::default();
    let (a, b) = (
        key(1, SurfaceGraphicsFormat::Rgba),
        key(2, SurfaceGraphicsFormat::Rgba),
    );
    store.receive(&mut placed(&[&a], true));
    store.show();
    // A surface waiting for its snapshot replaces `a` with `b`; whatever
    // is on screen still places `a`.
    assert!(store.receive(&mut placed(&[&b], true)));
    let images = store.published();
    assert!(images.get(&a).is_some() && images.get(&b).is_some());
    assert!(store.show());
    let images = store.published();
    assert!(images.get(&a).is_none() && images.get(&b).is_some());
}

#[test]
fn counts_and_bytes_are_bounded() {
    let mut store = ImageStore::default();
    let keys: Vec<_> = (0..MAX_IMAGES as u32 + 4)
        .map(|id| key(id, SurfaceGraphicsFormat::Rgba))
        .collect();
    let mut frame = placed(&keys.iter().collect::<Vec<_>>(), true);
    store.receive(&mut frame);
    assert_eq!(store.published().len(), MAX_IMAGES);

    // Charge the store as if it already held nearly its whole budget.
    let mut store = ImageStore {
        bytes: MAX_IMAGE_BYTES - 20,
        ..Default::default()
    };
    let (a, b) = (
        key(1, SurfaceGraphicsFormat::Rgba),
        key(2, SurfaceGraphicsFormat::Rgba),
    );
    store.receive(&mut placed(&[&a, &b], true));
    assert_eq!(store.published().len(), 1);
    assert_eq!(store.bytes, MAX_IMAGE_BYTES - 4);

    let a = key(1, SurfaceGraphicsFormat::Rgba);
    let mut frame = placed(&[&a], false);
    frame.graphics.placements = vec![placement(&a); MAX_PLACEMENTS + 1];
    store.receive(&mut frame);
    assert_eq!(frame.graphics.placements.len(), MAX_PLACEMENTS);
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

#[test]
fn serials_tell_deliveries_of_one_key_apart() {
    let a = key(1, SurfaceGraphicsFormat::Rgba);
    let mut first = ImageStore::default();
    first.receive(&mut placed(&[&a], true));
    let mut second = ImageStore::default();
    second.receive(&mut placed(&[&a], true));
    assert_ne!(
        first.published().get(&a).unwrap().serial(),
        second.published().get(&a).unwrap().serial()
    );
}
