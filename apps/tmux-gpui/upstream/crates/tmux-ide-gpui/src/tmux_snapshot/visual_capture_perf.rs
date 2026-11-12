//! Dev-only frame-cost bench: the real window, offscreen, on the real Metal
//! platform and text system (as the captures), timing each frame's main-thread
//! CPU work (`Window::draw`: layout, prepaint and paint into the scene, plus the
//! update that caused it). It does not time GPU raster, present or the
//! compositor. Allocations per frame come from the caller's counting allocator
//! and are exact. Built only with `visual-capture`; run through
//! `examples/perf_bench.rs`. Not run by CI.
use super::*;
use crate::terminal_painter::NativeFrame;
use herdr_client::protocol::{CellData, CursorState};
use std::{fmt::Write as _, time::Instant};

#[path = "visual_capture_perf_live.rs"]
mod live;

/// Allocations and bytes allocated so far, from the binary's global allocator,
/// and the main thread's CPU time in nanoseconds.
pub type AllocCounter = fn() -> (u64, u64, u64);

/// Frames dropped before timing, so caches and glyph atlases are warm.
const WARMUP: usize = 20;

/// The fixed scenarios, in the order they run. Names are stable: PRs compare
/// them before and after.
pub const SCENARIOS: &[&str] = &[
    "ws-idle",
    "ws-refresh",
    "ws-flood",
    "ws-flood-nosidebar",
    "ws-resize",
    "big-flood",
    "ws30-flood",
    "ws-flood-nosidebar-live",
    "big-flood-live",
    "ws30-refresh",
    "home30-publish",
    "home30-refresh",
    "home30-motion",
    "home30-idle",
    "ws30-spinner",
    "home30-spinner",
    "home100-publish",
    "home100-refresh",
    "home100-motion",
    "home30-nosidebar",
];

/// What causes each timed frame.
#[derive(Clone, Copy)]
enum Step {
    /// Draw with nothing dirty.
    Idle,
    /// `Window::refresh`: every view redrawn, caching bypassed.
    Refresh,
    /// A publication with the terminal scrolled one row, applied as
    /// `run_browser` applies it.
    Publish,
    /// The view notified with no state change, as a Home motion frame is.
    Motion,
    /// The window resized by 37 pt and back, alternately.
    Resize,
    /// The window's root notified, as each agent spinner tick does.
    Spinner,
}

struct Scenario {
    state: browser::State,
    window: (f32, f32),
    sidebar: bool,
    step: Step,
    /// Rows the published frames scroll through, and the grid size.
    rows: Option<Flood>,
    /// Decode and project each frame as the live app does (`live`).
    live: bool,
}

/// A pool of terminal rows and the grid (columns, rows) they scroll through.
type Flood = (Rc<Vec<Arc<[CellData]>>>, usize, usize);

/// Dense, coloured terminal rows, the kind a build log floods with.
fn dense_rows(cols: usize, count: usize) -> Vec<Arc<[CellData]>> {
    const WORDS: [&str; 20] = [
        "Compiling",
        "tmux-ide-gpui",
        "v0.1.16",
        "warning:",
        "unused",
        "variable",
        "`frame`",
        "-->",
        "src/lib.rs:42:9",
        "error[E0308]:",
        "mismatched",
        "types",
        "note:",
        "expected",
        "Finished",
        "release",
        "│",
        "─",
        "✓",
        "界",
    ];
    let cell = |symbol: String, fg: u32, modifier: u16, skip: bool| CellData {
        symbol,
        fg,
        bg: 0,
        modifier,
        skip,
        hyperlink: None,
    };
    (0..count)
        .map(|n| {
            let mut cells = Vec::with_capacity(cols);
            let mut word = 0;
            while cells.len() < cols.saturating_sub(12) {
                let text = WORDS[(n * 7 + word) % WORDS.len()];
                word += 1;
                let fg = match word {
                    w if w % 3 == 0 => 0x0100_0000 | ((n + w) % 16) as u32,
                    w if w % 5 == 0 => 0x0240_a0ff,
                    _ => 0,
                };
                let modifier = u16::from(word % 7 == 0);
                for ch in text.chars() {
                    if cells.len() >= cols {
                        break;
                    }
                    cells.push(cell(ch.to_string(), fg, modifier, false));
                    let wide = unicode_width::UnicodeWidthChar::width(ch) == Some(2);
                    if wide && cells.len() < cols {
                        cells.push(cell(String::new(), fg, 0, true));
                    }
                }
                if cells.len() < cols {
                    cells.push(cell(" ".into(), 0, 0, false));
                }
            }
            cells.resize_with(cols, || cell(" ".into(), 0, 0, false));
            Arc::from(cells)
        })
        .collect()
}

/// Rows `scroll..scroll + rows` of the pool, as a native frame.
fn frame_at(pool: &[Arc<[CellData]>], cols: usize, rows: usize, scroll: usize) -> DisplayFrame {
    DisplayFrame::Native(Arc::new(NativeFrame {
        rows: (0..rows)
            .map(|y| Arc::clone(&pool[(scroll + y) % pool.len()]))
            .collect(),
        width: u16::try_from(cols).unwrap_or(u16::MAX),
        height: u16::try_from(rows).unwrap_or(u16::MAX),
        cursor: Some(CursorState {
            x: 0,
            y: u16::try_from(rows.saturating_sub(1)).unwrap_or(0),
            visible: true,
            shape: Default::default(),
        }),
    }))
}

/// A local fleet of `sessions` sessions and `agents` agents spread over them,
/// shown on Home or in the workspace sidebar.
fn fleet(
    mut state: browser::State,
    sessions: usize,
    agents: usize,
    home: bool,
) -> Result<browser::State> {
    let token =
        |n: usize| uuid::Uuid::from_u128(0x9990_0000_0000_4000_8000_0000_0000_0000 + n as u128);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let rows: Vec<serde_json::Value> = (0..sessions)
        .map(|i| {
            serde_json::json!({"id": format!("s{i}"), "name": format!("project-{i}"),
                "sessionId": format!("${i}"), "serverId": "default", "paneCount": 1 + i % 4,
                "windowCount": 1 + i % 3, "lastActivity": now - (i as u64) * 600,
                "favoriteAction": token(1000 + i).to_string(),
                "selection": token(2000 + i).to_string(), "active": i == 0})
        })
        .collect();
    state.fleet = Some(serde_json::from_value(serde_json::json!({
        "preferences": {"revision": 1, "phase": "ready", "error": null}, "omittedGroups": 0,
        "groups": [{"id": "local", "label": "Local", "state": "ready", "conflict": false,
            "collapsed": false, "collapseAction": token(1).to_string(), "omittedSessions": 0,
            "omittedServers": 0, "sessions": rows,
            "servers": [{"id": "default", "label": "default", "state": "online",
                "generation": token(2).to_string(), "selection": token(3).to_string()}]}]
    }))?);
    state.selected_server = Some(browser::fleet::SelectedServer {
        machine_id: "local".into(),
        machine_label: "Local".into(),
        server_id: "default".into(),
        generation: token(2).to_string(),
        label: "default".into(),
    });
    const STATUSES: [&str; 4] = ["WORKING", "BLOCKED", "IDLE", "DONE"];
    let agent_rows: Vec<serde_json::Value> = (0..agents)
        .map(|a| {
            let claude = a % 2 == 0;
            serde_json::json!({"key": format!("agent-{a}"), "sessionId": format!("${}", a % sessions),
                "paneId": format!("pane-{a}"), "name": if claude { "Claude" } else { "Codex" },
                "sessionLabel": format!("project-{}", a % sessions),
                "harness": if claude { "claude-code" } else { "codex" },
                "status": STATUSES[a % 4], "attention": a % 4 == 1, "available": true})
        })
        .collect();
    if home {
        state.home_agents = Some(serde_json::from_value(serde_json::json!({
            "revision": 1, "phase": "live", "observedSessions": sessions,
            "totalSessions": sessions, "truncatedSessions": 0, "truncatedRows": 0,
            "note": null, "rows": agent_rows}))?);
        state.surface = browser::Surface::Home;
        state.sessions.clear();
        return Ok(state);
    }
    let mut publication: crate::tmux_snapshot::workspace_fleet_agents::Publication =
        serde_json::from_value(serde_json::json!({
            "request": state.request, "scope": 1, "revision": 1, "phase": "live",
            "selectedKey": null, "observedSessions": sessions, "totalSessions": sessions,
            "truncatedSessions": 0, "truncatedRows": 0, "note": null, "rows": agent_rows}))?;
    for a in 0..agents {
        publication.sessions.insert(
            format!("agent-{a}"),
            crate::tmux_snapshot::workspace_fleet_agents::SessionScope {
                machine: "local".into(),
                server: "default".into(),
                generation: token(2).to_string(),
                session: format!("${}", a % sessions),
            },
        );
    }
    state.workspace_fleet_agents = Some(publication);
    Ok(state)
}

fn scenario(name: &str, base: &browser::State) -> Result<Scenario> {
    let flood = |cols: usize, rows: usize| {
        let pool = Rc::new(dense_rows(cols, 400));
        let mut state = base.clone();
        state.frame = Some(frame_at(&pool, cols, rows, 0));
        state.regions = serde_json::from_value(serde_json::json!([
            {"id": "pane-a", "left": 0, "top": 0, "width": cols, "height": rows}
        ]))?;
        Ok::<_, anyhow::Error>((state, Some((pool, cols, rows))))
    };
    let workspace = (WIDTH, HEIGHT);
    let (state, rows) = flood(COLS, ROWS)?;
    let s = |state, window, sidebar, step, rows| Scenario {
        state,
        window,
        sidebar,
        step,
        rows,
        live: false,
    };
    if let Some(name) = name.strip_suffix("-live") {
        return Ok(Scenario {
            live: true,
            ..scenario(name, base)?
        });
    }
    Ok(match name {
        "ws-idle" => s(state, workspace, true, Step::Idle, None),
        "ws-refresh" => s(state, workspace, true, Step::Refresh, None),
        "ws-flood" => s(state, workspace, true, Step::Publish, rows),
        "ws-flood-nosidebar" => s(state, workspace, false, Step::Publish, rows),
        "ws-resize" => s(state, workspace, true, Step::Resize, None),
        "big-flood" => {
            let (state, rows) = flood(240, 64)?;
            s(state, (2560., 1440.), true, Step::Publish, rows)
        }
        "ws30-flood" => s(
            fleet(state, 30, 40, false)?,
            workspace,
            true,
            Step::Publish,
            rows,
        ),
        "ws30-refresh" => s(
            fleet(state, 30, 40, false)?,
            workspace,
            true,
            Step::Refresh,
            None,
        ),
        "home30-publish" | "home100-publish" => {
            let sessions = if name == "home30-publish" { 30 } else { 100 };
            s(
                fleet(state, sessions, 40, true)?,
                HOME_SIZE,
                true,
                Step::Publish,
                rows,
            )
        }
        "home30-refresh" | "home100-refresh" => {
            let sessions = if name == "home30-refresh" { 30 } else { 100 };
            s(
                fleet(state, sessions, 40, true)?,
                HOME_SIZE,
                true,
                Step::Refresh,
                None,
            )
        }
        "home30-motion" | "home100-motion" => {
            let sessions = if name == "home30-motion" { 30 } else { 100 };
            s(
                fleet(state, sessions, 40, true)?,
                HOME_SIZE,
                true,
                Step::Motion,
                None,
            )
        }
        // Home's own cost, without the sidebar's.
        "home30-nosidebar" => s(
            fleet(state, 30, 40, true)?,
            HOME_SIZE,
            false,
            Step::Refresh,
            None,
        ),
        "home30-idle" => s(
            fleet(state, 30, 40, true)?,
            HOME_SIZE,
            true,
            Step::Idle,
            None,
        ),
        "ws30-spinner" => s(
            fleet(state, 30, 40, false)?,
            workspace,
            true,
            Step::Spinner,
            None,
        ),
        "home30-spinner" => s(
            fleet(state, 30, 40, true)?,
            HOME_SIZE,
            true,
            Step::Spinner,
            None,
        ),
        other => return Err(anyhow!("unknown scenario {other}")),
    })
}

/// One scenario's frames.
struct Frames {
    ms: Vec<f64>,
    cpu: Vec<f64>,
    allocs: Vec<u64>,
    bytes: Vec<u64>,
}
impl Frames {
    fn line(mut self, name: &str) -> String {
        self.ms.sort_by(f64::total_cmp);
        self.cpu.sort_by(f64::total_cmp);
        self.allocs.sort_unstable();
        self.bytes.sort_unstable();
        let at = |q: f64| self.ms[((self.ms.len() - 1) as f64 * q).round() as usize];
        let over = |limit: f64| self.ms.iter().filter(|ms| **ms > limit).count();
        let mut line = format!(
            "{name:<18} n={:<4} p50={:>7.3}ms p95={:>7.3} p99={:>7.3} max={:>7.3} >8.3ms={} >16.7ms={}",
            self.ms.len(),
            at(0.5),
            at(0.95),
            at(0.99),
            at(1.),
            over(8.33),
            over(16.67),
        );
        let middle = self.allocs.len() / 2;
        let cpu = |q: f64| self.cpu[((self.cpu.len() - 1) as f64 * q).round() as usize];
        let _ = write!(line, " cpu p50={:.3}ms p95={:.3}", cpu(0.5), cpu(0.95));
        let _ = write!(
            line,
            " allocs/frame p50={} min={} max={} bytes/frame p50={}",
            self.allocs[middle],
            self.allocs[0],
            self.allocs[self.allocs.len() - 1],
            self.bytes[middle],
        );
        line
    }
}

fn run(
    cx: &mut VisualTestAppContext,
    background: WindowBackgroundAppearance,
    scenario: Scenario,
    frames: usize,
    counter: AllocCounter,
) -> Result<(Frames, Option<Frames>)> {
    let Scenario {
        state,
        window: (width, height),
        sidebar,
        step,
        rows,
        live,
    } = scenario;
    let mut feed = rows
        .as_ref()
        .filter(|_| live)
        .map(|(pool, cols, rows)| live::LiveFeed::new(pool, *cols, *rows));
    let (sender, receiver) = mpsc::sync_channel(1 << 16);
    let root: Rc<RefCell<Option<Entity<SnapshotView>>>> = Default::default();
    let base = state.clone();
    let handle = cx.update(|cx| {
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: point(px(-10000.), px(-10000.)),
                    size: size(px(width), px(height)),
                })),
                window_background: background,
                focus: false,
                show: false,
                ..crate::tmux_snapshot::shell::options()
            },
            |window, cx| {
                let view = cx.new(|cx| {
                    let mut view = capture_view(window, cx, sender, state);
                    view.sidebar_hidden = !sidebar;
                    view
                });
                *root.borrow_mut() = Some(view.clone());
                crate::tmux_snapshot::agent_spinner::window_root(view, window, cx)
            },
        )
    })?;
    for _ in 0..5 {
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, _| window.refresh())?;
    }
    let view = root
        .borrow()
        .clone()
        .ok_or_else(|| anyhow!("perf window has no view"))?;
    let new = || Frames {
        ms: Vec::with_capacity(frames),
        cpu: Vec::with_capacity(frames),
        allocs: Vec::with_capacity(frames),
        bytes: Vec::with_capacity(frames),
    };
    let mut timed = new();
    // `GLYPH_AB=legacy`: odd frames paint glyph by glyph, interleaved with
    // the batched ones so both see the same load. `GLYPH_AB=rows`: odd frames
    // paint without retained rows. `GLYPH_ROWS=0` turns retained rows off.
    let mode = std::env::var("GLYPH_AB").ok();
    let ab = mode.is_some();
    let rows_ab = mode.as_deref() == Some("rows");
    let rows_on = std::env::var("GLYPH_ROWS").map_or(true, |v| v != "0");
    let mut legacy_timed = new();
    for index in 0..frames + WARMUP {
        let legacy = ab && index % 2 == 1;
        crate::terminal_painter::LEGACY_GLYPHS
            .store(legacy && !rows_ab, std::sync::atomic::Ordering::Relaxed);
        crate::terminal_painter::RETAIN_ROWS.store(
            rows_on && !(legacy && rows_ab),
            std::sync::atomic::Ordering::Relaxed,
        );
        let timed = if legacy {
            &mut legacy_timed
        } else {
            &mut timed
        };
        // Built before the clock starts: the transport thread does this work.
        let published = match (rows.as_ref(), feed.as_mut()) {
            (Some(_), Some(feed)) => {
                let mut state = base.clone();
                state.frame = Some(DisplayFrame::Native(feed.frame(index + 1)?));
                Some(state)
            }
            (Some((pool, cols, rows)), None) => {
                let mut state = base.clone();
                state.frame = Some(frame_at(pool, *cols, *rows, index + 1));
                Some(state)
            }
            _ => None,
        };
        let (allocs, bytes, cpu) = counter();
        let started = Instant::now();
        cx.update_window(handle.into(), |root, window, cx| {
            match step {
                Step::Spinner => cx.notify(root.entity_id()),
                Step::Idle => {}
                Step::Refresh => window.refresh(),
                Step::Publish => view.update(cx, |view, cx| {
                    if let Some(state) = published {
                        view.frame = state.frame.clone();
                        view.apply_browser_state(Some(state), cx);
                    }
                }),
                Step::Motion => view.update(cx, |_, cx| cx.notify()),
                Step::Resize => {
                    let shrink = if index % 2 == 0 { 0. } else { 37. };
                    window.resize(size(px(width - shrink), px(height - shrink / 2.)));
                    window.refresh();
                }
            }
            window.draw(cx).clear(cx);
        })?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.;
        let (allocs_after, bytes_after, cpu_after) = counter();
        if index >= WARMUP {
            timed.ms.push(elapsed);
            timed.cpu.push(cpu_after.saturating_sub(cpu) as f64 / 1e6);
            timed.allocs.push(allocs_after - allocs);
            timed.bytes.push(bytes_after - bytes);
        }
        receiver.try_iter().for_each(drop);
    }
    cx.update_window(handle.into(), |_, window, _| window.remove_window())?;
    cx.run_until_parked();
    if let Some(mut feed) = feed {
        feed.projection_ms.sort_by(f64::total_cmp);
        let at = |q: f64| {
            feed.projection_ms[((feed.projection_ms.len() - 1) as f64 * q).round() as usize]
        };
        eprintln!(
            "  live projection (transport thread, off the clock) p50={:.3}ms p95={:.3}",
            at(0.5),
            at(0.95)
        );
    }
    Ok((timed, ab.then_some(legacy_timed)))
}

/// Runs each scenario whose name contains `filter` (all when `None`) for
/// `frames` timed frames and prints one line per scenario to stderr.
#[doc(hidden)]
pub fn perf_bench(counter: AllocCounter, frames: usize, filter: Option<&str>) -> Result<()> {
    let mut cx = VisualTestAppContext::with_asset_source(
        gpui_platform::current_platform(false),
        Arc::new(crate::icons::Icons),
    );
    let appearance = catalog_appearance("dark")?;
    let background =
        crate::tmux_snapshot::design::palette(&appearance.native()).window_background_appearance();
    let base = browser_state(appearance)?;
    for name in SCENARIOS
        .iter()
        .filter(|name| filter.is_none_or(|filter| name.contains(filter)))
    {
        let (frames, legacy) = run(
            &mut cx,
            background,
            scenario(name, &base)?,
            frames.max(1),
            counter,
        )?;
        match legacy {
            Some(legacy) => {
                let (a, b) = if std::env::var("GLYPH_AB").as_deref() == Ok("rows") {
                    ("rows", "norows")
                } else {
                    ("batched", "legacy")
                };
                eprintln!("{}", frames.line(&format!("{name}/{a}")));
                eprintln!("{}", legacy.line(&format!("{name}/{b}")));
            }
            None => eprintln!("{}", frames.line(name)),
        }
    }
    Ok(())
}
