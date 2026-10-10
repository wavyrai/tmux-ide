use super::*;

fn update(wsl: &[&str], selection: Option<Option<&str>>) -> CatalogUpdate {
    CatalogUpdate {
        hosts: vec![host("a", true)],
        wsl: wsl
            .iter()
            .map(|distro| WslHost {
                distro: (*distro).into(),
                session: "default".into(),
            })
            .collect(),
        selection: selection.map(|id| id.map(str::to_owned)),
        #[cfg(feature = "cloud")]
        cloud: None,
    }
}

#[test]
fn a_saved_distribution_is_restored_like_a_saved_host() {
    let mut catalog = Catalog::new(&ConnectTarget::Local);
    catalog.accept(&update(&["Ubuntu"], Some(Some("wsl:Ubuntu"))));
    assert_eq!(catalog.desired.as_deref(), Some("wsl:Ubuntu"));
    assert!(catalog.restore_pending);
    // Forgetting the distribution cancels the restore, as removing a host does.
    catalog.accept(&update(&[], None));
    assert_eq!(catalog.desired, None);
    assert!(!catalog.restore_pending);
}

#[test]
fn only_saved_devices_are_offered() {
    let offered = update(&["Ubuntu"], None);
    assert!(offered.offers("wsl:Ubuntu"));
    assert!(offered.offers("ssh:a"));
    for id in ["wsl:Debian", "wsl:", "ssh:b", LOCAL, "Ubuntu"] {
        assert!(!offered.offers(id), "{id}");
    }
}

#[test]
fn choosing_a_distribution_queues_its_endpoint_id() {
    let mut catalog = Catalog::new(&ConnectTarget::Local);
    catalog.choose("wsl:Ubuntu");
    assert_eq!(catalog.desired.as_deref(), Some("wsl:Ubuntu"));
    assert_eq!(catalog.queued_write, Some(Some("wsl:Ubuntu".into())));
    catalog.choose(LOCAL);
    assert_eq!(catalog.queued_write, Some(None));
}
