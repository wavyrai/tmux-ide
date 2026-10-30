//! The sidebar's Agents section on the type ladder, in the row ink.
use super::super::text_role_tests::{catalog, plates, worst};
use super::*;
use crate::tmux_snapshot::design::{InkProbes, row_ink};
use gpui::Hsla;

fn roster() -> browser::home_agents::WorkspaceRoster {
    serde_json::from_value(serde_json::json!({"sessionId":"session-a","revision":4,"phase":"loading","rows":[{"key":"agent-a","sessionId":"session-a","paneId":"pane-a","name":"Coder","sessionLabel":"Same","status":"WORKING","attention":false,"available":true}],"observedSessions":1,"totalSessions":3,"truncatedSessions":2,"truncatedRows":5,"note":"Two servers did not answer"})).unwrap()
}

const ROLES: [&str; 4] = [
    "sidebar-agents-heading",
    "sidebar-agents-phase",
    "sidebar-agents-note",
    "sidebar-agents-truncated",
];

/// The heading, the phase line, the note and the truncation count are set
/// on the ladder beside the rows, the heading in the row caption ink and the
/// lines in the row label ink, each at 4.5:1 on the frosted sidebar in every
/// catalog variant. The theme's own muted, which the heading painted before,
/// does not reach that on every one.
#[gpui::test]
fn agents_section_text_reads_on_the_frosted_sidebar(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.workspace_agents = Some(roster());
        view
    });
    let mut failures = Vec::new();
    let mut raw_fails = false;
    for (name, appearance) in catalog() {
        let theme = appearance.native();
        view.update(cx, |view, _| {
            view.browser_state.appearance = Some(appearance)
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let (label, muted) = row_ink(&theme);
        let plates = plates(&theme, false);
        raw_fails |= worst(rgb(theme.muted).into(), &plates) < 4.5;
        let probes = cx.update(|_, cx| cx.global::<InkProbes>().0.clone());
        for (key, ink) in ROLES.into_iter().zip([muted, label, label, label]) {
            let ink: Hsla = rgb(ink).into();
            let painted = probes.get(key).copied();
            if painted != Some(ink) {
                failures.push(format!("{name}: {key} painted {painted:?}, not {ink:?}"));
                continue;
            }
            let ratio = worst(ink, &plates);
            if ratio < 4.5 {
                failures.push(format!("{name}: {key} is {ratio:.2}:1"));
            }
        }
    }
    assert!(
        raw_fails,
        "some variant's raw muted must fail, or this proves little"
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The section's lines are the ladder's: the heading at `Subheadline`
/// (the "Sessions" heading's 11pt) and each line at `Callout`, the rows'
/// label size, rather than gpui's 14pt `text_sm`.
#[gpui::test]
fn agents_section_lines_sit_on_the_ladder(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.workspace_agents = Some(roster());
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let section = cx.debug_bounds("tmux-workspace-agents-section").unwrap();
    let row = cx.debug_bounds("tmux-workspace-agent-0").unwrap();
    use bezel_theme::TextStyle;
    let lines = TextStyle::Subheadline.painted_line_height()
        + 3. * TextStyle::Callout.painted_line_height();
    // Four lines and the gaps between them and the first row.
    assert_eq!(row.top() - section.top(), px(lines + 4. * 4.));
}
