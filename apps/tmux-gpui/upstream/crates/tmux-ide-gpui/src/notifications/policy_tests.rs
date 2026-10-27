#![allow(clippy::unwrap_used)]
use super::*;

fn tick(
    endpoints: &mut [Endpoint],
    selected: usize,
    config: NotificationConfig,
    hidden: bool,
    now: Instant,
) -> bool {
    super::tick(endpoints, selected, config, hidden, true, None, now)
}
use crate::{config::NotificationConfig, endpoint::Endpoint};
use herdr_client::{
    ConnectTarget,
    protocol::{AgentStatus, SemanticNotificationKind as Kind},
};
use std::sync::Arc;

fn endpoints() -> [Endpoint; 2] {
    ["local", "remote"].map(|id| {
        let mut endpoint = Endpoint::new(id.into(), id.into(), ConnectTarget::Local, true);
        endpoint.live.snapshot = Some(Arc::new(
            serde_json::from_str(include_str!(
                "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
            ))
            .unwrap(),
        ));
        endpoint
    })
}

fn config(delay_seconds: u64) -> NotificationConfig {
    NotificationConfig {
        enabled: true,
        delay_seconds,
        ..Default::default()
    }
}

fn wire(kind: Kind) -> SemanticNotification {
    let mut wire = tests::notification("event");
    wire.kind = kind;
    wire.workspace_id = Some("w1".into());
    wire.tab_id = Some("w1:t1".into());
    wire.pane_id = Some("w1:p1".into());
    wire
}

fn receive(endpoint: &mut Endpoint, wire: SemanticNotification, now: Instant) {
    endpoint
        .toasts
        .receive([Notice::new(wire, now).with_snapshot(endpoint.live.snapshot.as_deref())]);
}

fn visible(endpoints: &[Endpoint]) -> Vec<&str> {
    endpoints
        .iter()
        .flat_map(|e| e.toasts.entries.iter())
        .filter(|(_, n)| n.visible)
        .map(|(_, n)| n.title.as_str())
        .collect()
}

#[test]
fn enable_cutoff_rejects_equal_time_ingress_and_keeps_previews() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    let toasts = &mut endpoints[1].toasts;
    toasts.enabled_since = Some(now);
    toasts.receive([
        Notice::new(tests::notification("disabled"), now),
        Notice::new(tests::notification("preview"), now).preview(),
        Notice::new(
            tests::notification("enabled"),
            now + Duration::from_nanos(1),
        ),
    ]);
    assert_eq!(
        toasts
            .entries
            .iter()
            .map(|(_, n)| n.title.as_str())
            .collect::<Vec<_>>(),
        ["preview", "enabled"]
    );
    tick(
        &mut endpoints,
        0,
        config(0),
        false,
        now + Duration::from_nanos(1),
    );
    assert_eq!(visible(&endpoints), ["preview"]);
}

#[test]
fn evidence_matrix_including_finished_zero_delay_and_delayed_attention() {
    for delay in [0, 1] {
        for kind in [Kind::Finished, Kind::NeedsAttention] {
            for status in [
                AgentStatus::Done,
                AgentStatus::Blocked,
                AgentStatus::Working,
                AgentStatus::Idle,
                AgentStatus::Unknown,
            ] {
                let now = Instant::now();
                let mut endpoints = endpoints();
                Arc::make_mut(endpoints[1].live.snapshot.as_mut().unwrap()).agents[0]
                    .agent_status = status;
                receive(&mut endpoints[1], wire(kind), now);
                tick(
                    &mut endpoints,
                    0,
                    config(delay),
                    false,
                    now + Duration::from_secs(delay),
                );
                let expected = match kind {
                    Kind::Finished => status == AgentStatus::Done,
                    Kind::NeedsAttention => delay == 0 || status == AgentStatus::Blocked,
                    _ => unreachable!(),
                };
                assert_eq!(
                    visible(&endpoints).len(),
                    usize::from(expected),
                    "{kind:?} {status:?} delay {delay}"
                );
            }
        }
    }
    let now = Instant::now();
    let mut endpoints = endpoints();
    let mut event = wire(Kind::Finished);
    event.pane_id = None;
    receive(&mut endpoints[1], event, now);
    tick(&mut endpoints, 0, config(0), false, now);
    assert!(endpoints[1].toasts.entries.is_empty());
}

#[test]
fn evidence_rechecks_at_fifty_ms_and_grace_is_bounded_from_arrival() {
    for missing in [false, true] {
        let now = Instant::now();
        let mut endpoints = endpoints();
        let mut snapshot = endpoints[1]
            .live
            .snapshot
            .as_ref()
            .unwrap()
            .as_ref()
            .clone();
        snapshot.agents[0].agent_status = AgentStatus::Done;
        if missing {
            endpoints[1].live.snapshot = None;
        } else {
            Arc::make_mut(endpoints[1].live.snapshot.as_mut().unwrap()).agents[0].agent_status =
                AgentStatus::Working;
        }
        receive(&mut endpoints[1], wire(Kind::Finished), now);
        tick(&mut endpoints, 0, config(0), false, now);
        assert!(visible(&endpoints).is_empty());
        endpoints[1].live.snapshot = Some(Arc::new(snapshot));
        tick(
            &mut endpoints,
            0,
            config(0),
            false,
            now + RECHECK - Duration::from_nanos(1),
        );
        assert!(visible(&endpoints).is_empty());
        tick(&mut endpoints, 0, config(0), false, now + RECHECK);
        assert_eq!(visible(&endpoints), ["event"]);
        assert!(
            endpoints[1].toasts.entries[0]
                .1
                .target(endpoints[1].live.snapshot.as_ref().unwrap())
                .is_some()
        );
    }
    for delay in [0, 1, 2] {
        let now = Instant::now();
        let mut endpoints = endpoints();
        endpoints[1].live.snapshot = None;
        receive(&mut endpoints[1], wire(Kind::Finished), now);
        tick(&mut endpoints, 0, config(delay), false, now);
        tick(
            &mut endpoints,
            0,
            config(delay),
            false,
            now + Duration::from_millis(975),
        );
        tick(
            &mut endpoints,
            0,
            config(delay),
            false,
            now + Duration::from_secs(delay.max(1)),
        );
        assert!(endpoints[1].toasts.entries.is_empty(), "delay {delay}");
    }
}

#[test]
fn active_tab_takes_precedence_over_workspace_and_background_is_not_suppressed() {
    for (tab, workspace, selected, suppressed) in [
        (Some("w1:t1"), Some("w1"), 1, true),
        (Some("other-tab"), Some("w1"), 1, false),
        (None, Some("w1"), 1, true),
        (Some("w1:t1"), Some("w1"), 0, false),
        (None, None, 1, false),
    ] {
        let now = Instant::now();
        let mut endpoints = endpoints();
        let mut event = wire(Kind::Custom);
        event.tab_id = tab.map(str::to_owned);
        event.workspace_id = workspace.map(str::to_owned);
        event.pane_id = None;
        receive(&mut endpoints[1], event, now);
        tick(&mut endpoints, selected, config(3600), false, now);
        assert_eq!(visible(&endpoints).is_empty(), suppressed);
    }
}

#[test]
fn global_order_survives_coalesced_host_polling_and_queue_overflow() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    let notices: Vec<_> = (0..24)
        .map(|i| {
            let mut event = tests::notification(&i.to_string());
            event.kind = Kind::Custom;
            Notice::new(event, now)
        })
        .collect();
    // Remote received first, although Local's coalesced inbox is polled first.
    endpoints[0]
        .toasts
        .receive(notices.iter().skip(1).step_by(2).cloned());
    endpoints[1]
        .toasts
        .receive(notices.iter().step_by(2).cloned());
    tick(&mut endpoints, 0, config(0), false, now);
    assert_eq!(visible(&endpoints), ["0"]);
    assert_eq!(
        endpoints
            .iter()
            .map(|e| e.toasts.entries.len())
            .sum::<usize>(),
        9
    );
    for i in 16..24 {
        let time = now + Duration::from_secs((i - 15) * 5);
        tick(&mut endpoints, 0, config(0), false, time);
        assert_eq!(visible(&endpoints), [i.to_string().as_str()]);
        let n = endpoints
            .iter()
            .flat_map(|e| &e.toasts.entries)
            .find(|(_, n)| n.visible)
            .unwrap();
        assert_eq!(n.1.expires, time + Duration::from_secs(5));
    }
}

#[test]
fn lifetimes_start_at_promotion_and_pause_while_hidden() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    for kind in [
        Kind::NeedsAttention,
        Kind::Finished,
        Kind::UpdateInstalled,
        Kind::Custom,
    ] {
        let mut event = tests::notification(&format!("{kind:?}"));
        event.kind = kind;
        endpoints[1]
            .toasts
            .receive([Notice::new(event, now).preview()]);
    }
    let mut time = now;
    for (title, seconds) in [
        ("NeedsAttention", 8),
        ("Finished", 5),
        ("UpdateInstalled", 3),
        ("Custom", 5),
    ] {
        tick(&mut endpoints, 0, config(0), false, time);
        assert_eq!(visible(&endpoints), [title]);
        time += Duration::from_secs(100);
        tick(&mut endpoints, 0, config(0), true, time);
        // A sleeping UI must also account for the last hidden interval on resume.
        time += Duration::from_secs(100);
        tick(&mut endpoints, 0, config(0), false, time);
        assert_eq!(visible(&endpoints), [title]);
        assert_eq!(
            endpoints[1].toasts.entries.front().unwrap().1.expires,
            time + Duration::from_secs(seconds)
        );
        tick(
            &mut endpoints,
            0,
            config(0),
            false,
            time + Duration::from_secs(seconds) - Duration::from_nanos(1),
        );
        assert_eq!(visible(&endpoints), [title]);
        time += Duration::from_secs(seconds);
    }
    tick(&mut endpoints, 0, config(0), false, time);
    assert!(visible(&endpoints).is_empty());
}

#[test]
fn replacement_spans_pending_queued_visible_and_is_endpoint_scoped() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    receive(&mut endpoints[1], wire(Kind::NeedsAttention), now);
    tick(&mut endpoints, 0, config(1), false, now);
    receive(&mut endpoints[1], wire(Kind::Custom), now);
    assert_eq!(endpoints[1].toasts.entries.len(), 1);
    tick(&mut endpoints, 0, config(1), false, now);
    assert_eq!(visible(&endpoints), ["event"]);
    let mut event = wire(Kind::Custom);
    event.title = "replacement".into();
    receive(&mut endpoints[1], event.clone(), now);
    receive(&mut endpoints[0], event.clone(), now);
    tick(&mut endpoints, 2, config(1), false, now);
    assert_eq!(visible(&endpoints), ["replacement"]);
    assert_eq!(endpoints[0].toasts.entries.len(), 1);
    assert_eq!(endpoints[1].toasts.entries.len(), 1);
    receive(&mut endpoints[0], event, now);
    assert_eq!(endpoints[0].toasts.entries.len(), 1);
    assert!(!endpoints[0].toasts.entries[0].1.visible);
    tick(&mut endpoints, 2, config(1), false, now);
    assert_eq!(
        endpoints
            .iter()
            .map(|e| e.toasts.entries.len())
            .sum::<usize>(),
        2
    );
}

#[test]
fn late_target_initialization_is_bounded_and_boot_fenced() {
    for (milliseconds, change_boot, initialized) in
        [(500, false, true), (1001, false, false), (500, true, false)]
    {
        let now = Instant::now();
        let mut endpoints = endpoints();
        let snapshot = endpoints[1].live.snapshot.clone().unwrap();
        Arc::make_mut(endpoints[1].live.snapshot.as_mut().unwrap())
            .panes
            .clear();
        let mut event = wire(Kind::Custom);
        event.workspace_id = None;
        event.tab_id = None;
        receive(&mut endpoints[1], event, now);
        tick(&mut endpoints, 0, config(0), false, now);
        endpoints[1].live.snapshot = Some(snapshot.clone());
        if change_boot {
            Arc::make_mut(endpoints[1].live.snapshot.as_mut().unwrap()).boot_id = "new".into();
        }
        tick(
            &mut endpoints,
            0,
            config(0),
            false,
            now + Duration::from_millis(milliseconds),
        );
        let target = endpoints[1]
            .toasts
            .entries
            .front()
            .and_then(|(_, n)| n.target(&snapshot));
        assert_eq!(target.is_some(), initialized);
        if initialized {
            let n = &endpoints[1].toasts.entries[0].1;
            assert_eq!(n.tab_id.as_deref(), Some("w1:t1"));
            let mut moved = snapshot.as_ref().clone();
            moved.panes[0].workspace_id = "different".into();
            assert!(n.target(&moved).is_none());
        }
        if change_boot {
            assert!(endpoints[1].toasts.entries.is_empty());
        }
    }
}

#[test]
fn settings_changes_bound_pending_and_preserve_explicit_corners_and_previews() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    for index in 0..20 {
        receive(
            &mut endpoints[index % 2],
            tests::notification(&index.to_string()),
            now,
        );
    }
    tick(&mut endpoints, 0, config(3600), false, now);
    assert_eq!(
        endpoints
            .iter()
            .map(|e| e.toasts.entries.len())
            .sum::<usize>(),
        PENDING_LIMIT
    );
    assert!(visible(&endpoints).is_empty());
    tick(&mut endpoints, 0, config(0), false, now);
    assert_eq!(visible(&endpoints), ["12"]);
    tick(&mut endpoints, 0, NotificationConfig::default(), false, now);
    assert!(endpoints.iter().all(|e| e.toasts.entries.is_empty()));
    tick(&mut endpoints, 0, config(0), false, now);
    assert!(visible(&endpoints).is_empty());
    for explicit in [false, true] {
        let mut event = tests::notification("corner");
        event.position = explicit.then_some(ToastHerdrPosition::TopLeft);
        endpoints[1]
            .toasts
            .receive([Notice::new(event, now).preview()]);
        let config = NotificationConfig {
            delay_seconds: 3600,
            position: ToastHerdrPosition::BottomLeft,
            ..Default::default()
        };
        tick(&mut endpoints, 1, config, false, now);
        let n = &endpoints[1].toasts.entries[0].1;
        assert!(n.visible);
        assert_eq!(
            n.position,
            if explicit {
                ToastHerdrPosition::TopLeft
            } else {
                ToastHerdrPosition::BottomLeft
            }
        );
        endpoints[1].toasts.entries.clear();
    }
}

fn system(delay_seconds: u64) -> NotificationConfig {
    NotificationConfig {
        enabled: false,
        system: true,
        delay_seconds,
        ..Default::default()
    }
}

fn posted(endpoints: &[Endpoint]) -> usize {
    endpoints
        .iter()
        .flat_map(|e| e.toasts.entries.iter())
        .filter(|(_, n)| n.posted)
        .count()
}

#[test]
fn system_delivery_posts_once_with_a_pane_tag_instead_of_a_toast() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    receive(&mut endpoints[1], wire(Kind::NeedsAttention), now);
    endpoints[0]
        .toasts
        .receive([Notice::new(tests::notification("preview"), now).preview()]);
    // Waiting for the delay is the same as for a toast.
    assert!(take_system(&mut endpoints, system(1)).is_empty());
    tick(&mut endpoints, 0, system(1), false, now);
    assert!(take_system(&mut endpoints, system(1)).is_empty());
    let later = now + Duration::from_secs(1);
    Arc::make_mut(endpoints[1].live.snapshot.as_mut().unwrap()).agents[0].agent_status =
        AgentStatus::Blocked;
    tick(&mut endpoints, 0, system(1), false, later);
    // Client-local feedback still uses the in-app card.
    assert_eq!(visible(&endpoints), ["preview"]);
    let posts = take_system(&mut endpoints, system(1));
    assert_eq!(
        posts,
        [SystemPost {
            endpoint: 1,
            id: 0,
            tag: "herdr:remote:boot-v1:w1:p1".into(),
            title: "event".into(),
            body: Some("Review needed".into()),
        }]
    );
    // Posted notices stay for click resolution, are never re-posted, and
    // never fall into the in-app queue.
    for _ in 0..2 {
        tick(&mut endpoints, 0, system(1), false, later);
        assert!(take_system(&mut endpoints, system(1)).is_empty());
        assert_eq!(posted(&endpoints), 1);
        assert_eq!(visible(&endpoints), ["preview"]);
    }
    assert_eq!(
        endpoints[1].toasts.entries[0]
            .1
            .target(endpoints[1].live.snapshot.as_deref().unwrap()),
        Some(NavigationTarget::Pane("w1:p1"))
    );
    // Turning delivery off drops the record; in-app delivery never posts.
    tick(
        &mut endpoints,
        0,
        NotificationConfig::default(),
        false,
        later,
    );
    assert_eq!(posted(&endpoints), 0);
    receive(&mut endpoints[1], wire(Kind::Custom), later);
    tick(&mut endpoints, 0, config(0), false, later);
    assert!(take_system(&mut endpoints, config(0)).is_empty());
    assert_eq!(visible(&endpoints), ["preview"]);
    assert_eq!(endpoints[1].toasts.entries.len(), 1);
}

#[test]
fn system_delivery_is_suppressed_for_the_active_tab_only_while_focused() {
    for (selected, focused, expected) in [(1, true, 0), (1, false, 1), (0, true, 1), (0, false, 1)]
    {
        let now = Instant::now();
        let mut endpoints = endpoints();
        receive(&mut endpoints[1], wire(Kind::Custom), now);
        super::tick(
            &mut endpoints,
            selected,
            system(0),
            false,
            focused,
            None,
            now,
        );
        assert_eq!(
            take_system(&mut endpoints, system(0)).len(),
            expected,
            "selected {selected} focused {focused}"
        );
    }
}

#[test]
fn system_delivery_ignores_hidden_toasts_and_bounds_retained_posts() {
    let now = Instant::now();
    let mut endpoints = endpoints();
    for title in 0..(PENDING_LIMIT * 2) {
        let mut event = wire(Kind::Custom);
        event.title = title.to_string();
        event.pane_id = None;
        event.tab_id = Some("other-tab".into());
        receive(&mut endpoints[1], event, now);
    }
    // A menu hiding in-app toasts does not hold back the OS center.
    tick(&mut endpoints, 1, system(0), true, now);
    let posts = take_system(&mut endpoints, system(0));
    assert_eq!(posts.len(), PENDING_LIMIT * 2);
    assert!(
        posts
            .windows(2)
            .all(|pair| pair[0].title.parse::<usize>().unwrap()
                < pair[1].title.parse::<usize>().unwrap())
    );
    // Targetless events never share a tag, so none replaces another.
    let mut tags: Vec<_> = posts.iter().map(|post| post.tag.as_str()).collect();
    tags.dedup();
    assert_eq!(tags.len(), posts.len());
    assert_eq!(posted(&endpoints), PENDING_LIMIT);
    assert_eq!(
        endpoints[1].toasts.entries.back().unwrap().1.title,
        (PENDING_LIMIT * 2 - 1).to_string()
    );
}
