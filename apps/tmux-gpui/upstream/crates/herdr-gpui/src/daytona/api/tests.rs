use super::*;

fn sandbox(state: &str, reason: Option<&str>) -> Sandbox {
    Sandbox {
        id: "s1".into(),
        name: "herdr-box".into(),
        state: state.into(),
        error_reason: reason.map(str::to_owned),
    }
}

#[test]
fn states_map_to_what_connecting_needs() {
    assert_eq!(sandbox("started", None).readiness(), Readiness::Ready);
    for state in ["stopped", "archived", "paused"] {
        assert_eq!(sandbox(state, None).readiness(), Readiness::Stopped);
    }
    assert_eq!(
        sandbox("pulling_snapshot", None).readiness(),
        Readiness::Pending("pulling snapshot".into())
    );
    assert_eq!(
        sandbox("error", Some("out of quota")).readiness(),
        Readiness::Failed("out of quota".into())
    );
    assert_eq!(
        sandbox("build_failed", None).readiness(),
        Readiness::Failed("build_failed".into())
    );
    assert_eq!(sandbox("destroyed", None).readiness(), Readiness::Deleted);
}

#[test]
fn ids_that_could_change_the_path_are_refused() {
    assert!(segment("4f1c-9a_b").is_ok());
    for id in ["", "../x", "a/b", "a?b", &"a".repeat(129)] {
        assert!(segment(id).is_err(), "{id}");
    }
}
