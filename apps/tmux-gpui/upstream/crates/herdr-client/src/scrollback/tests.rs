use super::*;
use serde_json::json;

fn point(row: u32, col: u16) -> TextPoint {
    TextPoint { row, col }
}

#[test]
fn params_serialize_as_the_daemon_schema() {
    let mut params = CopySearchParams {
        pane_id: "w1:p1".into(),
        query: "needle".into(),
        direction: SearchDirection::Backward,
        cursor: point(40, 0),
        content_revision: 8,
        previous: None,
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({
            "pane_id": "w1:p1",
            "query": "needle",
            "direction": "backward",
            "cursor": {"row": 40, "col": 0},
            "content_revision": 8,
        })
    );
    params.direction = SearchDirection::Forward;
    params.previous = Some(TextRange {
        start: point(3, 4),
        end: point(3, 9),
    });
    let value = serde_json::to_value(&params).unwrap();
    assert_eq!(value["direction"], "forward");
    assert_eq!(
        value["previous"],
        json!({"start": {"row": 3, "col": 4}, "end": {"row": 3, "col": 9}})
    );
}

#[test]
fn points_order_in_reading_order() {
    assert!(point(1, 70) < point(2, 0));
    assert!(point(2, 0) < point(2, 1));
}

#[test]
fn decodes_a_result_and_its_current_match() {
    let response = json!({
        "id": "gpui-3",
        "result": {
            "type": "pane_copy_search",
            "pane_id": "w1:p1",
            "content_revision": 8,
            "matches": [
                {"start": {"row": 1, "col": 0}, "end": {"row": 1, "col": 5}},
                {"start": {"row": 9, "col": 2}, "end": {"row": 10, "col": 1}},
            ],
            "total": 7,
            "current": 1,
            "current_global": 4,
        }
    });
    let result = decode_copy_search(&response).unwrap();
    assert_eq!(result.total, 7);
    assert_eq!(result.current_global, Some(4));
    assert_eq!(
        result.current_match(),
        Some(TextRange {
            start: point(9, 2),
            end: point(10, 1)
        })
    );

    // No matches: the optional indices are absent on the wire.
    let empty = decode_copy_search(&json!({"id": "x", "result": {
        "type": "pane_copy_search", "pane_id": "p", "content_revision": 2,
        "matches": [], "total": 0,
    }}))
    .unwrap();
    assert_eq!(empty.current_match(), None);
    assert_eq!(empty.current_global, None);
}

#[test]
fn a_current_index_outside_the_window_names_no_match() {
    let result = CopySearchResult {
        pane_id: "p".into(),
        content_revision: 2,
        matches: vec![],
        total: 3,
        current: Some(5),
        current_global: Some(1),
    };
    assert_eq!(result.current_match(), None);
}

#[test]
fn endpoint_errors_keep_their_code_as_a_variant() {
    let error = decode_copy_search(&json!({"id": "x", "error": {
        "code": "stale_content", "message": "pane content changed",
    }}))
    .unwrap_err();
    assert!(matches!(
        error,
        Error::Endpoint {
            code: EndpointErrorCode::StaleContent,
            ..
        }
    ));
    let error = decode_copy_search(&json!({"id": "x", "error": {
        "code": "future_code", "message": "later",
    }}))
    .unwrap_err();
    assert!(matches!(
        &error,
        Error::Endpoint { code: EndpointErrorCode::Other(code), message }
            if code == "future_code" && message == "later"
    ));
    assert_eq!(error.to_string(), "later");
}

#[test]
fn malformed_or_foreign_results_are_schema_errors() {
    assert!(matches!(
        decode_copy_search(&json!({"id": "x", "result": {"type": "pane_selection",
            "pane_id": "p", "text": ""}}))
        .unwrap_err(),
        Error::ResponseType
    ));
    for response in [
        json!({"id": "x", "result": {"type": "pane_future", "pane_id": "p"}}),
        json!({"id": "x", "result": {"type": "pane_copy_search", "pane_id": "p"}}),
        json!({"id": "x", "result": {"type": "pane_copy_search", "pane_id": "p",
            "content_revision": 2, "matches": [{"start": {"row": -1, "col": 0},
            "end": {"row": 0, "col": 0}}], "total": 1}}),
        json!("not an envelope"),
    ] {
        let error = decode_copy_search(&response).unwrap_err();
        assert!(matches!(error, Error::ResponseSchema(_)), "{response}");
        assert!(std::error::Error::source(&error).is_some());
    }
    assert!(matches!(
        decode_copy_search(&json!({"id": "x"})).unwrap_err(),
        Error::ResponseMissingResult
    ));
}

#[test]
fn oversized_queries_are_refused_before_sending() {
    let mut params = CopySearchParams {
        pane_id: "p".into(),
        query: "x".repeat(MAX_SEARCH_QUERY_BYTES),
        direction: SearchDirection::Forward,
        cursor: TextPoint::default(),
        content_revision: 0,
        previous: None,
    };
    params.validate().unwrap();
    params.query.push('x');
    assert!(matches!(
        params.validate().unwrap_err(),
        Error::Endpoint {
            code: EndpointErrorCode::QueryTooLarge,
            ..
        }
    ));
}

#[test]
fn motion_and_selection_params_serialize_as_the_daemon_schema() {
    let motion = CopyMotionParams {
        pane_id: "p".into(),
        cursor: point(4, 2),
        motion: CopyMotion::PreviousBigWordStart,
        content_revision: Some(6),
    };
    assert_eq!(
        serde_json::to_value(&motion).unwrap(),
        json!({"pane_id": "p", "cursor": {"row": 4, "col": 2},
            "motion": "previous_big_word_start", "content_revision": 6})
    );
    let read = SelectionReadParams {
        pane_id: "p".into(),
        anchor: point(1, 0),
        cursor: point(9, 79),
        content_revision: None,
    };
    assert_eq!(
        serde_json::to_value(&read).unwrap(),
        json!({"pane_id": "p", "anchor": {"row": 1, "col": 0},
            "cursor": {"row": 9, "col": 79}})
    );
    for (motion, name) in [
        (CopyMotion::LineEnd, "line_end"),
        (CopyMotion::FirstNonBlank, "first_non_blank"),
        (CopyMotion::NextWordStart, "next_word_start"),
        (CopyMotion::PreviousWordStart, "previous_word_start"),
        (CopyMotion::NextWordEnd, "next_word_end"),
        (CopyMotion::NextBigWordStart, "next_big_word_start"),
        (CopyMotion::NextBigWordEnd, "next_big_word_end"),
        (CopyMotion::PreviousParagraph, "previous_paragraph"),
        (CopyMotion::NextParagraph, "next_paragraph"),
    ] {
        assert_eq!(serde_json::to_value(motion).unwrap(), json!(name));
    }
}

#[test]
fn every_scrollback_result_decodes_by_its_tag() {
    let decoded = |result: Value| decode_response(&json!({"id": "x", "result": result}));
    assert_eq!(
        decoded(json!({"type": "pane_copy_motion", "pane_id": "p",
            "cursor": {"row": 3, "col": 7}, "content_revision": 4}))
        .unwrap(),
        ScrollbackResponse::PaneCopyMotion(CopyMotionResult {
            pane_id: "p".into(),
            cursor: point(3, 7),
            content_revision: 4,
        })
    );
    assert_eq!(
        decoded(json!({"type": "pane_selection", "pane_id": "p", "text": "a\nb"})).unwrap(),
        ScrollbackResponse::PaneSelection(SelectionResult {
            pane_id: "p".into(),
            text: "a\nb".into(),
        })
    );
    assert_eq!(
        decoded(json!({"type": "ok"})).unwrap(),
        ScrollbackResponse::Ok {}
    );
    assert!(matches!(
        decoded(json!({"type": "pane_copy_motion", "pane_id": "p"})).unwrap_err(),
        Error::ResponseSchema(_)
    ));
}
