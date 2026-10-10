use crate::find::memory::{Left, Memory, Resume};

#[test]
fn a_bar_left_open_comes_back_once_with_its_query() {
    let mut memory = Memory::default();
    memory.remember("boot", "p1", "error", Left::Typing);
    memory.remember("boot", "p2", "warn", Left::Open);
    assert_eq!(
        memory.resume("boot", "p1"),
        Some(Resume {
            query: "error".into(),
            focus: true
        })
    );
    assert_eq!(memory.resume("boot", "p1"), None, "it comes back once");
    assert_eq!(memory.query("boot", "p1"), Some("error"), "the query stays");
    assert_eq!(
        memory.resume("boot", "p2"),
        Some(Resume {
            query: "warn".into(),
            focus: false
        })
    );
}

#[test]
fn a_closed_bar_offers_its_query_without_coming_back() {
    let mut memory = Memory::default();
    memory.remember("boot", "p1", "error", Left::Closed);
    assert_eq!(memory.resume("boot", "p1"), None);
    assert_eq!(memory.query("boot", "p1"), Some("error"));
    // Closing on an empty field forgets the pane.
    memory.remember("boot", "p1", "", Left::Closed);
    assert_eq!(memory.query("boot", "p1"), None);
}

#[test]
fn a_new_boot_forgets_every_pane() {
    let mut memory = Memory::default();
    memory.remember("old", "p1", "error", Left::Open);
    assert_eq!(memory.resume("new", "p1"), None);
    assert_eq!(memory.query("new", "p1"), None);
    memory.remember("new", "p2", "warn", Left::Closed);
    assert_eq!(memory.query("old", "p1"), None, "the old boot is gone");
    assert_eq!(memory.query("new", "p2"), Some("warn"));
}

#[test]
fn the_oldest_panes_are_forgotten_past_the_bound() {
    let mut memory = Memory::default();
    for pane in 0..65 {
        memory.remember("boot", &format!("p{pane}"), "q", Left::Closed);
    }
    assert_eq!(memory.query("boot", "p0"), None);
    assert_eq!(memory.query("boot", "p1"), Some("q"));
    assert_eq!(memory.query("boot", "p64"), Some("q"));
    // Remembering a pane again makes it the newest.
    memory.remember("boot", "p1", "r", Left::Closed);
    memory.remember("boot", "p65", "q", Left::Closed);
    assert_eq!(memory.query("boot", "p1"), Some("r"));
    assert_eq!(memory.query("boot", "p2"), None);
}
