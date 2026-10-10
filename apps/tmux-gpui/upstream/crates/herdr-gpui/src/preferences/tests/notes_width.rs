//! The notes panel's width is remembered with the rest of the chrome.
use super::*;

#[core::prelude::v1::test]
fn the_notes_width_round_trips_and_a_damaged_one_is_forgotten() {
    let directory = TestDirectory::new();
    let path = directory.0.join("preferences.json");
    let chrome = Chrome {
        notes_width: Some(420.),
        review_files_width: Some(280.),
        ..Chrome::default()
    };
    write_chrome(&path, chrome).unwrap();
    assert_eq!(read_chrome(&path).unwrap(), chrome);
    // A bad width loses only itself, never the sidebar's.
    for damaged in [r#""wide""#, "-5", "0", "null"] {
        fs::write(
            &path,
            format!(r#"{{"sidebar_width_px": 250, "notes_width_px": {damaged}}}"#),
        )
        .unwrap();
        let read = read_chrome(&path).unwrap();
        assert_eq!(read.notes_width, None, "{damaged}");
        assert_eq!(read.sidebar_width, Some(250.), "{damaged}");
    }
}
