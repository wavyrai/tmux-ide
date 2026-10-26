#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_daemon::LocalDaemon;

#[test]
#[ignore = "requires an explicit isolated installed-package fixture"]
fn owned_managed_install_bootstrap_and_reuse() {
    assert_eq!(
        std::env::var("TMUX_IDE_LOCAL_SETUP_FIXTURE").unwrap(),
        "owned"
    );
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let directory = PathBuf::from(std::env::var_os("TMUX_IDE_DAEMON_INFO_DIR").unwrap());
    let record = directory.join("daemon.json");
    assert!(home.is_absolute() && directory.is_absolute());
    assert!(!record.exists(), "fixture must start without a daemon");
    let installation = resolve_local_setup(&home).unwrap();
    let cancel = AtomicBool::new(false);
    installation.run(&cancel).unwrap();
    let first = LocalDaemon::discover(&record).unwrap();
    assert_eq!(first.product_version(), installation.version());
    let instance = first.instance_id().to_owned();
    installation.run(&cancel).unwrap();
    let second = LocalDaemon::discover(&record).unwrap();
    assert_eq!(second.instance_id(), instance);
    assert_eq!(second.product_version(), installation.version());
}
