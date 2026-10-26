use super::*;
fn route(id: &str, ready: bool) -> FleetEnvironmentRoute<'_> {
    FleetEnvironmentRoute {
        id,
        ready,
        environment_id: Some("environment"),
        generation: Some("generation-1"),
    }
}
#[test]
fn authenticated_aliases_join_and_selected_ready_route_wins() {
    let routes = [route("a", true), route("b", true)];
    assert_eq!(
        group_fleet_environments(&routes, "b", &BTreeMap::new()),
        vec![FleetEnvironmentGroup {
            environment_id: Some("environment"),
            route_ids: vec!["a", "b"],
            primary_route_id: "b",
            conflict: false,
        }]
    );
    let mut unknown = route("unknown", true);
    unknown.environment_id = None;
    assert_eq!(
        group_fleet_environments(&[route("a", true), unknown], "a", &BTreeMap::new()).len(),
        2
    );
    let mut unknown = route("unknown", true);
    unknown.generation = None;
    assert_eq!(
        group_fleet_environments(&[route("a", true), unknown], "a", &BTreeMap::new()).len(),
        2
    );
}
#[test]
fn offline_generation_conflict_is_never_joined_to_live_replacement() {
    let mut old = route("old", false);
    old.generation = Some("generation-0");
    let groups =
        group_fleet_environments(&[route("current", true), old], "current", &BTreeMap::new());
    assert_eq!(groups.len(), 2);
    assert!(
        groups
            .iter()
            .all(|group| group.conflict && group.route_ids.len() == 1)
    );
}
#[test]
fn healthy_fallback_does_not_mutate_preferred_route() {
    let preferred = BTreeMap::from([("environment".into(), "a".into())]);
    let routes = [route("a", false), route("b", true)];
    assert_eq!(
        group_fleet_environments(&routes, "a", &preferred)[0].primary_route_id,
        "b"
    );
    assert_eq!(preferred.get("environment").map(String::as_str), Some("a"));
    let routes = [route("b", false), route("a", false)];
    assert_eq!(
        group_fleet_environments(&routes, "b", &preferred)[0].primary_route_id,
        "a"
    );
    assert_eq!(
        group_fleet_environments(&routes, "b", &BTreeMap::new())[0].primary_route_id,
        "b"
    );
}
#[test]
fn route_ids_cannot_collide_with_environment_keys() {
    let mut local = route("environment", false);
    local.environment_id = None;
    let routes = [local, route("alias", false), route("other", false)];
    let groups = group_fleet_environments(&routes, "", &BTreeMap::new());
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].route_ids, ["environment"]);
    assert_eq!(groups[1].route_ids, ["alias", "other"]);
    assert!(group_fleet_environments(&[], "", &BTreeMap::new()).is_empty());
}
