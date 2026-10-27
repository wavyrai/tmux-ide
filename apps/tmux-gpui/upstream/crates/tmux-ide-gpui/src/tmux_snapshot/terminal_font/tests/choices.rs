use super::*;
#[test]
fn font_choices_refuse_noops_busy_unready_and_unknown_families() {
    let mut settings = Settings {
        ready: true,
        names: vec!["Current".into(), "Other".into()],
        ..Settings::default()
    };
    settings.config.family = "Current".into();
    assert!(!settings.can_choose(&Choice::Family("Current".into())));
    assert!(!settings.can_choose(&Choice::Family("Missing".into())));
    assert!(settings.can_choose(&Choice::Family("Other".into())));
    settings.config.size = *FONT_SIZE_RANGE.end();
    assert!(!settings.can_choose(&Choice::Size(1)));
    assert!(settings.can_choose(&Choice::Size(-1)));
    settings.config.size = *FONT_SIZE_RANGE.start();
    assert!(!settings.can_choose(&Choice::Size(-1)));
    assert!(settings.can_choose(&Choice::Size(1)));
    assert!(!settings.can_choose(&Choice::Size(2)));
    settings.saving = true;
    assert!(!settings.can_choose(&Choice::Size(1)));
    settings.saving = false;
    settings.ready = false;
    assert!(!settings.can_choose(&Choice::Family("Other".into())));
}
