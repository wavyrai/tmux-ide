use super::*;

mod menus;
mod panels;
mod sidebar_rows;
mod status;

#[gpui::test]
fn sidebar_allocates_text_width(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        // Deliberately do not call HerdrWindow::new: it connects and starts polling.
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let result = check_sidebar(fixture, cx);
    assert!(result.is_ok(), "sidebar layout failed: {result:#?}");
}

#[cfg(test)]
fn check_sidebar(fixture: Entity<SidebarFixture>, cx: &mut gpui::VisualTestContext) -> Result<()> {
    sidebar_rows::check_text_allocation(cx);
    sidebar_rows::check_row_geometry(cx);
    sidebar_rows::check_sidebar_resize(&fixture, cx);

    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    let before = sidebar_rows::check_collapse_toggle(&view, cx);
    panels::check_keybinds_panel(&view, cx);
    let parent = menus::check_workspace_menu_rows(&view, &before, cx);
    menus::check_pr_menu(&view, cx);
    menus::check_menu_anchor(&view, cx);
    menus::check_rename_dialog(&view, parent, cx);

    sidebar_rows::check_scaled_sidebar(&view, cx);
    panels::check_shortcut_search(&view, cx);
    panels::check_preferences_scroll(&view, cx);
    panels::check_github_panel(&view, cx);
    panels::check_theme_picker(&view, cx);
    panels::check_command_palette(&view, cx);
    panels::check_close_confirmation(&view, cx);

    let before_install = panels::check_install_modal(&view, cx);
    panels::check_app_update(&view, &before_install, cx)?;
    status::check_status_bar(&view, cx)?;
    cx.update(|_, cx| cx.default_global::<PaintedProbes>().check())
}
