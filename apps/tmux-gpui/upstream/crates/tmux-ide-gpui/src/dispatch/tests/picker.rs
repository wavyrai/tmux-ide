use super::*;
use std::time::{Duration, Instant};

fn hosts() -> Vec<Candidate> {
    vec![
        current(host("laptop", 10, 9.)),
        host("beelink", 16, 1.),
        host("studio", 24, 12.),
        host("mini", 8, 2.),
        host("nuc", 4, 1.),
        offline("farm"),
    ]
}

fn names<'a>(hosts: impl Iterator<Item = &'a Candidate>) -> Vec<&'a str> {
    hosts.map(|c| c.endpoint_id.as_str()).collect()
}

#[test]
fn the_best_three_are_tiles_and_the_rest_are_listed() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    assert!(picker.update(hosts(), now));
    assert_eq!(names(picker.best()), ["beelink", "studio", "mini"]);
    assert_eq!(names(picker.rest()), ["nuc", "laptop", "farm"]);
    assert_eq!(
        picker.suggestion().map(|c| c.label.as_str()),
        Some("beelink")
    );
    assert!(picker.offers_choice());
}

#[test]
fn the_current_host_is_chosen_until_another_is() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    picker.update(hosts(), now);
    assert_eq!(picker.chosen().map(|c| c.current), Some(true));
    assert!(picker.dispatched().is_none());
    assert!(!picker.choose("farm"), "an offline host cannot be chosen");
    assert!(picker.choose("nuc"));
    assert!(!picker.choose("nuc"), "choosing it again changes nothing");
    assert!(!picker.is_best("nuc"));
    assert_eq!(picker.dispatched().map(|c| c.label.as_str()), Some("nuc"));
    // The chosen host dropping off returns the choice to the current one.
    let mut gone = hosts();
    gone[4].online = false;
    assert!(picker.update(gone, now));
    assert!(picker.dispatched().is_none());
}

#[test]
fn the_ranking_settles_once_every_host_is_sampled() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    let mut unsampled = hosts();
    unsampled[1].load = None;
    picker.update(unsampled, now);
    assert_ne!(
        picker.ranked().next().map(|c| c.label.as_str()),
        Some("beelink")
    );
    // Sampled, beelink rises to the top and the order holds from then on.
    picker.update(hosts(), now);
    assert_eq!(names(picker.best()), ["beelink", "studio", "mini"]);
    let mut busier = hosts();
    busier[1].load = busier[2].load;
    busier[1].working = 9;
    assert!(picker.update(busier, now), "new numbers still show");
    assert_eq!(names(picker.best()), ["beelink", "studio", "mini"]);
}

#[test]
fn an_unsampled_host_does_not_hold_the_ranking_open_for_long() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    let mut unsampled = hosts();
    unsampled[1].load = None;
    picker.update(unsampled.clone(), now);
    picker.update(unsampled.clone(), now + Duration::from_secs(6));
    // Settled without beelink's numbers: they no longer reorder the tiles.
    picker.update(hosts(), now + Duration::from_secs(7));
    assert_ne!(names(picker.best())[0], "beelink");
}

#[test]
fn hosts_joining_after_settling_go_last_and_leaving_ones_go() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    picker.update(hosts(), now);
    let mut changed = hosts();
    changed.retain(|c| c.endpoint_id != "studio");
    changed.push(host("monster", 128, 0.));
    picker.update(changed, now);
    assert_eq!(
        names(picker.ranked()),
        ["beelink", "mini", "nuc", "laptop", "farm", "monster"]
    );
}

#[test]
fn one_host_alone_offers_no_choice() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    picker.update(vec![current(host("laptop", 8, 1.)), offline("farm")], now);
    assert!(!picker.offers_choice());
    assert!(Picker::opened("laptop", vec![current(host("laptop", 8, 1.))]).is_none());
}

#[test]
fn lists_open_one_at_a_time() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    picker.toggle(Slot::Dialog);
    assert_eq!(picker.open(), Some(Slot::Dialog));
    picker.toggle(Slot::Lane(2));
    assert_eq!(picker.open(), Some(Slot::Lane(2)));
    picker.toggle(Slot::Lane(2));
    assert_eq!(picker.open(), None);
    picker.toggle(Slot::Dialog);
    picker.update(hosts(), now);
    picker.choose("beelink");
    assert_eq!(picker.open(), None, "choosing closes the list");
}

#[test]
fn spreading_uses_the_settled_scores_and_current_reachability() {
    let now = Instant::now();
    let mut picker = Picker::new("laptop", now);
    picker.update(hosts(), now);
    let spread = picker.spread(4);
    // beelink has 15 cores free, studio 12: a lane costs one.
    assert_eq!(spread, ["beelink", "beelink", "beelink", "beelink"]);
    // A momentary spike after settling does not move lanes.
    let mut spiked = hosts();
    spiked[1].working = 30;
    picker.update(spiked, now);
    assert_eq!(picker.spread(4), spread);
    // A host that went offline takes no lanes.
    let mut dropped = hosts();
    dropped[1].online = false;
    picker.update(dropped, now);
    assert_eq!(picker.spread(2), ["studio", "studio"]);
}
