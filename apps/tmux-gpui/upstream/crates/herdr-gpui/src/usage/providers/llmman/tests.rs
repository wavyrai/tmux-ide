use super::*;

/// CodexBar's fixture: 8 GB + 2 GB loaded of 40 GB model memory.
const NODE: &str = r#"{"memory":40000000000,
        "loaded":{"fixture/small:Q4_K_M":2000000000,"fixture/large:Q4_K_M":8000000000},
        "stored":{"fixture/small:Q4_K_M":2000000000,"fixture/large:Q4_K_M":8000000000,"fixture/idle":500000000}}"#;

fn facts(report: &Report, index: usize) -> (&str, Vec<(&str, &str)>) {
    match &report.sections[index] {
        Section::Facts { title, facts } => (
            title.as_str(),
            facts
                .iter()
                .map(|(label, value)| (label.as_str(), value.as_str()))
                .collect(),
        ),
        section => panic!("unexpected section {section:?}"),
    }
}

#[test]
fn loaded_weights_fill_the_memory_window_largest_first() {
    let report = parse(NODE, true, Some("0.9.0".into())).unwrap();
    assert_eq!(report.windows.len(), 1);
    assert_eq!(report.windows[0].kind, Kind::Named("Memory".into()));
    assert_eq!(report.windows[0].percent(), 25);
    assert_eq!(report.windows[0].resets_at, None);
    assert_eq!(report.account.plan.as_deref(), Some("API key"));
    assert_eq!(
        facts(&report, 0),
        (
            "Daemon",
            vec![
                ("Loaded", "2 · 10.0 GB"),
                ("Stored", "3 · 10.5 GB"),
                ("Memory", "10.0 GB of 40.0 GB"),
                ("Version", "0.9.0"),
            ]
        )
    );
    assert_eq!(
        facts(&report, 1),
        (
            "Loaded models",
            vec![
                ("fixture/large:Q4_K_M", "8.0 GB"),
                ("fixture/small:Q4_K_M", "2.0 GB"),
            ]
        )
    );
}

#[test]
fn an_idle_open_daemon_still_reports() {
    let report = parse(r#"{"memory":0,"loaded":{},"stored":{}}"#, false, None).unwrap();
    assert!(report.windows.is_empty());
    assert_eq!(report.account.plan.as_deref(), Some("Local daemon"));
    assert_eq!(report.sections.len(), 1);
    assert_eq!(
        facts(&report, 0).1,
        [("Loaded", "0 · 0 B"), ("Stored", "0 · 0 B")]
    );
}

#[test]
fn malformed_node_reports_are_rejected() {
    for body in [
        "not json",
        "[]",
        r#"{"memory":-1,"loaded":{},"stored":{}}"#,
        r#"{"memory":1,"loaded":[],"stored":{}}"#,
        r#"{"memory":1,"loaded":{"a":"1"},"stored":{}}"#,
        r#"{"memory":1,"loaded":{}}"#,
    ] {
        assert!(
            matches!(parse(body, false, None), Err(Error::UsageJson(_))),
            "accepted {body}"
        );
    }
}

#[test]
fn sizes_use_decimal_units() {
    assert_eq!(size(999), "999 B");
    assert_eq!(size(1_500), "1.5 kB");
    assert_eq!(size(2_000_000), "2.0 MB");
    assert_eq!(size(10_500_000_000), "10.5 GB");
}

#[test]
fn addresses_normalize_as_llmman_does() {
    for (address, base, loopback) in [
        ("localhost", "http://localhost:17434", true),
        ("127.0.0.1", "http://127.0.0.1:17434", true),
        ("0.0.0.0", "http://127.0.0.1:17434", true),
        ("0.0.0.0:18000", "http://127.0.0.1:18000", true),
        ("http://0.0.0.0:18000", "http://127.0.0.1:18000", true),
        ("192.168.1.10", "http://192.168.1.10:17434", false),
        ("daemon.local", "http://daemon.local:17434", false),
        ("[::1]", "http://[::1]:17434", true),
        ("127.0.0.1:18000", "http://127.0.0.1:18000", true),
        ("http://localhost", "http://localhost", true),
        (
            "https://llmman.example.com",
            "https://llmman.example.com",
            false,
        ),
        ("http://127.0.0.1:17434///", "http://127.0.0.1:17434", true),
        ("http://127.0.0.1:17434/v1/", "http://127.0.0.1:17434", true),
    ] {
        let daemon = daemon(Some(address)).expect(address);
        assert_eq!(daemon.base, base, "{address}");
        assert_eq!(daemon.loopback, loopback, "{address}");
    }
    let default = daemon(None).unwrap();
    assert_eq!(default.base, DEFAULT);
    assert!(default.loopback);
    assert_eq!(daemon(Some("  ")).unwrap().base, DEFAULT);
}

#[test]
fn a_local_key_follows_only_a_configured_remote_address() {
    let lan = daemon(Some("192.168.1.20")).unwrap();
    let local = daemon(None).unwrap();
    assert!(local_key_allowed(false, Source::Host, &local));
    assert!(local_key_allowed(false, Source::Host, &lan));
    assert!(local_key_allowed(true, Source::Config, &lan));
    assert!(!local_key_allowed(true, Source::Config, &local));
    assert!(!local_key_allowed(true, Source::Host, &lan));
    assert!(!local_key_allowed(true, Source::Host, &local));
}

#[test]
fn unsafe_addresses_are_refused() {
    for address in [
        "http://127.0.0.1:17434?probe=1",
        "http://127.0.0.1:17434#x",
        "localhost?probe=1",
        "127.0.0.1#x",
        "http://127.0.0.1:17434?",
        "http://127.0.0.1:17434#",
        "http://public.example.com",
        "public.example.com",
        "http://user:password@127.0.0.1:17434",
        "https://user:password@example.com",
        "file:///tmp/llmman",
    ] {
        assert!(daemon(Some(address)).is_none(), "accepted {address}");
    }
}
