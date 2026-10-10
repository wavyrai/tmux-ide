use super::*;

mod form;
mod sources;

fn candidate(source: Source, name: &str, target: &str, hosts: &[&str]) -> Candidate {
    Candidate::new(source, name, target.into(), hosts)
}

#[test]
fn one_machine_reported_by_every_source_is_listed_once() {
    let mut list = Vec::new();
    merge(
        &mut list,
        candidate(
            Source::Bonjour,
            "studio",
            "studio.local",
            &["studio.local.", "192.168.1.20"],
        ),
    );
    merge(
        &mut list,
        candidate(
            Source::Tailscale,
            "studio",
            "studio.tail1.ts.net",
            &["studio.tail1.ts.net", "100.64.0.2"],
        ),
    );
    merge(
        &mut list,
        candidate(Source::SshConfig, "st", "st", &["st", "100.64.0.2"]),
    );
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].target, "st", "the user's own alias wins");
    assert_eq!(list[0].name, "st");
    assert_eq!(
        list[0].sources,
        [Source::SshConfig, Source::Tailscale, Source::Bonjour]
    );
}

#[test]
fn a_less_preferred_source_does_not_replace_the_target() {
    let mut list = Vec::new();
    merge(
        &mut list,
        candidate(
            Source::Tailscale,
            "box",
            "box.tail1.ts.net",
            &["box.tail1.ts.net"],
        ),
    );
    merge(
        &mut list,
        candidate(Source::Bonjour, "box", "box.local", &["box.local"]),
    );
    assert_eq!(list[0].target, "box.tail1.ts.net");
    assert_eq!(list[0].sources, [Source::Tailscale, Source::Bonjour]);
    // A second report of the same machine from the same source keeps the first.
    merge(
        &mut list,
        candidate(
            Source::Tailscale,
            "box-again",
            "box-again.tail1.ts.net",
            &["box.tail1.ts.net"],
        ),
    );
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].target, "box.tail1.ts.net");
}

#[test]
fn a_report_that_links_two_rows_folds_them_into_one() {
    let mut list = Vec::new();
    // SSH config knows the LAN address; Tailscale knows the tailnet name.
    merge(
        &mut list,
        candidate(Source::SshConfig, "lab", "lab", &["192.168.1.5"]).with_alias("lab"),
    );
    merge(
        &mut list,
        candidate(
            Source::Tailscale,
            "lab",
            "lab.tail1.ts.net",
            &["lab.tail1.ts.net", "100.64.0.5"],
        ),
    );
    assert_eq!(list.len(), 2);
    // Bonjour reports the LAN address and the machine's own host name.
    merge(
        &mut list,
        candidate(
            Source::Bonjour,
            "lab",
            "lab.local",
            &["lab.local", "192.168.1.5"],
        ),
    );
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].target, "lab");
    assert_eq!(list[0].sources, Source::ALL);
    for saved in ["lab", "lab.tail1.ts.net", "100.64.0.5", "lab.local"] {
        assert!(list[0].saved_as(saved), "{saved}");
    }
}

#[test]
fn ordinary_dns_names_that_share_a_first_label_stay_apart() {
    let mut list = Vec::new();
    merge(
        &mut list,
        candidate(Source::SshConfig, "work", "work", &["nas.work.example"]).with_alias("work"),
    );
    merge(
        &mut list,
        candidate(Source::SshConfig, "home", "home", &["nas.home.example"]).with_alias("home"),
    );
    merge(
        &mut list,
        candidate(Source::Bonjour, "nas", "nas.local", &["nas.local"]),
    );
    let targets: Vec<&str> = list.iter().map(|s| s.target.as_str()).collect();
    assert_eq!(targets, ["home", "nas.local", "work"]);
    // Saving one of them hides only that one.
    assert!(list[2].saved_as("work"));
    assert!(!list[0].saved_as("work"));
    assert!(!list[1].saved_as("nas.work.example"));
}

#[test]
fn local_names_link_bonjour_magic_dns_and_bare_hosts() {
    let mut list = Vec::new();
    merge(
        &mut list,
        candidate(Source::Bonjour, "studio", "studio.local", &["studio.local"]),
    );
    merge(
        &mut list,
        candidate(
            Source::Tailscale,
            "studio",
            "studio.tail1.ts.net",
            &["studio.tail1.ts.net"],
        ),
    );
    // An alias that connects to the bare host name.
    merge(
        &mut list,
        candidate(Source::SshConfig, "studio", "studio", &["studio"]).with_alias("studio"),
    );
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].target, "studio");
    assert_eq!(list[0].sources, Source::ALL);
}

#[test]
fn different_machines_stay_apart_sorted_by_name() {
    let mut list = Vec::new();
    for name in ["zeta", "Alpha", "mid"] {
        let host = format!("{name}.local");
        merge(
            &mut list,
            candidate(Source::Bonjour, name, &host, &[host.as_str()]),
        );
    }
    let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Alpha", "mid", "zeta"]);
}

#[test]
fn the_list_is_bounded() {
    let mut list = Vec::new();
    for index in 0..MAX_SUGGESTIONS + 10 {
        let host = format!("host{index}.local");
        merge(
            &mut list,
            candidate(Source::Bonjour, &host, &host, &[host.as_str()]),
        );
    }
    assert_eq!(list.len(), MAX_SUGGESTIONS);
}

#[test]
fn a_saved_target_hides_its_machine() {
    let mut list = Vec::new();
    merge(
        &mut list,
        candidate(
            Source::Tailscale,
            "box",
            "box.tail1.ts.net",
            &["box.tail1.ts.net", "100.64.0.9"],
        ),
    );
    let suggestion = &list[0];
    for saved in [
        "box.tail1.ts.net",
        "ssh://me@box.tail1.ts.net:2222",
        "BOX.tail1.ts.net",
        "100.64.0.9",
        "ssh://[100.64.0.9]:22",
    ] {
        assert!(suggestion.saved_as(saved), "{saved}");
    }
    // A bare name may be any alias; `ssh -G` settles it when saving.
    for other in ["box", "me@box", "boxer", "me@other", "100.64.0.10"] {
        assert!(!suggestion.saved_as(other), "{other}");
    }
}

#[test]
fn network_names_are_bounded_display_text() {
    assert_eq!(display_name(" a\u{1b}[31mb\n "), "a[31mb");
    assert_eq!(display_name(&"x".repeat(200)).len(), MAX_NAME);
}

#[test]
fn only_plain_host_names_become_targets() {
    for host in ["studio.local", "box-1", "a_b.example"] {
        assert!(valid_host(host), "{host}");
    }
    for host in ["", "-oProxyCommand=x", ".local", "a b", "a;b", "host$(x)"] {
        assert!(!valid_host(host), "{host}");
    }
}

#[test]
fn source_lists_read_as_prose() {
    use super::render::sources;
    assert_eq!(sources(&[Source::Bonjour]), "Bonjour");
    assert_eq!(
        sources(&[Source::Tailscale, Source::Bonjour]),
        "Tailscale and Bonjour"
    );
    assert_eq!(sources(&Source::ALL), "SSH config, Tailscale, and Bonjour");
}
