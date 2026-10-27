#![allow(clippy::unwrap_used)]
use super::*;
use crate::browser::{Scope, TabId, WebUrl};

fn tab() -> Tab {
    Tab {
        id: TabId::test(0),
        scope: Scope::endpoint("local"),
        workspace_id: "w_1".into(),
        location: Some(Location::Web {
            url: WebUrl::try_from("http://localhost:3000/").unwrap(),
        }),
        title: "Mockup".into(),
        origin: Some("w_1:p1".into()),
    }
}

#[test]
fn picks_are_parsed_bounded_and_cleaned() {
    let picked = Report::parse(concat!(
        r#"{"kind":"pick","target":{"kind":"element","selector":"body > main:nth-of-type(1)","#,
        r#""tag":"MAIN","text":"Hello\n\n  world\u001b[201~","html":"<main>\u202e</main>","#,
        r#""rect":{"x":1,"y":2,"width":30,"height":40}}}"#
    ))
    .unwrap();
    assert_eq!(
        picked,
        Report::Picked {
            anchor: Anchor::Element {
                selector: "body > main:nth-of-type(1)".into(),
                tag: "main".into(),
                text: "Hello world [201~".into(),
                html: "<main></main>".into(),
            },
            shot: Some(Rect {
                x: 1.,
                y: 2.,
                width: 30.,
                height: 40.
            }),
        }
    );
    assert_eq!(
        Report::parse(r#"{"kind":"cancel"}"#),
        Some(Report::Cancelled)
    );
    let long = format!(
        r#"{{"kind":"pick","target":{{"kind":"selection","selector":"p","tag":"<script>","quote":"{}"}}}}"#,
        "q".repeat(5000)
    );
    let Some(Report::Picked {
        anchor: Anchor::Selection { quote, tag, .. },
        shot: None,
    }) = Report::parse(&long)
    else {
        panic!("selection");
    };
    assert_eq!(quote.chars().count(), 1001);
    assert_eq!(tag, "script");
    for invalid in [
        "",
        "not json",
        r#"{"kind":"pick"}"#,
        r#"{"kind":"eval","code":"x"}"#,
        // A rectangle must be real: finite, positive, and bounded.
        r#"{"kind":"pick","target":{"kind":"element","selector":"a","tag":"a","text":"","html":"","rect":{"x":1,"y":1,"width":0,"height":5}}}"#,
        r#"{"kind":"pick","target":{"kind":"element","selector":"a","tag":"a","text":"","html":"","rect":{"x":1e308,"y":1,"width":5,"height":5}}}"#,
        &"x".repeat(MAX_MESSAGE_BYTES + 1),
    ] {
        assert!(Report::parse(invalid).is_none(), "{invalid:.60}");
    }
}

#[test]
fn regions_are_placed_on_the_page_and_list_what_they_cover() {
    let covers: Vec<_> = (0..12)
        .map(|index| {
            serde_json::json!({ "selector": format!("#c{index}"), "tag": "DIV", "text": "card\n text" })
        })
        .collect();
    let body = serde_json::json!({
        "kind": "pick",
        "target": {
            "kind": "region",
            "rect": { "x": 10, "y": 20, "width": 300, "height": 120 },
            "scroll": { "x": 0, "y": 640 },
            "viewport": { "width": 1280, "height": 800 },
            "container": "#pricing",
            "covers": covers,
            "text": "Pro plan"
        }
    });
    let Some(Report::Picked { anchor, shot }) = Report::parse(&body.to_string()) else {
        panic!("region");
    };
    assert_eq!(
        shot,
        Some(Rect {
            x: 10.,
            y: 20.,
            width: 300.,
            height: 120.
        })
    );
    let Anchor::Region {
        rect,
        covers,
        container,
        ..
    } = &anchor
    else {
        panic!("region anchor");
    };
    assert_eq!((rect.x, rect.y), (10., 660.));
    assert_eq!(covers.len(), MAX_COVERED);
    assert_eq!(covers[0].text, "card text");
    assert_eq!(container, "#pricing");
    let note = Note::new(anchor, "Tighten this").unwrap();
    let text = prompt(
        &tab(),
        &[note],
        &[Some(PathBuf::from("/tmp/shot-1.png"))],
        "reload",
    );
    assert!(text.contains(
        "\n1. On a region the user drew: 300\u{00d7}120 px at (10, 660) on the page, in a 1280\u{00d7}800 view\n"
    ));
    assert!(text.contains("   Inside: `#pricing`\n"));
    assert!(text.contains("   Covers: <div> at `#c0` \"card text\"\n"));
    assert!(text.contains(
        "   Text: \"Pro plan\"\n   Screenshot: /tmp/shot-1.png\n   Note: Tighten this\n"
    ));
    assert!(text.contains("Screenshots show each part"));
}

#[test]
fn the_prompt_names_the_page_and_quotes_each_note() {
    let notes = [
        Note::new(
            Anchor::Element {
                selector: "#save".into(),
                tag: "button".into(),
                text: "Save".into(),
                html: "<button id=\"save\">Save ```x```</button>".into(),
            },
            "Make it primary",
        )
        .unwrap(),
        Note::new(
            Anchor::Selection {
                selector: "p:nth-of-type(2)".into(),
                tag: "p".into(),
                quote: "lorem".into(),
            },
            "Rewrite\nthis",
        )
        .unwrap(),
        Note::new(Anchor::Page, "Use dark mode").unwrap(),
    ];
    let text = prompt(&tab(), &notes, &[], "herdr-gpui browser reload");
    assert!(
        text.starts_with(
            "Feedback on the page you showed me in Herdr GPUI: http://localhost:3000/\n"
        )
    );
    assert!(!text.contains("Screenshots show"));
    assert!(text.contains("\n1. On <button> at `#save`\n   Text: \"Save\"\n"));
    // The fence outgrows the snippet's own backticks.
    assert!(text.contains("   ````html\n   <button id=\"save\">Save ```x```</button>\n   ````\n"));
    assert!(text.contains("   Note: Make it primary\n"));
    assert!(text.contains(
        "\n2. On the selected text \"lorem\" in <p> at `p:nth-of-type(2)`\n   Note: Rewrite this\n"
    ));
    assert!(text.contains("\n3. On the page as a whole\n   Note: Use dark mode\n"));
    assert!(text.ends_with("then show it again with: herdr-gpui browser reload\n"));
    assert!(!text.chars().any(|c| c.is_control() && c != '\n'));
}

#[test]
fn empty_notes_are_refused_and_markers_are_json_data() {
    assert!(Note::new(Anchor::Page, " \n ").is_none());
    let notes = [
        Note::new(
            Anchor::Element {
                selector: "a[title=\"x'); alert(1)//\"]".into(),
                tag: "a".into(),
                text: String::new(),
                html: String::new(),
            },
            "Fix",
        )
        .unwrap(),
        Note::new(Anchor::Page, "Whole").unwrap(),
        Note::new(
            Anchor::Region {
                rect: Rect {
                    x: 1.,
                    y: 2.,
                    width: 3.,
                    height: 4.,
                },
                viewport: (100., 100.),
                container: String::new(),
                covers: Vec::new(),
                text: String::new(),
            },
            "Here",
        )
        .unwrap(),
    ];
    let script = arm_script(&notes);
    assert!(script.starts_with("// Herdr GPUI's annotation picker."));
    // The markers are the call's one argument, as JSON data.
    let markers = script
        .strip_prefix(SCRIPT)
        .and_then(|call| call.strip_prefix('('))
        .and_then(|call| call.strip_suffix(");"))
        .unwrap();
    let markers: serde_json::Value = serde_json::from_str(markers).unwrap();
    assert_eq!(
        markers,
        serde_json::json!([
            { "number": 1, "selector": "a[title=\"x'); alert(1)//\"]" },
            { "number": 3, "rect": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 } },
        ])
    );
}
