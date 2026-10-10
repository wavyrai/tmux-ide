use super::*;

#[test]
fn spare_cores_prefer_the_load_average_over_a_momentary_share() {
    let load = Load {
        cpu: Some(100.),
        cores: Some(16),
        load5: Some(4.),
        memory: None,
    };
    assert_eq!(load.spare_cores(), Some(12.));
    let share_only = Load {
        load5: None,
        cpu: Some(25.),
        ..load
    };
    assert_eq!(share_only.spare_cores(), Some(12.));
    // Overloaded is no room, not negative room.
    let overloaded = Load {
        load5: Some(40.),
        ..load
    };
    assert_eq!(overloaded.spare_cores(), Some(0.));
    assert_eq!(Load::default().spare_cores(), None);
    let unsized_load = Load {
        cores: None,
        ..load
    };
    assert_eq!(unsized_load.spare_cores(), None);
}

#[test]
fn an_idle_big_host_outranks_a_busy_small_one() {
    let candidates = [
        current(host("laptop", 10, 8.7)),
        host("beelink", 16, 1.4),
        host("studio", 24, 10.),
        offline("farm"),
    ];
    assert_eq!(
        ids(&candidates, &rank(&candidates)),
        ["beelink", "studio", "laptop", "farm"]
    );
}

#[test]
fn working_agents_clones_and_tight_memory_cost_room() {
    let base = host("a", 16, 4.);
    let score = |c: &Candidate| c.score().unwrap();
    let busy = Candidate {
        working: 4,
        ..base.clone()
    };
    assert_eq!(score(&base) - score(&busy), 2.);
    let missing = Candidate {
        repository: Repository::Missing,
        ..base.clone()
    };
    assert_eq!(score(&base) - score(&missing), 1.);
    let unknown = Candidate {
        repository: Repository::Unknown,
        ..base.clone()
    };
    assert_eq!(
        score(&unknown),
        score(&base),
        "unknown is not assumed missing"
    );
    let tight = Candidate {
        load: base.load.map(|load| Load {
            memory: Some(95.),
            ..load
        }),
        ..base.clone()
    };
    assert_eq!(score(&tight), score(&base) / 2.);
    assert_eq!(offline("x").score(), None);
}

#[test]
fn past_picks_lean_towards_a_host_up_to_a_cap() {
    let a = host("a", 8, 4.);
    let picked = |picks| Candidate { picks, ..a.clone() };
    let score = |c: Candidate| c.score().unwrap();
    assert_eq!(score(picked(2)) - score(a.clone()), 1.);
    assert_eq!(score(picked(3)), score(picked(8)), "the lean is capped");
}

#[test]
fn ties_go_to_the_current_host_then_by_name() {
    let candidates = [
        host("b", 8, 4.),
        host("a", 8, 4.),
        current(host("c", 8, 4.25)),
    ];
    // The current host's bonus exactly offsets its extra quarter core.
    assert_eq!(ids(&candidates, &rank(&candidates)), ["c", "a", "b"]);
}

#[test]
fn an_unsampled_host_ranks_by_what_is_known() {
    let unsampled = Candidate {
        load: None,
        ..host("new", 64, 0.)
    };
    assert!(!unsampled.sampled());
    assert!(
        offline("gone").sampled(),
        "an offline host has nothing to wait for"
    );
    let candidates = [unsampled, host("known", 8, 2.)];
    assert_eq!(ids(&candidates, &rank(&candidates)), ["known", "new"]);
}

#[test]
fn lanes_spread_to_the_host_with_the_most_room_left() {
    let candidates = [
        current(host("laptop", 10, 9.)),
        host("beelink", 16, 13.),
        host("studio", 24, 20.),
        offline("farm"),
    ];
    let order = rank(&candidates);
    let lanes = spread(&candidates, &order, 5);
    let names: Vec<_> = lanes
        .iter()
        .map(|&i| candidates[i].endpoint_id.as_str())
        .collect();
    // studio (4 free) and beelink (3 free) share the work, a lane costing a
    // core and a tie going to the better ranked; the busy laptop and the
    // offline farm get none.
    assert_eq!(names, ["studio", "studio", "beelink", "studio", "beelink"]);
    assert!(spread(&[offline("x")], &[0], 3).is_empty());
}
