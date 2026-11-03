//! #705, Option A: the flat session table with favicons, windows, last
//! activity and the agent on its row; machine label lines only where they
//! say something; agents' state as one quiet line, not a list.
use super::*;
use crate::tmux_snapshot::browser::fleet::{FAVICON_MAX, favicon};
use crate::tmux_snapshot::home::fleet_rows::{last_active, layout};
use base64::{Engine as _, engine::general_purpose::STANDARD};

/// A 16×16 PNG header: the smallest bytes #719's header check accepts as a PNG.
fn png_header() -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    b.extend(16u32.to_be_bytes());
    b.extend(16u32.to_be_bytes());
    b.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    b
}

#[test]
fn a_favicon_decodes_from_its_type_and_bounded_base64_or_not_at_all() {
    // Each type with a minimal header of its own kind (#719 reads headers).
    let mut bmp = 40u32.to_le_bytes().to_vec();
    bmp.extend(16i32.to_le_bytes());
    bmp.extend(32i32.to_le_bytes());
    bmp.extend([0; 28]);
    let mut ico = vec![0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0];
    ico.extend((bmp.len() as u32).to_le_bytes());
    ico.extend(22u32.to_le_bytes());
    ico.extend(&bmp);
    let jpeg = vec![
        0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 16, 0, 16, 1, 1, 0x11, 0, 0xff, 0xda,
    ];
    let mut webp = b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00".to_vec();
    webp.extend([15, 0, 0, 15, 0, 0]);
    let gif = b"GIF89a\x10\x00\x10\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x10\x00\x10\x00\x00\x02\x02\x4c\x01\x00\x3b".to_vec();
    for (mime, format, bytes) in [
        ("image/png", ImageFormat::Png, png_header()),
        ("image/svg+xml", ImageFormat::Svg, b"<svg/>".to_vec()),
        ("image/x-icon", ImageFormat::Ico, ico),
        ("image/jpeg", ImageFormat::Jpeg, jpeg),
        ("image/webp", ImageFormat::Webp, webp),
        ("image/gif", ImageFormat::Gif, gif),
    ] {
        let image = favicon(mime, &STANDARD.encode(&bytes)).unwrap();
        assert_eq!(
            (image.format, image.bytes.as_slice()),
            (format, bytes.as_slice())
        );
    }
    assert!(favicon("text/html", "PHN2Zy8+").is_none());
    assert!(favicon("image/png", "not base64!").is_none());
    assert!(favicon("image/png", "").is_none());
    let mut largest = png_header();
    largest.resize(FAVICON_MAX, 7);
    assert_eq!(
        favicon("image/png", &STANDARD.encode(&largest))
            .unwrap()
            .bytes
            .len(),
        FAVICON_MAX
    );
    let mut over = png_header();
    over.resize(FAVICON_MAX + 1, 7);
    assert!(favicon("image/png", &STANDARD.encode(&over)).is_none());
}

#[test]
fn last_active_reads_like_a_person_says_it() {
    let now = 1_000_000;
    for (ago, said) in [
        (-5, "now"),
        (0, "now"),
        (59, "now"),
        (60, "1 min ago"),
        (3599, "59 min ago"),
        (3600, "1 h ago"),
        (86_399, "23 h ago"),
        (86_400, "yesterday"),
        (172_799, "yesterday"),
        (172_800, "2 days ago"),
        (7 * 86_400 - 1, "6 days ago"),
        (7 * 86_400, "last week"),
        (14 * 86_400, "2 weeks ago"),
    ] {
        assert_eq!(last_active(now, now - ago), said, "{ago} s ago");
    }
}

fn fleet(machines: &[&str]) -> browser::fleet::Fleet {
    let groups: Vec<_> = machines
        .iter()
        .enumerate()
        .map(|(i, id)| {
            serde_json::json!({"id": id, "label": id, "state": "ready", "conflict": false,
                "omittedSessions": 0, "collapseAction": format!("1111111{i}-1111-4111-8111-111111111111"),
                "sessions": [
                    {"id": format!("{id}-web"), "name": "web", "paneCount": 3, "windowCount": 2,
                     "lastActivity": 0, "sessionId": format!("live-{id}-web"),
                     "favicon": {"mime": "image/svg+xml", "data": "PHN2Zy8+"}},
                    {"id": format!("{id}-api"), "name": "api", "paneCount": 1,
                     "sessionId": format!("live-{id}-api")}
                ]})
        })
        .collect();
    serde_json::from_value(serde_json::json!({"groups": groups, "omittedGroups": 0,
        "preferences": {"revision": 1, "phase": "ready", "error": null}}))
    .unwrap()
}

#[test]
fn a_row_says_windows_and_panes_or_panes_alone() {
    let fleet = fleet(&["local"]);
    assert_eq!(layout(&fleet.groups[0].sessions[0]), "2 windows · 3 panes");
    assert_eq!(layout(&fleet.groups[0].sessions[1]), "1 pane");
}

fn home(
    cx: &mut TestAppContext,
    fleet: browser::fleet::Fleet,
) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(fleet);
        view.frame = None;
        view.browser_state.frame = None;
        view
    });
    cx.simulate_resize(size(px(1200.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    (view, cx)
}

fn painted(cx: &mut VisualTestContext, key: &'static str) -> bool {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.debug_bounds(key).is_some()
}

#[gpui::test]
fn a_row_shows_its_favicon_or_the_terminal_glyph(cx: &mut TestAppContext) {
    let (_view, cx) = home(cx, fleet(&["local"]));
    assert!(painted(cx, "fleet-session-favicon-0-0"));
    assert!(!painted(cx, "fleet-session-glyph-0-0"));
    assert!(painted(cx, "fleet-session-glyph-0-1"));
    assert!(!painted(cx, "fleet-session-favicon-0-1"));
    // Last active only where the daemon said when.
    let active = cx.debug_bounds("fleet-session-active-0-0").unwrap();
    let empty = cx.debug_bounds("fleet-session-active-0-1").unwrap();
    let row = cx.debug_bounds("fleet-session-0-0").unwrap();
    assert!(row.contains(&active.center()) && empty.size.height <= active.size.height);
}

#[gpui::test]
fn machine_lines_show_for_several_machines_or_something_to_say(cx: &mut TestAppContext) {
    // One connected machine with nothing to do: no line, the left list names it.
    let (view, cx) = home(cx, fleet(&["local"]));
    assert!(!painted(cx, "fleet-machine-header-0"));
    assert!(!painted(cx, "fleet-collapse-0"));
    // A collapsed lone machine keeps its line, so it can open again.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups[0].collapsed = true;
            cx.notify();
        })
    });
    assert!(painted(cx, "fleet-machine-header-0"));
    assert!(painted(cx, "fleet-collapse-0"));
    // Two machines: a line each, with collapse, and no "Connected".
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet = Some(fleet(&["local", "spark"]));
            cx.notify();
        })
    });
    for key in [
        "fleet-machine-header-0",
        "fleet-machine-header-1",
        "fleet-collapse-1",
    ] {
        assert!(painted(cx, key), "{key}");
    }
    assert!(!painted(cx, "fleet-machine-status-0"));
    // A machine that is not connected says so.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups[1].state =
                browser::fleet::Phase::Disconnected;
            cx.notify();
        })
    });
    assert!(painted(cx, "fleet-machine-status-1"));
}

fn roster(phase: &str) -> browser::home_agents::Roster {
    serde_json::from_value(serde_json::json!({"revision": 3, "phase": phase, "rows": [
        {"key": "a", "sessionId": "live-local-web", "paneId": "p", "name": "Claude",
         "sessionLabel": "web", "status": "WORKING", "attention": false, "available": true}],
        "observedSessions": 1, "totalSessions": 1, "truncatedSessions": 0, "truncatedRows": 0,
        "note": null}))
    .unwrap()
}

#[gpui::test]
fn agents_live_on_their_rows_and_home_keeps_one_status_line(cx: &mut TestAppContext) {
    let (view, cx) = home(cx, fleet(&["local"]));
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.home_agents = Some(roster("live"));
            cx.notify();
        })
    });
    // The agent sits on the session it runs in; there is no agent list.
    assert!(painted(cx, "fleet-session-agent-0-0"));
    assert!(!painted(cx, "fleet-session-agent-0-1"));
    for gone in [
        "tmux-home-agent-0",
        "home-agent-list",
        "home-filter-hints",
        "home-agents-heading",
    ] {
        assert!(!painted(cx, gone), "{gone}");
    }
    // Live with nothing to recover: no status line at all.
    assert!(!painted(cx, "home-agents-status"));
    for phase in ["loading", "unavailable", "partial"] {
        cx.update(|_, cx| {
            view.update(cx, |v, cx| {
                v.browser_state.home_agents = Some(roster(phase));
                cx.notify();
            })
        });
        assert!(painted(cx, "home-agents-status"), "{phase}");
    }
}

#[gpui::test]
fn connected_machines_without_sessions_get_one_invitation(cx: &mut TestAppContext) {
    let mut empty = fleet(&["local"]);
    empty.groups[0].sessions.clear();
    let (view, cx) = home(cx, empty);
    assert!(painted(cx, "home-fleet-no-sessions"));
    assert!(!painted(cx, "fleet-columns"));
    // A machine still connecting is not "no sessions": it keeps its line.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet.as_mut().unwrap().groups[0].state =
                browser::fleet::Phase::Connecting;
            cx.notify();
        })
    });
    assert!(!painted(cx, "home-fleet-no-sessions"));
    assert!(painted(cx, "fleet-machine-status-0"));
    // Sessions back: the table, not the invitation.
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet = Some(fleet(&["local"]));
            cx.notify();
        })
    });
    assert!(!painted(cx, "home-fleet-no-sessions"));
    assert!(painted(cx, "fleet-columns"));
}
