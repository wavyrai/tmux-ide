//! A review's lines are read after its files are listed: in batches, a
//! huge file when asked, a binary never, and hidden lines on request.
use super::window;
use crate::pull_request::Input;
use crate::review::diff::{Body, Kind, Scope, load};
use gpui::Modifiers;
use std::process::Command;

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn git(checkout: &str, args: &[&str]) {
    let output = Command::new("git")
        .args(["-C", checkout, "-c", "user.name=Test"])
        .args(["-c", "user.email=test@example.invalid"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .env_remove("GIT_DIR")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
}

/// A repository with a small edit far down a long file, a huge change, a
/// binary, and the checkout to review.
fn repository() -> (tempfile::TempDir, Input) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let checkout = path.to_str().unwrap().to_owned();
    git(&checkout, &["init", "-q", "-b", "main"]);
    let numbered: String = (1..=100).map(|line| format!("line {line}\n")).collect();
    std::fs::write(path.join("a.txt"), &numbered).unwrap();
    std::fs::write(path.join("big.txt"), "").unwrap();
    std::fs::write(path.join("logo.png"), b"\x89PNG\0\0").unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-qm", "base"]);
    std::fs::write(
        path.join("a.txt"),
        numbered.replace("line 60\n", "line sixty\n"),
    )
    .unwrap();
    let big: String = (0..25_000).map(|line| format!("{line}\n")).collect();
    std::fs::write(path.join("big.txt"), big).unwrap();
    std::fs::write(path.join("logo.png"), b"\x89PNG\0\x01").unwrap();
    let input = Input {
        checkout: Some(checkout),
        repo_key: Some(path.join(".git").to_str().unwrap().to_owned()),
        branch: "main".into(),
    };
    (directory, input)
}

#[gpui::test]
fn lines_are_read_after_the_files_and_large_ones_when_asked(cx: &mut gpui::TestAppContext) {
    let (_directory, input) = repository();
    let listed = load(&input, Scope::Uncommitted, None, false).unwrap();
    assert_eq!(listed.diff.files[0].body, Body::Pending, "listed, not read");
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(gpui::px(1600.), gpui::px(900.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let id = view.seed_review(listed, window, cx);
            view.schedule_review_reads(id, cx);
        })
    });
    // The files show at once, their lines as they are read.
    draw(cx);
    assert!(cx.debug_bounds("review-header-0").is_some());
    cx.run_until_parked();
    draw(cx);
    let body = |cx: &mut gpui::VisualTestContext, file: usize| {
        view.read_with(cx, |view, _| {
            view.reviews
                .values()
                .next()
                .unwrap()
                .loaded()
                .unwrap()
                .diff
                .files[file]
                .body
                .clone()
        })
    };
    let Body::Loaded(lines) = body(cx, 0) else {
        panic!("a.txt is read");
    };
    assert!(
        lines
            .iter()
            .any(|line| line.kind == Kind::Added && lines.text_of(line) == "line sixty")
    );
    assert!(cx.debug_bounds("review-line-0-1").is_some());
    assert_eq!(body(cx, 1), Body::Large);
    assert_eq!(body(cx, 2), Body::Binary);
    assert!(cx.debug_bounds("review-placeholder-2").is_some());

    // Asked for, the large change is read whole.
    let load_button = cx.debug_bounds("review-load-1").unwrap();
    cx.simulate_click(load_button.center(), Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    let Body::Loaded(lines) = body(cx, 1) else {
        panic!("big.txt is read when asked");
    };
    assert_eq!(
        lines.iter().filter(|line| line.kind == Kind::Added).count(),
        25_000
    );
}

#[gpui::test]
fn hidden_lines_above_a_hunk_show_on_request(cx: &mut gpui::TestAppContext) {
    let (_directory, input) = repository();
    let mut listed = load(&input, Scope::Uncommitted, None, false).unwrap();
    listed.read_all();
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(gpui::px(1600.), gpui::px(900.)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(listed, window, cx)));
    draw(cx);
    let gap = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            let review = view.reviews.values().next().unwrap();
            let lines = review.loaded().unwrap().diff.files[0]
                .lines()
                .unwrap()
                .clone();
            lines.gap(0).map(|gap| gap.hidden)
        })
    };
    // Git shows three lines either side of line 60.
    assert_eq!(gap(cx), Some(1..57));
    let expand = cx.debug_bounds("review-expand-0-0").unwrap();
    cx.simulate_click(expand.center(), Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    // All 56 hidden lines fit one request.
    assert_eq!(gap(cx), None);
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        let lines = review.loaded().unwrap().diff.files[0]
            .lines()
            .unwrap()
            .clone();
        let first = lines.get(1).unwrap();
        assert_eq!(
            (first.kind, first.old, first.new),
            (Kind::Context, Some(1), Some(1))
        );
        assert_eq!(lines.text(1), "line 1");
    });
}

/// A file named with a tab shows its hidden lines from that file.
#[cfg(unix)]
#[gpui::test]
fn hidden_lines_come_from_the_file_git_named(cx: &mut gpui::TestAppContext) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let checkout = path.to_str().unwrap().to_owned();
    git(&checkout, &["init", "-q", "-b", "main"]);
    let numbered: String = (1..=30).map(|line| format!("line {line}\n")).collect();
    let name = "odd\tname.txt";
    std::fs::write(path.join(name), &numbered).unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-qm", "base"]);
    std::fs::write(
        path.join(name),
        numbered.replace("line 20\n", "line twenty\n"),
    )
    .unwrap();
    // Another file with the name the tab-named one is shown as.
    std::fs::write(path.join("odd    name.txt"), "decoy\n".repeat(30)).unwrap();
    let input = Input {
        checkout: Some(checkout),
        repo_key: Some(path.join(".git").to_str().unwrap().to_owned()),
        branch: "main".into(),
    };
    let mut listed = load(&input, Scope::Uncommitted, None, false).unwrap();
    listed.read_all();
    let file = listed
        .diff
        .files
        .iter()
        .position(|file| file.git_path() == name)
        .unwrap();
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(gpui::px(1600.), gpui::px(900.)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(listed, window, cx)));
    draw(cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let id = *view.reviews.keys().next().unwrap();
            view.expand_review_hunk(id, file, 0, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        let lines = review.loaded().unwrap().diff.files[file]
            .lines()
            .unwrap()
            .clone();
        assert_eq!(lines.text(1), "line 1");
    });
}
