#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;

const REV: &str = "0123456789abcdef0123456789abcdef";

fn bytes(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn a_whole_small_file_arrives_in_one_page() {
    let reply = parse_file(
        &bytes(
            json!({"version":1,"state":"ok","name":"notes.md","folder":"docs",
            "revision":REV,"size":5,"offset":0,"chunk":STANDARD.encode(b"# Hi\n")}),
        ),
        None,
    )
    .unwrap();
    assert_eq!(reply.name, "notes.md");
    assert_eq!(reply.folder, "docs");
    let ReaderFile::Page(chunk) = reply.file else {
        panic!("page")
    };
    assert_eq!(chunk.bytes, b"# Hi\n");
    assert_eq!(chunk.size, 5);
}

#[test]
fn pages_must_continue_the_requested_revision_at_the_requested_offset() {
    let page = ReaderPage {
        revision: REV.into(),
        offset: READER_PAGE_BYTES,
    };
    let reply = |offset: u64, revision: &str| {
        parse_file(
            &bytes(json!({"version":1,"state":"ok","name":"a.md","folder":"",
                "revision":revision,"size":READER_PAGE_BYTES + 3,"offset":offset,
                "chunk":STANDARD.encode(b"abc")})),
            Some(&page),
        )
    };
    assert!(reply(READER_PAGE_BYTES, REV).is_ok());
    assert!(reply(0, REV).is_err());
    assert!(reply(READER_PAGE_BYTES, &"f".repeat(32)).is_err());
}

#[test]
fn a_short_page_that_is_not_the_last_is_refused() {
    let result = parse_file(
        &bytes(json!({"version":1,"state":"ok","name":"a.md","folder":"d",
            "revision":REV,"size":10,"offset":0,"chunk":STANDARD.encode(b"abc")})),
        None,
    );
    assert!(result.is_err());
}

#[test]
fn file_names_never_carry_a_path_and_unknown_fields_are_refused() {
    for value in [
        json!({"version":1,"state":"missing","name":"docs/a.md","folder":"d"}),
        json!({"version":1,"state":"missing","name":"","folder":"d"}),
        json!({"version":1,"state":"missing","name":"a.md","folder":"a/b"}),
        json!({"version":1,"state":"missing","name":"a.md","folder":"d","path":"/x"}),
        json!({"version":2,"state":"missing","name":"a.md","folder":"d"}),
        json!({"version":1,"state":"weird","name":"a.md","folder":"d"}),
    ] {
        assert!(parse_file(&bytes(value.clone()), None).is_err(), "{value}");
    }
}

#[test]
fn the_other_file_states_parse() {
    let parse = |v| parse_file(&bytes(v), None).unwrap().file;
    assert_eq!(
        parse(json!({"version":1,"state":"unchanged","name":"a.md","folder":"","revision":REV})),
        ReaderFile::Unchanged {
            revision: REV.into()
        }
    );
    assert_eq!(
        parse(
            json!({"version":1,"state":"too_large","name":"a.md","folder":"",
            "revision":REV,"size":READER_MAX_BYTES + 1})
        ),
        ReaderFile::TooLarge {
            size: READER_MAX_BYTES + 1
        }
    );
    assert_eq!(
        parse(json!({"version":1,"state":"missing","name":"a.md","folder":""})),
        ReaderFile::Missing
    );
    assert_eq!(
        parse(json!({"version":1,"state":"changed","name":"a.md","folder":""})),
        ReaderFile::Changed
    );
}

#[test]
fn assets_parse_only_the_image_types_the_daemon_allows() {
    let ok = |mime: &str| {
        parse_asset(
            &bytes(json!({"version":1,"state":"ok","mime":mime,"revision":REV,
                "size":3,"offset":0,"chunk":STANDARD.encode(b"abc")})),
            None,
        )
    };
    assert!(matches!(
        ok("image/png").unwrap(),
        ReaderAsset::Page {
            mime: ImageMime::Png,
            ..
        }
    ));
    assert!(ok("text/html").is_err());
    assert!(ok("image/svg+xml").is_ok());
    for state in ["refused", "missing", "too_large", "changed"] {
        assert!(parse_asset(&bytes(json!({"version":1,"state":state})), None).is_ok());
    }
    assert!(
        parse_asset(
            &bytes(
                json!({"version":1,"state":"ok","mime":"image/png","revision":REV,
                "size":READER_ASSET_MAX_BYTES + 1,"offset":0,"chunk":""})
            ),
            None
        )
        .is_err()
    );
}

/// #756 review round 1 (R17, R18, R20, R22, R23): a hostile remote daemon's
/// page checks, each on its own.
#[test]
fn a_hostile_daemons_pages_are_refused() {
    let ok = |size: u64, offset: u64, chunk: Vec<u8>| {
        bytes(json!({"version":1,"state":"ok","name":"a.md","folder":"",
            "revision":REV,"size":size,"offset":offset,"chunk":STANDARD.encode(chunk)}))
    };
    // R17: larger than the reader takes, even as a last page that fits.
    let big = READER_MAX_BYTES + 3;
    let tail = ReaderPage {
        revision: REV.into(),
        offset: big - 3,
    };
    assert!(parse_file(&ok(big, big - 3, b"abc".to_vec()), Some(&tail)).is_err());
    // R18: a first page that starts anywhere but 0, though it ends the file.
    assert!(parse_file(&ok(6, 3, b"abc".to_vec()), None).is_err());
    // R20: a full page that runs past the declared size.
    let page = vec![b'x'; READER_PAGE_BYTES as usize];
    assert!(parse_file(&ok(10, 0, page), None).is_err());
    // R22: an answer over the 1 MiB read limit, valid JSON or not.
    let mut padded = bytes(json!({"version":1,"state":"missing","name":"a.md","folder":""}));
    padded.extend(std::iter::repeat_n(b' ', 1024 * 1024));
    assert!(parse_file(&padded, None).is_err());
    // R23: "too large" for a size the reader would take.
    assert!(
        parse_file(
            &bytes(
                json!({"version":1,"state":"too_large","name":"a.md","folder":"",
                "revision":REV,"size":READER_MAX_BYTES})
            ),
            None
        )
        .is_err()
    );
    // The same checks hold for pictures.
    assert!(
        parse_asset(
            &bytes(
                json!({"version":1,"state":"ok","mime":"image/png","revision":REV,
                "size":6,"offset":3,"chunk":STANDARD.encode(b"abc")})
            ),
            None
        )
        .is_err()
    );
}
