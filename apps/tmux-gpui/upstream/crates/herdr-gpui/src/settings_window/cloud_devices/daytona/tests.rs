#![allow(clippy::unwrap_used)]
use super::{
    super::super::{Section, SettingsWindow},
    Account, CloudProvider, DaytonaFields, Key, Overview, SavedDevice,
};
use crate::config::DaytonaConfig;
use gpui::{Entity, TestAppContext, VisualTestContext, px, size};

fn open(cx: &mut TestAppContext) -> (Entity<SettingsWindow>, &mut VisualTestContext) {
    open_with_main(cx).0
}

type Opened<'a> = (
    (Entity<SettingsWindow>, &'a mut VisualTestContext),
    gpui::WindowHandle<crate::HerdrWindow>,
);

fn open_with_main(cx: &mut TestAppContext) -> Opened<'_> {
    let main = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| main.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|window, cx| {
        let view = SettingsWindow::new(weak, cx);
        window.focus(&view.focus, cx);
        view
    });
    // Unconfigured accounts read nothing from disk or the network.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            #[cfg(feature = "coder")]
            {
                view.config.coder = crate::config::CoderConfig::default();
            }
            view.config.daytona = DaytonaConfig::default();
            view.select_section(Section::CloudDevices, window, cx);
        })
    });
    ((view, cx), main)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn choose_daytona(view: &Entity<SettingsWindow>, cx: &mut VisualTestContext) {
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.cloud_tab = CloudProvider::Daytona;
            cx.notify();
        })
    });
}

#[gpui::test]
fn each_provider_has_a_tab_and_daytona_offers_its_cloud_by_default(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    cx.simulate_resize(size(px(960.), px(780.)));
    draw(cx);
    if CloudProvider::ALL.len() > 1 {
        assert!(cx.debug_bounds("cloud-tab-daytona").is_some());
        assert!(
            cx.debug_bounds("cloud-daytona-card").is_none(),
            "one tab at a time"
        );
    }
    choose_daytona(&view, cx);
    draw(cx);
    assert!(cx.debug_bounds("cloud-daytona-card").is_some());
    assert!(cx.debug_bounds("cloud-coder-card").is_none());
    assert!(cx.debug_bounds("cloud-daytona-create").is_some());
    view.read_with(cx, |view, cx| {
        let card = view.daytona_card.as_ref().unwrap();
        assert!(card.job.is_none(), "nothing to check without an account");
        assert!(
            card.install,
            "installing Herdr is offered, and can be turned off"
        );
        assert_eq!(
            card.values(cx),
            DaytonaFields {
                api_url: crate::daytona::DEFAULT_API_URL.into(),
                ..DaytonaFields::default()
            }
        );
        assert!(card.key.read(cx).text().is_empty());
    });
}

#[gpui::test]
fn a_usable_key_lists_devices_within_the_narrowest_width(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    choose_daytona(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.daytona_card.as_mut().unwrap().account = Account::Known(Overview {
                key: Key::Saved,
                sandboxes: Some(Ok(2)),
                devices: (0..2)
                    .map(|index| SavedDevice {
                        provider: CloudProvider::Daytona,
                        id: format!("s{index}"),
                        label: format!("A long sandbox label number {index} that must truncate"),
                        account: "https://app.daytona.io/api".into(),
                        machine: format!("herdr-box-{index}"),
                        session: "default".into(),
                        enabled: true,
                    })
                    .collect(),
            });
        })
    });
    // The settings window's minimum width, tall enough that every card paints.
    cx.simulate_resize(size(px(680.), px(1600.)));
    draw(cx);
    let devices = cx.debug_bounds("cloud-daytona-devices").unwrap();
    assert!(devices.right() <= px(680.));
    assert!(devices.top() >= cx.debug_bounds("cloud-daytona-new").unwrap().bottom());
    for selector in ["cloud-daytona-remove-0", "cloud-daytona-remove-1"] {
        let remove = cx.debug_bounds(selector).unwrap();
        assert!(remove.left() >= devices.left() && remove.right() <= devices.right());
    }
    // Turning the install approval off is the user's choice to make.
    let switch = cx.debug_bounds("cloud-daytona-install").unwrap();
    cx.simulate_click(switch.center(), gpui::Modifiers::none());
    view.read_with(cx, |view, _| {
        assert!(!view.daytona_card.as_ref().unwrap().install)
    });
}

#[gpui::test]
fn a_reloaded_config_updates_untouched_fields_and_keeps_edits(cx: &mut TestAppContext) {
    let (view, cx) = open(cx);
    choose_daytona(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let card = view.daytona_card.as_mut().unwrap();
            card.fields[2].update(cx, |input, cx| input.set_text_selected("eu", cx));
            view.config.daytona = DaytonaConfig {
                api_url: Some("https://daytona.example.com/api".into()),
                target: Some("us".into()),
                ..DaytonaConfig::default()
            };
            view.daytona_config_changed(cx);
        })
    });
    view.read_with(cx, |view, cx| {
        let values = view.daytona_card.as_ref().unwrap().values(cx);
        assert_eq!(values.api_url, "https://daytona.example.com/api");
        assert_eq!(values.target, "eu", "an unsaved edit is kept");
    });
}

#[gpui::test]
fn a_finished_cloud_job_refreshes_the_open_card(cx: &mut TestAppContext) {
    let ((view, cx), main) = open_with_main(cx);
    choose_daytona(&view, cx);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.daytona_card.as_mut().unwrap().account = Account::Known(Overview {
                key: Key::Saved,
                sandboxes: Some(Ok(5)),
                devices: Vec::new(),
            });
        })
    });
    // The job saved a device in the main window, which then notifies.
    cx.update(|_, cx| {
        main.update(cx, |main, _, cx| {
            main.cloud_jobs.finish_for_test();
            cx.notify();
        })
        .unwrap();
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        // Unconfigured here, so reading again resets the stale count.
        let Account::Known(overview) = &view.daytona_card.as_ref().unwrap().account else {
            panic!("the card read its account again");
        };
        assert!(overview.sandboxes.is_none());
    });
}
