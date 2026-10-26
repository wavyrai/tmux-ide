//! Display-only environment joins. A primary route is a locator, never authority.
use std::collections::BTreeMap;

pub struct FleetEnvironmentRoute<'a> {
    pub id: &'a str,
    /// Only authenticated identities or previously verified cache records belong here.
    pub environment_id: Option<&'a str>,
    pub generation: Option<&'a str>,
    pub ready: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub struct FleetEnvironmentGroup<'a> {
    pub environment_id: Option<&'a str>,
    pub route_ids: Vec<&'a str>,
    pub primary_route_id: &'a str,
    pub conflict: bool,
}
/// Preserve input order, matching the shared fleet's display semantics. Include
/// offline generations in conflict detection: an alias must reauthenticate before
/// joining a replacement daemon. This function neither connects nor redirects input.
pub fn group_fleet_environments<'a>(
    routes: &[FleetEnvironmentRoute<'a>],
    selected: &str,
    preferred: &BTreeMap<String, String>,
) -> Vec<FleetEnvironmentGroup<'a>> {
    let mut buckets: Vec<Vec<&FleetEnvironmentRoute<'a>>> = Vec::new();
    let mut indices = BTreeMap::new();
    for route in routes {
        let key = match (route.environment_id, route.generation) {
            (Some(environment), Some(generation))
                if !environment.is_empty() && !generation.is_empty() =>
            {
                (true, environment)
            }
            _ => (false, route.id),
        };
        let index = *indices.entry(key).or_insert_with(|| {
            buckets.push(Vec::new());
            buckets.len() - 1
        });
        buckets[index].push(route);
    }
    let mut groups = Vec::new();
    for bucket in buckets {
        let Some(first) = bucket.first() else {
            continue;
        };
        if bucket
            .iter()
            .any(|route| route.generation != first.generation)
        {
            groups.extend(bucket.iter().map(|route| FleetEnvironmentGroup {
                environment_id: route.environment_id,
                route_ids: vec![route.id],
                primary_route_id: route.id,
                conflict: true,
            }));
            continue;
        }
        let preferred = first.environment_id.and_then(|id| preferred.get(id));
        let is_preferred =
            |route: &&&FleetEnvironmentRoute<'a>| preferred.is_some_and(|id| id == route.id);
        let primary = bucket
            .iter()
            .find(|route| route.id == selected && route.ready)
            .or_else(|| {
                bucket
                    .iter()
                    .find(|route| route.ready && is_preferred(route))
            })
            .or_else(|| bucket.iter().find(|route| route.ready))
            .or_else(|| bucket.iter().find(is_preferred))
            .unwrap_or(first);
        groups.push(FleetEnvironmentGroup {
            environment_id: first.environment_id,
            route_ids: bucket.iter().map(|route| route.id).collect(),
            primary_route_id: primary.id,
            conflict: false,
        });
    }
    groups
}

#[cfg(test)]
#[path = "fleet_environments_tests.rs"]
mod tests;
