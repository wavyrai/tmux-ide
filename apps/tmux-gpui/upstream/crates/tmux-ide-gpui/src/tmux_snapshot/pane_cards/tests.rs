use super::*;
fn panes() -> Vec<Region> {
    vec![
        Region {
            id: "left".into(),
            left: 0,
            top: 0,
            width: 40,
            height: 25,
        },
        Region {
            id: "top".into(),
            left: 41,
            top: 0,
            width: 39,
            height: 12,
        },
        Region {
            id: "bottom".into(),
            left: 41,
            top: 13,
            width: 39,
            height: 12,
        },
    ]
}
#[test]
fn cards_reserve_chrome_without_losing_terminal_cells() {
    let layout = Layout::new(&panes(), 8., 20.);
    let cards: Vec<_> = layout.regions.iter().map(|r| layout.card(r)).collect();
    assert_eq!(cards[1].left() - cards[0].right(), px(GAP));
    assert_eq!(cards[2].top() - cards[1].bottom(), px(GAP));
    assert_eq!(cards[0].bottom(), cards[2].bottom());
    for r in &layout.regions {
        let content = layout.content(r);
        let card = layout.card(r);
        assert!(content.left() >= card.left() + px(PAD));
        assert!(content.bottom() <= card.bottom() - px(V_PAD));
        for (col, row) in [
            (r.left, r.top),
            (r.left + r.width - 1, r.top + r.height - 1),
        ] {
            let pixel = layout.cursor(col, row) + point(px(4.), px(10.));
            assert_eq!(
                layout.logical(pixel),
                Some(point(
                    px(f32::from(col) * 8. + 4.),
                    px(f32::from(row) * 20. + 10.)
                ))
            );
        }
        assert!(
            layout
                .logical(card.origin + point(px(5.), px(5.)))
                .is_none()
        );
    }
}

#[test]
fn native_terminal_border_row_is_not_a_second_card_header() {
    let outer = vec![Region {
        id: "browser".into(),
        left: 0,
        top: 0,
        width: 80,
        height: 25,
    }];
    let content = vec![Region {
        top: 1,
        height: 24,
        ..outer[0].clone()
    }];
    let layout = Layout::new(&outer, 8., 20.).with_content(&content);
    let region = &layout.regions[0];
    assert_eq!(layout.card(region).top(), px(0.));
    assert_eq!(layout.content(region).top(), px(HEADER + V_PAD));
    assert_eq!(layout.content(region).size.height, px(24. * 20.));
    assert_eq!(layout.overhead().height, px(HEADER + 2. * V_PAD - 20.));
    assert_eq!(
        layout.logical(layout.cursor(0, 1)),
        Some(point(px(0.), px(20.)))
    );
    assert_eq!(
        layout.cursor(79, 24).y + px(20.),
        layout.content(region).bottom()
    );
}

#[test]
fn native_content_keeps_gutters_and_reflows_without_restoring_the_border_row() {
    let outer = panes();
    let content: Vec<_> = outer
        .iter()
        .map(|r| {
            let mut r = r.clone();
            if r.top == 0 {
                r.top += 1;
                r.height -= 1;
            }
            r
        })
        .collect();
    let layout = Layout::new(&outer, 8., 20.).with_content(&content);
    let cards: Vec<_> = layout.regions.iter().map(|r| layout.card(r)).collect();
    assert_eq!(cards[1].left() - cards[0].right(), px(GAP));
    assert_eq!(cards[2].top() - cards[1].bottom(), px(GAP));
    assert_eq!(cards[0].bottom(), cards[2].bottom());
    let mut resized = outer;
    resized[1].height += 2;
    resized[2].top += 2;
    resized[2].height -= 2;
    let preview = layout.reflow(&resized);
    assert_eq!(preview.regions[0].top, 1);
    assert_eq!(preview.card(&preview.regions[0]).top(), px(0.));
    assert_eq!(
        preview.card(&preview.regions[2]).top() - preview.card(&preview.regions[1]).bottom(),
        px(GAP)
    );
    assert_eq!(
        preview.card(&preview.regions[0]).bottom(),
        preview.card(&preview.regions[2]).bottom()
    );
}
