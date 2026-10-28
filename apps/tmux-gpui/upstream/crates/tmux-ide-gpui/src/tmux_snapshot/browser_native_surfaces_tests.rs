#![allow(clippy::unwrap_used)]
use super::*;
use crate::{terminal_painter::NativeFrame, tmux_native_surface::tests::fixture};
fn state(window: &PresentedWindow) -> State {
    State {
        frame: Some(DisplayFrame::Native(Arc::new(NativeFrame {
            rows: vec![],
            width: window.paint.cols as u16,
            height: window.paint.rows as u16,
            cursor: None,
        }))),
        ..Default::default()
    }
}
#[test]
fn scene_reuses_projection_and_rebinds_equal_but_new_display_frames() {
    let (image, _pool, window) = fixture();
    let mut state = state(&window);
    let mut scene = Scene::default();
    assert!(scene.apply_images(&mut state, &window, 0, vec![image]));
    let (source, paints) = state.native_surfaces.as_ref().unwrap();
    assert!(source.same(state.frame.as_ref().unwrap()));
    assert_eq!(paints.len(), 1);
    assert!(Arc::ptr_eq(paints[0].source(), &window.paint));
    assert!(!scene.apply_images(&mut state, &window, 0, vec![]));
    state.frame = self::state(&window).frame;
    assert!(scene.apply_images(&mut state, &window, 0, vec![]));
    assert!(
        state
            .native_surfaces
            .as_ref()
            .unwrap()
            .0
            .same(state.frame.as_ref().unwrap())
    );
}
#[test]
fn scene_suppresses_history_and_incoherent_previews_without_reimporting() {
    let (image, _pool, mut window) = fixture();
    let mut state = state(&window);
    let mut scene = Scene::default();
    scene.apply_images(&mut state, &window, 0, vec![image]);
    assert!(scene.apply_images(&mut state, &window, 1, vec![]));
    assert!(state.native_surfaces.as_ref().unwrap().1.is_empty());
    assert!(!scene.apply_images(&mut state, &window, 1, vec![]));
    window.coherent = false;
    scene.apply_images(&mut state, &window, 0, vec![]);
    assert!(state.native_surfaces.as_ref().unwrap().1.is_empty());
    window.coherent = true;
    scene.apply_images(&mut state, &window, 0, vec![]);
    assert_eq!(state.native_surfaces.as_ref().unwrap().1.len(), 1);
}
#[test]
fn replaced_commit_drops_scene_but_retains_storage_until_old_publication_drops() {
    let (image, mut pool, window) = fixture();
    let mut state = state(&window);
    let mut scene = Scene::default();
    scene.apply_images(&mut state, &window, 0, vec![image]);
    let old_publication = state.clone();
    let (_, _, replacement) = fixture();
    assert!(scene.apply_images(&mut state, &replacement, 0, vec![]));
    assert!(state.native_surfaces.is_none());
    assert!(pool.next_retirement().is_none());
    drop(old_publication);
    assert_eq!(pool.next_retirement().unwrap().sequence, 1);
    assert_eq!(pool.reserved_bytes(), 0);
}
