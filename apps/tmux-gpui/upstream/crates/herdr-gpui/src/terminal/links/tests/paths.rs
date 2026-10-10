use super::*;

/// What the detector reads in a one-row frame at `column`.
fn read(text: &str, column: u16) -> Option<RowLink> {
    frame_link(&frame(text, 60, 1), column, 0, 0, 60)
}

fn path(text: &str, column: u16) -> Option<(String, Range<u16>)> {
    read(text, column).and_then(|link| match link.target {
        RowTarget::Path(path) => Some((path, link.columns)),
        RowTarget::Web(_) => None,
    })
}

#[test]
fn printed_paths_read_whole_with_their_location_underlined() {
    for (text, column, expected, columns) in [
        ("error: src/main.rs:12:5: oops", 9, "src/main.rs", 7..23),
        ("File \"/abs/file.py\", line 3", 8, "/abs/file.py", 6..18),
        ("see ~/notes/todo.md. next", 6, "~/notes/todo.md", 4..19),
        ("(./build/out) ok", 3, "./build/out", 1..12),
        ("--> main.rs:3", 5, "main.rs", 4..13),
        ("modified:   crates/a/b.rs", 20, "crates/a/b.rs", 12..25),
        ("ls src/ now", 4, "src/", 3..7),
    ] {
        assert_eq!(
            path(text, column),
            Some((expected.into(), columns)),
            "{text}"
        );
    }
}

#[test]
fn words_that_only_resemble_paths_are_not_links() {
    for (text, column) in [
        ("README.md is here", 2),
        ("version v1.2 out", 9),
        ("cd ~user/x", 5),
        ("cd ../ now", 4),
        ("scp host:/path now", 6),
        ("a src/a.rs. b", 10),
        ("a src/a.rs b", 1),
    ] {
        assert!(read(text, column).is_none(), "{text}");
    }
    // A URL stays a web link, never a path.
    assert_eq!(
        read("go https://example.com/a/b now", 5).map(|link| link.target),
        Some(RowTarget::Web("https://example.com/a/b".into()))
    );
}

#[test]
fn paths_are_pane_links_only_and_never_web_links() {
    let s = surface("open src/lib.rs:4 now");
    assert!(link_at(&s, 61., 1., 10., 20.).is_none());
    let link = pane_link_at(&s, 61., 1., 10., 20.).unwrap();
    assert_eq!(link.pane_id, "pane");
    assert_eq!(link.link.target, RowTarget::Path("src/lib.rs".into()));
    assert_eq!((link.link.row, link.link.columns), (0, 5..17));
}

#[test]
fn paths_that_may_wrap_are_not_guessed() {
    // Running to the right edge, the path may continue on the next row.
    assert!(frame_link(&frame("ab src/long/path", 16, 1), 5, 0, 0, 16).is_none());
    // Starting a row under a full one, it may be the tail of that row.
    let wrapped = frame("https://example.com/src/a.rs", 20, 2);
    assert!(frame_link(&wrapped, 2, 1, 0, 20).is_none());
    let mut separate = frame("first line ends here", 20, 2);
    separate.cells[19].symbol = " ".into();
    for (cell, symbol) in separate.cells[20..].iter_mut().zip("src/a.rs".chars()) {
        cell.symbol = symbol.to_string();
    }
    assert_eq!(
        frame_link(&separate, 2, 1, 0, 20).map(|link| link.target),
        Some(RowTarget::Path("src/a.rs".into()))
    );
}

#[test]
fn wide_characters_before_a_path_keep_its_columns() {
    let mut wide = frame("界 src/a.rs", 20, 1);
    wide.cells.insert(
        1,
        CellData {
            skip: true,
            ..wide.cells[0].clone()
        },
    );
    wide.cells.pop();
    assert_eq!(
        frame_link(&wide, 4, 0, 0, 20).map(|link| link.columns),
        Some(3..11)
    );
}

// Windows file URLs name drive paths, which these Unix fixtures do not.
#[cfg(unix)]
#[test]
fn file_hyperlinks_name_local_paths_only() {
    let mut s = surface("report");
    s.frame.cells[0].hyperlink = Some(0);
    for (destination, expected) in [
        ("file:///tmp/a%20b", Some("/tmp/a b")),
        ("file://localhost/tmp/a", Some("/tmp/a")),
        ("file://elsewhere/tmp/a", None),
    ] {
        s.frame.hyperlinks = vec![destination.into()];
        assert_eq!(
            pane_link_at(&s, 1., 1., 10., 20.).map(|link| link.link.target),
            expected.map(|path| RowTarget::Path(path.into())),
            "{destination}"
        );
        assert!(link_at(&s, 1., 1., 10., 20.).is_none());
    }
}
