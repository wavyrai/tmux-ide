//! App-owned main-window geometry. Disk work is serialized off the UI thread;
//! shutdown freezes the complete set before GPUI releases its window entities.
//!
//! On macOS GPUI reports window bounds relative to the window's own screen and
//! every display at origin (0, 0), so a position is only meaningful together
//! with its display. Each window records its display's persistent UUID and is
//! reopened on that display, falling back to the primary one when it is gone.
use crate::state_file;
use gpui::{App, Bounds, Context, DisplayId, Global, Pixels, Window, WindowId, point, px, size};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path};
use uuid::Uuid;

const MAX_WINDOWS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Geometry {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display: Option<Uuid>,
}

impl Geometry {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f32::is_finite)
            && self.width > 0.
            && self.height > 0.
    }

    fn bounds(self) -> Bounds<Pixels> {
        Bounds::new(
            point(px(self.x), px(self.y)),
            size(px(self.width), px(self.height)),
        )
    }

    fn from_window(window: &Window, cx: &App) -> Self {
        // In fullscreen GPUI supplies the normal restore rectangle.
        Self {
            display: window.display(cx).and_then(|display| display.uuid().ok()),
            ..Self::from_bounds(window.window_bounds().get_bounds())
        }
    }

    fn from_bounds(bounds: Bounds<Pixels>) -> Self {
        Self {
            x: bounds.origin.x.into(),
            y: bounds.origin.y.into(),
            width: bounds.size.width.into(),
            height: bounds.size.height.into(),
            display: None,
        }
    }
}

/// Index of the saved display among the connected ones, if it is still present.
fn saved_display(saved: Option<Uuid>, connected: &[Option<Uuid>]) -> Option<usize> {
    let saved = saved?;
    connected.iter().position(|uuid| *uuid == Some(saved))
}

/// Keeps a window on `display`, whose bounds share the window's coordinate
/// space: display-relative on macOS, global on other platforms.
fn fit(mut geometry: Geometry, display: Option<Bounds<Pixels>>) -> Geometry {
    geometry.width = geometry.width.max(640.);
    geometry.height = geometry.height.max(400.);
    if let Some(display) = display {
        let display = Geometry::from_bounds(display);
        geometry.width = geometry.width.min(display.width.max(640.));
        geometry.height = geometry.height.min(display.height.max(400.));
        geometry.x = geometry.x.clamp(
            display.x,
            display.x + (display.width - geometry.width).max(0.),
        );
        geometry.y = geometry.y.clamp(
            display.y,
            display.y + (display.height - geometry.height).max(0.),
        );
    }
    geometry
}

fn read(path: &Path) -> crate::Result<Vec<Geometry>> {
    let Some(bytes) = state_file::read(path, 64 * 1024)? else {
        return Ok(Vec::new());
    };
    let windows: Vec<Geometry> = serde_json::from_slice(&bytes)?;
    if windows.len() > MAX_WINDOWS || windows.iter().any(|geometry| !geometry.valid()) {
        return Err(crate::Error::InvalidWindowState);
    }
    Ok(windows)
}

#[cfg(test)]
fn write(path: &Path, windows: &[Geometry]) -> crate::Result<()> {
    state_file::write(path, windows)
}

type Writer = state_file::Writer<Vec<Geometry>>;

pub(crate) struct WindowState {
    restored: VecDeque<Geometry>,
    live: Vec<(WindowId, Geometry)>,
    writer: Option<Writer>,
    quitting: bool,
}

impl Global for WindowState {}

impl WindowState {
    /// Called before starting GPUI. Fixtures never call this or install the global.
    pub(crate) fn load() -> Self {
        let path = crate::preferences::state_dir().map(|dir| dir.join("window-state.json"));
        let restored = path
            .as_ref()
            .map_or_else(Vec::new, |path| match read(path) {
                Ok(windows) => windows,
                Err(error) => {
                    tracing::warn!(%error, "Cannot restore window state");
                    Vec::new()
                }
            });
        let writer = path.and_then(|path| match Writer::start("window-state", path) {
            Ok(writer) => Some(writer),
            Err(error) => {
                tracing::warn!(%error, "Cannot start window-state worker");
                None
            }
        });
        Self {
            restored: restored.into(),
            live: Vec::new(),
            writer,
            quitting: false,
        }
    }

    pub(crate) fn count(&self) -> usize {
        self.restored.len().max(1)
    }

    pub(crate) fn install(self, cx: &mut App) {
        cx.set_global(self);
        cx.on_app_quit(|cx| {
            let writer = cx.global_mut::<Self>().shutdown();
            cx.background_executor().spawn(async move {
                if let Some(writer) = writer {
                    writer.finish();
                }
            })
        })
        .detach();
    }

    fn shutdown(&mut self) -> Option<Writer> {
        self.quitting = true;
        self.writer.take()
    }

    /// Chooses the next main window's bounds and the display they refer to.
    pub(crate) fn placement(
        default: Bounds<Pixels>,
        cx: &mut App,
    ) -> (Bounds<Pixels>, Option<DisplayId>) {
        if !cx.has_global::<Self>() {
            return (default, None);
        }
        let state = cx.global_mut::<Self>();
        let geometry = state.restored.pop_front().unwrap_or_else(|| {
            if let Some((_, mut geometry)) = state.live.last().copied() {
                geometry.x += 28.;
                geometry.y += 28.;
                geometry
            } else {
                Geometry::from_bounds(default)
            }
        });
        let displays = cx.displays();
        let uuids: Vec<_> = displays.iter().map(|display| display.uuid().ok()).collect();
        // A missing display falls back to the primary one, where GPUI opens
        // windows without an explicit display.
        let display = saved_display(geometry.display, &uuids)
            .and_then(|index| displays.get(index).cloned())
            .or_else(|| cx.primary_display());
        let bounds = fit(geometry, display.as_ref().map(|display| display.bounds())).bounds();
        (bounds, display.map(|display| display.id()))
    }

    fn save(&self) {
        if let Some(writer) = &self.writer {
            writer.save(
                self.live
                    .iter()
                    .take(MAX_WINDOWS)
                    .map(|(_, geometry)| *geometry)
                    .collect(),
            );
        }
    }

    fn update(&mut self, id: WindowId, geometry: Geometry) {
        if self.quitting || !geometry.valid() {
            return;
        }
        if let Some((_, old)) = self.live.iter_mut().find(|(key, _)| *key == id) {
            if *old == geometry {
                return;
            }
            *old = geometry;
        } else {
            self.live.push((id, geometry));
        }
        self.save();
    }

    fn closed(&mut self, id: WindowId) {
        if self.quitting {
            return;
        }
        self.live.retain(|(key, _)| *key != id);
        // Closing the final window quits the app: retain its last saved layout.
        if !self.live.is_empty() {
            self.save();
        }
    }

    pub(crate) fn observe<T: 'static>(window: &mut Window, cx: &mut Context<T>) {
        let id = window.window_handle().window_id();
        if !cx.has_global::<Self>() {
            return;
        }
        let geometry = Geometry::from_window(window, cx);
        cx.global_mut::<Self>().update(id, geometry);
        cx.observe_window_bounds(window, move |_, window, cx| {
            let geometry = Geometry::from_window(window, cx);
            cx.global_mut::<Self>().update(id, geometry);
        })
        .detach();
        cx.on_release(move |_, cx| {
            cx.global_mut::<Self>().closed(id);
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::fs;

    fn geometry(x: f32) -> Geometry {
        Geometry {
            x,
            y: 50.,
            width: 900.,
            height: 700.,
            display: None,
        }
    }

    #[test]
    fn latest_complete_window_set_is_flushed_on_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.json");
        assert!(read(&path).unwrap().is_empty());
        let writer = Writer::start("window-state", path.clone()).unwrap();
        writer.save(vec![geometry(0.)]);
        let expected = vec![geometry(-1200.), geometry(300.)];
        writer.save(expected.clone());
        writer.finish();
        assert_eq!(read(&path).unwrap(), expected);
    }

    #[test]
    fn closing_one_window_removes_it_but_quitting_preserves_the_remaining_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.json");
        let mut state = WindowState {
            restored: VecDeque::new(),
            live: Vec::new(),
            writer: Some(Writer::start("window-state", path.clone()).unwrap()),
            quitting: false,
        };
        let ids = [WindowId::from(1), WindowId::from(2), WindowId::from(3)];
        state.update(ids[0], geometry(0.));
        state.update(ids[1], geometry(-1200.));
        state.update(ids[2], geometry(300.));
        state.closed(ids[0]);
        state.update(ids[1], geometry(-1100.));
        let writer = state.shutdown().unwrap();
        // GPUI releases windows after calling the quit observer.
        state.closed(ids[1]);
        state.closed(ids[2]);
        writer.finish();
        assert_eq!(read(&path).unwrap(), vec![geometry(-1100.), geometry(300.)]);
    }

    #[test]
    fn closing_the_final_window_keeps_its_geometry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.json");
        let mut state = WindowState {
            restored: VecDeque::new(),
            live: Vec::new(),
            writer: Some(Writer::start("window-state", path.clone()).unwrap()),
            quitting: false,
        };
        let id = WindowId::from(1);
        state.update(id, geometry(50.));
        state.closed(id);
        state.shutdown().unwrap().finish();
        assert_eq!(read(&path).unwrap(), vec![geometry(50.)]);
    }

    #[test]
    fn invalid_or_excessive_state_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.json");
        fs::write(&path, b"broken").unwrap();
        assert!(read(&path).is_err());
        let mut invalid = geometry(0.);
        invalid.width = -1.;
        write(&path, &[invalid]).unwrap();
        assert!(matches!(read(&path), Err(crate::Error::InvalidWindowState)));
        write(&path, &vec![geometry(0.); MAX_WINDOWS + 1]).unwrap();
        assert!(matches!(read(&path), Err(crate::Error::InvalidWindowState)));
        assert!(!geometry(f32::NAN).valid());
    }

    #[test]
    fn display_identity_round_trips_and_older_files_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.json");
        let on_external = Geometry {
            display: Some(Uuid::from_u128(7)),
            ..geometry(200.)
        };
        write(&path, &[on_external, geometry(0.)]).unwrap();
        assert_eq!(read(&path).unwrap(), vec![on_external, geometry(0.)]);
        fs::write(&path, br#"[{"x":1,"y":2,"width":900,"height":700}]"#).unwrap();
        assert_eq!(read(&path).unwrap()[0].display, None);
    }

    #[test]
    fn windows_return_to_their_saved_display_or_the_primary_one() {
        let (main, external) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let connected = [Some(main), None, Some(external)];
        assert_eq!(saved_display(Some(external), &connected), Some(2));
        assert_eq!(saved_display(Some(Uuid::from_u128(3)), &connected), None);
        assert_eq!(saved_display(None, &connected), None);
    }

    #[test]
    fn display_relative_positions_are_kept_on_screen() {
        // macOS reports every display at (0, 0) in window coordinates.
        let external = Bounds::new(point(px(0.), px(0.)), size(px(2560.), px(1440.)));
        let laptop = Bounds::new(point(px(0.), px(0.)), size(px(1512.), px(982.)));
        let saved = Geometry {
            width: 1400.,
            ..geometry(1000.)
        };
        assert_eq!(fit(saved, Some(external)), saved);
        // The external display is gone: shrink and pull onto the laptop.
        let fitted = fit(saved, Some(laptop));
        assert_eq!((fitted.x, fitted.width), (112., 1400.));
        let fitted = fit(geometry(-1200.), Some(laptop));
        assert_eq!((fitted.x, fitted.y), (0., 50.));
        let tall = Geometry {
            height: 1300.,
            ..geometry(0.)
        };
        assert_eq!(fit(tall, Some(laptop)).height, 982.);
    }

    #[test]
    fn global_monitor_coordinates_are_kept_on_their_display() {
        // Other platforms report displays in one global space.
        let left = Bounds::new(point(px(-1600.), px(0.)), size(px(1600.), px(1000.)));
        assert_eq!(fit(geometry(-1200.), Some(left)), geometry(-1200.));
        let small = Geometry {
            width: 20.,
            height: 20.,
            ..geometry(-300.)
        };
        let fitted = fit(small, Some(left));
        assert_eq!((fitted.width, fitted.height), (640., 400.));
        assert_eq!(fit(geometry(5000.), None).x, 5000.);
    }
}
