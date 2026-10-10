use super::*;

#[gpui::test]
fn large_lists_rank_in_the_background_and_keep_shown_rows_until_done(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_palette(Filter::All, window, cx);
            let mut palette = view.menu.palette.take().unwrap();
            palette.projects.projects = (0..search::INLINE_CANDIDATES)
                .map(|index| projects::Project {
                    path: format!("/projects/p{index}").into(),
                    label: format!("p{index}"),
                })
                .collect();
            let shown = palette.entries.clone();
            view.prepare_palette_entries(&mut palette, None);
            view.menu.palette = Some(palette);
            view.rank_palette(Selection::Keep, cx);
            view.filter_palette("missing", cx);
            view.filter_palette("p511", cx);
            // Rows still index the entries they were ranked from.
            let palette = view.menu.palette.as_ref().unwrap();
            assert!(Arc::ptr_eq(&palette.entries, &shown));
            assert!(palette.match_task.is_some());
            assert!(
                palette
                    .filtered
                    .iter()
                    .all(|hit| hit.index < palette.entries.len())
            );
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let palette = view.menu.palette.as_ref().unwrap();
        assert!(Arc::ptr_eq(&palette.entries, &palette.pending));
        assert!(palette.match_task.is_none());
        let entry = palette.selected_entry().unwrap();
        assert_eq!(entry.label.as_ref(), "p511");
        assert_eq!(palette.filtered[0].highlights.label, vec![0..4]);
    });
}

#[gpui::test]
fn closing_the_palette_drops_an_unfinished_ranking(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_palette(Filter::All, window, cx);
            let mut palette = view.menu.palette.take().unwrap();
            palette.projects.projects = (0..=search::INLINE_CANDIDATES)
                .map(|index| projects::Project {
                    path: format!("/projects/p{index}").into(),
                    label: format!("p{index}"),
                })
                .collect();
            view.prepare_palette_entries(&mut palette, None);
            view.menu.palette = Some(palette);
            view.rank_palette(Selection::Keep, cx);
            view.dismiss_menu(window, cx);
            view.open_palette(Filter::Commands, window, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let palette = view.menu.palette.as_ref().unwrap();
        assert!(palette.projects.projects.is_empty());
        assert!(
            palette
                .filtered
                .iter()
                .all(|hit| !matches!(palette.entries[hit.index].action, Action::Project(_)))
        );
    });
}
