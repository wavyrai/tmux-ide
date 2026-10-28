#![allow(clippy::unwrap_used)]
use super::{
    super::super::{Section, SettingsWindow},
    Account, CoderConfig, CoderFields, SECRET_VARIABLE, SavedDevice, Session, configured_secret,
};
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};

fn open(cx: &mut TestAppContext) -> (Entity<SettingsWindow>, &mut VisualTestContext) {
    let main = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| main.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|window, cx| {
        let view = SettingsWindow::new(weak, cx);
        window.focus(&view.focus, cx);
        view
    });
    // An unconfigured deployment reads nothing from disk or the network.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.coder = CoderConfig::default();
            view.select_section(Section::CloudDevices, window, cx);
        })
    });
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn an_unconfigured_deployment_offers_its_fields_and_no_account_action(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    cx.simulate_resize(size(px(960.), px(780.)));
    draw(cx);
    assert!(cx.debug_bounds("cloud-coder-card").is_some());
    assert!(cx.debug_bounds("cloud-coder-save").is_some());
    assert!(cx.debug_bounds("cloud-coder-sign-in").is_none());
    assert!(cx.debug_bounds("cloud-coder-sign-out").is_none());
    view.read_with(cx, |view, cx| {
        let cloud = view.coder_card.as_ref().unwrap();
        assert!(cloud.job.is_none(), "nothing to check without a deployment");
        assert_eq!(cloud.values(cx), CoderFields::default());
        assert!(cloud.secret.read(cx).text().is_empty());
    });
}

#[gpui::test]
fn a_signed_in_account_lists_its_devices_within_the_narrowest_window(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let cloud = view.coder_card.as_mut().unwrap();
            cloud.fields[0].update(cx, |input, cx| {
                input.set_text_selected("https://coder.example.com", cx)
            });
            cloud.account = Account::Known(Session::SignedIn {
                user: "fixture-user".into(),
            });
            cloud.secret_saved = true;
            cloud.devices = (0..3)
                .map(|index| SavedDevice {
                    provider: crate::cloud::CloudProvider::Coder,
                    id: format!("w{index}"),
                    label: format!("A long device label number {index} that must truncate"),
                    account: "https://coder.example.com".into(),
                    machine: format!("herdr-box-{index}"),
                    session: "default".into(),
                    enabled: true,
                })
                .collect();
        })
    });
    // The settings window's minimum size.
    cx.simulate_resize(size(px(680.), px(560.)));
    draw(cx);
    let card = cx.debug_bounds("cloud-coder-card").unwrap();
    let devices = cx.debug_bounds("cloud-coder-devices").unwrap();
    assert!(card.right() <= px(680.) && devices.right() <= px(680.));
    assert!(devices.top() >= card.bottom());
    for selector in ["cloud-coder-remove-0", "cloud-coder-remove-2"] {
        let remove = cx.debug_bounds(selector).unwrap();
        assert!(remove.left() >= devices.left() && remove.right() <= devices.right());
    }
    view.read_with(cx, |view, cx| {
        assert_eq!(
            view.coder_card.as_ref().unwrap().values(cx).url,
            "https://coder.example.com"
        );
    });
}

#[test]
fn a_configured_secret_is_named_before_the_saved_one() {
    let mut config = CoderConfig::default();
    if std::env::var_os(SECRET_VARIABLE).is_none() {
        assert_eq!(configured_secret(&config), None);
        config.oauth_client_secret = Some("from-file".into());
        assert!(configured_secret(&config).unwrap().contains("config file"));
    }
}

#[gpui::test]
fn a_reloaded_config_updates_untouched_fields_and_keeps_edits(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let card = view.coder_card.as_mut().unwrap();
            card.fields[3].update(cx, |input, cx| input.set_text_selected("typed-org", cx));
            view.config.coder = CoderConfig {
                url: Some("https://edited.example.com".into()),
                organization: Some("file-org".into()),
                ..CoderConfig::default()
            };
            view.coder_config_changed(cx);
        })
    });
    view.read_with(cx, |view, cx| {
        let values = view.coder_card.as_ref().unwrap().values(cx);
        assert_eq!(
            values.url, "https://edited.example.com",
            "untouched follows the file"
        );
        assert_eq!(values.organization, "typed-org", "an unsaved edit is kept");
    });
}

#[gpui::test]
fn a_finished_cloud_job_does_not_cancel_a_sign_in(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.coder_card.as_mut().unwrap().account = Account::SigningIn;
            view.cloud_jobs_seen = 0;
            let source = view.source.upgrade().unwrap();
            source.update(cx, |source, _| source.cloud_jobs.finish_for_test());
            view.cloud_source_changed(&source, cx);
        })
    });
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.coder_card.as_ref().unwrap().account,
            Account::SigningIn
        );
        assert_eq!(view.cloud_jobs_seen, 1, "the finish is still noted");
    });
}
