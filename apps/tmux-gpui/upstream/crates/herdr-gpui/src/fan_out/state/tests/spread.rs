use super::*;
use crate::dispatch::{Load, Repository};

fn candidate(id: &str, cores: u32, busy: f32, current: bool) -> Candidate {
    Candidate {
        endpoint_id: id.into(),
        label: id.into(),
        online: true,
        current,
        load: Some(Load {
            cpu: Some(busy / cores as f32 * 100.),
            cores: Some(cores),
            load5: Some(busy),
            memory: Some(30.),
        }),
        repository: Repository::Present,
        ..Candidate::default()
    }
}

/// A fan-out on a busy "local" with two roomy hosts, three lanes picked.
fn spreadable() -> FanOut {
    let mut fan_out = idle();
    let now = Instant::now();
    assert!(fan_out.update_hosts(
        vec![
            candidate("local", 8, 7.5, true),
            candidate("ssh:big", 16, 8., false),
            candidate("ssh:small", 8, 2., false),
        ],
        now,
    ));
    fan_out.picks.add(AgentKind::Claude);
    fan_out.picks.add(AgentKind::Codex);
    fan_out.picks.add(AgentKind::Claude);
    fan_out
}

fn destination(endpoint: &str) -> Option<HostRepositories> {
    Some(HostRepositories {
        place: Place {
            endpoint_id: endpoint.into(),
            label: endpoint.into(),
            host: origin().host,
        },
        repositories: None,
        retired: Vec::new(),
    })
}

#[test]
fn lanes_stay_on_the_origin_until_spread() {
    let mut fan_out = spreadable();
    assert!(fan_out.can_spread());
    assert_eq!(fan_out.lane_hosts(), ["local", "local", "local"]);
    assert_eq!(fan_out.host_count(), 1);
    assert!(
        !fan_out.assign(0, "ssh:big"),
        "a lane is placed only while spreading"
    );
    assert!(fan_out.toggle_spread());
    // big has 8 cores free, small 6; a lane costs one.
    assert_eq!(fan_out.lane_hosts(), ["ssh:big", "ssh:big", "ssh:big"]);
    assert!(fan_out.assign(1, "ssh:small"));
    assert_eq!(fan_out.lane_hosts(), ["ssh:big", "ssh:small", "ssh:big"]);
    assert_eq!(fan_out.host_count(), 2);
    assert!(fan_out.assign(2, "local"), "the origin stays a choice");
    assert!(!fan_out.assign(0, "ssh:gone"), "an unknown host is refused");
    assert!(!fan_out.assign(7, "ssh:big"), "so is a lane past the picks");
}

#[test]
fn changing_the_picks_or_the_spread_drops_lane_choices() {
    let mut fan_out = spreadable();
    fan_out.toggle_spread();
    fan_out.assign(1, "ssh:small");
    assert!(fan_out.toggle(AgentKind::Codex, true));
    assert!(
        fan_out.overrides.is_empty(),
        "lanes shifted under their choices"
    );
    fan_out.assign(1, "ssh:small");
    fan_out.toggle_spread();
    fan_out.toggle_spread();
    assert!(fan_out.overrides.is_empty());
}

#[test]
fn a_spread_launch_describes_every_other_host() {
    let mut fan_out = spreadable();
    fan_out.toggle_spread();
    fan_out.assign(2, "local");
    assert!(
        !fan_out.launch("go", 1, |_| None),
        "a host that cannot be described stops the launch"
    );
    assert!(fan_out.composing());
    assert!(
        fan_out
            .error
            .as_deref()
            .is_some_and(|e| e.contains("ssh:big"))
    );
    // Work is cancelled at once, so the launch thread does nothing real.
    fan_out.work.store(true, Ordering::Release);
    assert!(fan_out.launch("go", 1, destination));
    assert!(matches!(fan_out.stage, Stage::Launching));
    assert_eq!(fan_out.lanes.len(), 3);
}

#[test]
fn hosts_stop_updating_once_launched() {
    let mut fan_out = spreadable();
    fan_out.stage = Stage::Launching;
    assert!(!fan_out.can_spread());
    assert!(!fan_out.update_hosts(Vec::new(), Instant::now()));
}
