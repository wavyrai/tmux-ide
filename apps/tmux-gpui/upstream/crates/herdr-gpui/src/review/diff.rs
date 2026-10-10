//! The changes under review as files, each with its lines once read. Git
//! lists the files first, cheaply, whatever the size of the change; their
//! lines are read afterwards in batches, and a very large or binary file is
//! only listed. Each file keeps its text in one buffer and its lines as
//! ranges into it, so a change of hundreds of thousands of lines stays
//! compact. File contents are untrusted: every line is stripped of control
//! and direction-override characters and bounded before it is stored.
use crate::notifications::unsafe_char;
use std::{collections::HashMap, ops::Range, sync::Arc};

mod budget;
mod context;
mod load;
mod parse;
mod words;

pub(crate) use budget::{EAGER_LINES, batch};
pub(crate) use context::read_lines;
pub(crate) use load::{Loaded, Request, bodies, load};
pub(crate) use words::emphasis;

/// Characters kept of one line; a longer one ends in an ellipsis.
pub(crate) const MAX_LINE_CHARS: usize = 16_384;
/// Lines one file keeps; a longer one is cut short and says so.
const MAX_FILE_LINES: usize = 250_000;
/// Lines coloured together at most.
const STRETCH: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Hunk,
    Context,
    Added,
    Removed,
    /// Git's remarks, such as a missing final newline.
    Meta,
}

/// One line of a file's diff; its text is a range of the file's buffer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Line {
    pub kind: Kind,
    /// The line's number before the change, for context and removed lines.
    pub old: Option<u32>,
    /// The line's number after the change, for context and added lines.
    pub new: Option<u32>,
    text: Range<u32>,
}

/// One line of the side-by-side view, as indices into a file's lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SplitRow {
    /// A hunk header or remark, across both sides.
    Across(usize),
    /// A removed line beside the added line that replaced it; an unchanged
    /// line is the same line on both sides.
    Sides {
        left: Option<usize>,
        right: Option<usize>,
    },
}

/// A file's lines, read once, then shared with the work done on them in
/// the background.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Lines {
    text: String,
    lines: Vec<Line>,
    /// Where each hunk header is.
    hunks: Vec<usize>,
    split: Vec<SplitRow>,
    /// Each line's partner in an edit: the added line that replaced a
    /// removed one, and back; `u32::MAX` for none.
    partners: Vec<u32>,
    /// Lines were left out to stay within bounds.
    pub truncated: bool,
}

impl Lines {
    /// Adds a line, cleaned and bounded; false once the file is full.
    pub(crate) fn push(
        &mut self,
        kind: Kind,
        old: Option<u32>,
        new: Option<u32>,
        text: &str,
    ) -> bool {
        if self.lines.len() >= MAX_FILE_LINES || self.text.len() >= u32::MAX as usize / 2 {
            self.truncated = true;
            return false;
        }
        let start = self.text.len();
        push_clean(&mut self.text, text);
        let range = offset(start)..offset(self.text.len());
        if kind == Kind::Hunk {
            self.hunks.push(self.lines.len());
        }
        self.lines.push(Line {
            kind,
            old,
            new,
            text: range,
        });
        true
    }

    /// Pairs the lines side by side; done once the lines are all in.
    pub(crate) fn finish(mut self) -> Self {
        self.split = split_rows(&self.lines);
        let mut partners = vec![u32::MAX; self.lines.len()];
        for row in &self.split {
            if let SplitRow::Sides {
                left: Some(left),
                right: Some(right),
            } = *row
                && left != right
            {
                partners[left] = u32::try_from(right).unwrap_or(u32::MAX);
                partners[right] = u32::try_from(left).unwrap_or(u32::MAX);
            }
        }
        self.partners = partners;
        self
    }

    /// The line paired with `line` in an edit, if any.
    pub(crate) fn partner(&self, line: usize) -> Option<usize> {
        self.partners
            .get(line)
            .filter(|partner| **partner != u32::MAX)
            .map(|partner| *partner as usize)
    }

    /// A whole new file's text, every line added.
    pub(crate) fn added(contents: &str) -> Self {
        let mut lines = Self::default();
        let count = contents.lines().count();
        lines.push(Kind::Hunk, None, None, &format!("@@ -0,0 +1,{count} @@"));
        for (index, line) in contents.lines().enumerate() {
            let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
            if !lines.push(Kind::Added, None, Some(number), line) {
                break;
            }
        }
        lines.finish()
    }

    pub(crate) fn len(&self) -> usize {
        self.lines.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub(crate) fn get(&self, index: usize) -> Option<&Line> {
        self.lines.get(index)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &Line> {
        self.lines.iter()
    }

    /// The text of line `index`; empty past the end.
    pub(crate) fn text(&self, index: usize) -> &str {
        self.lines.get(index).map_or("", |line| self.text_of(line))
    }

    pub(crate) fn text_of(&self, line: &Line) -> &str {
        self.text
            .get(line.text.start as usize..line.text.end as usize)
            .unwrap_or("")
    }

    pub(crate) fn split(&self) -> &[SplitRow] {
        &self.split
    }

    pub(crate) fn hunks(&self) -> &[usize] {
        &self.hunks
    }

    /// Where the hunk holding `line` starts: just after its header, or at
    /// the top before any.
    pub(crate) fn hunk_start(&self, line: usize) -> usize {
        match self.hunks.partition_point(|&header| header <= line) {
            0 => 0,
            hunk => self.hunks[hunk - 1] + 1,
        }
    }

    /// The stretch of lines coloured together that holds `line`: within
    /// one hunk, which reads afresh, and at most `STRETCH` lines of it, so
    /// a huge new file is coloured only where it is read.
    pub(crate) fn stretch(&self, line: usize) -> Range<usize> {
        let start = self.hunk_start(line);
        let hunk = self.hunks.partition_point(|&header| header <= line);
        let end = self.hunks.get(hunk).copied().unwrap_or(self.len());
        let from = start + line.saturating_sub(start) / STRETCH * STRETCH;
        from..(from + STRETCH).min(end).max(from)
    }

    /// The lines with `added` unchanged lines shown at the top of the hunk
    /// whose header is line `header`, numbered from `first` after the
    /// change and `old_first` before it; the header then starts at them.
    pub(crate) fn with_context(
        &self,
        header: usize,
        first: u32,
        old_first: u32,
        added: &[String],
    ) -> Self {
        let mut lines = Self::default();
        for index in 0..self.len().min(header) {
            lines.copy(self, index);
        }
        let count = u32::try_from(added.len()).unwrap_or(u32::MAX);
        let text = self.text(header);
        let grown = context::grown_header(text, count).unwrap_or_else(|| text.to_owned());
        lines.push(Kind::Hunk, None, None, &grown);
        for (offset, text) in (0_u32..).zip(added) {
            lines.push(
                Kind::Context,
                Some(old_first.saturating_add(offset)),
                Some(first.saturating_add(offset)),
                text,
            );
        }
        for index in header + 1..self.len() {
            lines.copy(self, index);
        }
        lines.truncated |= self.truncated;
        lines.finish()
    }

    fn copy(&mut self, from: &Self, index: usize) {
        if let Some(line) = from.lines.get(index) {
            self.push(line.kind, line.old, line.new, from.text_of(line));
        }
    }
}

fn offset(at: usize) -> u32 {
    u32::try_from(at).unwrap_or(u32::MAX)
}

/// A path as Git printed it, made safe to show and to quote.
fn clean_path(path: &str) -> String {
    let mut clean = String::new();
    push_clean(&mut clean, path);
    clean
}

/// Appends one line of untrusted text: tabs become spaces, controls and
/// direction overrides go, and it is bounded.
fn push_clean(buffer: &mut String, text: &str) {
    let text = text.strip_suffix('\r').unwrap_or(text);
    let mut kept = 0;
    for c in text.chars() {
        if kept >= MAX_LINE_CHARS {
            buffer.push('\u{2026}');
            return;
        }
        if c == '\t' {
            buffer.push_str("    ");
        } else if !unsafe_char(c) {
            buffer.push(c);
        } else {
            continue;
        }
        kept += 1;
    }
}

/// The lines side by side: each run of removed lines is paired, in order,
/// with the added lines that follow it, and the longer side runs on alone.
fn split_rows(lines: &[Line]) -> Vec<SplitRow> {
    let mut split = Vec::with_capacity(lines.len());
    let (mut removed, mut added) = (Vec::new(), Vec::new());
    let flush = |split: &mut Vec<SplitRow>, removed: &mut Vec<usize>, added: &mut Vec<usize>| {
        for index in 0..removed.len().max(added.len()) {
            split.push(SplitRow::Sides {
                left: removed.get(index).copied(),
                right: added.get(index).copied(),
            });
        }
        removed.clear();
        added.clear();
    };
    for (index, line) in lines.iter().enumerate() {
        match line.kind {
            // Removals after additions start a new pairing.
            Kind::Removed if !added.is_empty() => {
                flush(&mut split, &mut removed, &mut added);
                removed.push(index);
            }
            Kind::Removed => removed.push(index),
            Kind::Added => added.push(index),
            Kind::Context => {
                flush(&mut split, &mut removed, &mut added);
                split.push(SplitRow::Sides {
                    left: Some(index),
                    right: Some(index),
                });
            }
            Kind::Hunk | Kind::Meta => {
                flush(&mut split, &mut removed, &mut added);
                split.push(SplitRow::Across(index));
            }
        }
    }
    flush(&mut split, &mut removed, &mut added);
    split
}

/// How a file changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Status {
    #[default]
    Modified,
    Added,
    Deleted,
    Renamed,
    /// Not tracked by Git yet: shown wholly added.
    Untracked,
}

impl Status {
    /// The letter the file list shows.
    pub(crate) fn letter(self) -> &'static str {
        match self {
            Self::Modified => "M",
            Self::Added | Self::Untracked => "A",
            Self::Deleted => "D",
            Self::Renamed => "R",
        }
    }

    /// What a file header says of it; nothing for an edit.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Modified => "",
            Self::Added => "new",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Untracked => "untracked",
        }
    }
}

/// What is known of a file's lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Body {
    /// Not read yet.
    Pending,
    Loaded(Arc<Lines>),
    /// Not text: listed, never shown.
    Binary,
    /// Too large to read unless asked.
    Large,
    /// Could not be read; why, as the user reads it.
    Failed(String),
}

/// One changed file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FileDiff {
    /// Relative to the checkout, after the change, cleaned for display and
    /// for notes: a name is untrusted text.
    pub path: String,
    /// Where a renamed file was, cleaned.
    pub old_path: Option<String>,
    /// Both names as Git wrote them, only ever handed back to Git or the
    /// file system.
    git_path: String,
    git_old_path: Option<String>,
    pub status: Status,
    /// Changed lines as Git counted them; `None` until known, or for a
    /// binary file.
    pub added: Option<u32>,
    pub removed: Option<u32>,
    /// Generated, vendored as a lockfile, or deleted: folded at first.
    pub folded: bool,
    pub body: Body,
}

impl FileDiff {
    /// A file Git named `path`.
    pub(crate) fn new(path: String, status: Status) -> Self {
        Self {
            path: clean_path(&path),
            git_path: path,
            old_path: None,
            git_old_path: None,
            status,
            added: None,
            removed: None,
            folded: false,
            body: Body::Pending,
        }
    }

    /// The file's name as Git wrote it, for reading it from the checkout.
    pub(crate) fn git_path(&self) -> &str {
        &self.git_path
    }

    /// Where a renamed file was, as Git named it.
    pub(crate) fn set_old_path(&mut self, old: String) {
        self.old_path = Some(clean_path(&old));
        self.git_old_path = Some(old);
    }

    pub(crate) fn lines(&self) -> Option<&Arc<Lines>> {
        match &self.body {
            Body::Loaded(lines) => Some(lines),
            _ => None,
        }
    }

    /// Changed lines, for the read budget: unknown counts as one.
    pub(crate) fn weight(&self) -> u64 {
        u64::from(self.added.unwrap_or(1)) + u64::from(self.removed.unwrap_or(0))
    }

    /// Takes the counts from lines just read, for a file Git did not count.
    fn count(&mut self) {
        let Some(lines) = self.lines() else {
            return;
        };
        let (mut added, mut removed) = (0_u32, 0_u32);
        for line in lines.iter() {
            match line.kind {
                Kind::Added => added = added.saturating_add(1),
                Kind::Removed => removed = removed.saturating_add(1),
                _ => {}
            }
        }
        self.added = Some(added);
        self.removed = Some(removed);
    }

    /// Takes `body`, counting its lines when Git did not.
    pub(crate) fn set_body(&mut self, body: Body) {
        self.body = body;
        if self.added.is_none() {
            self.count();
        }
    }
}

/// Lockfiles: machine-written, so they start folded.
pub(crate) fn lockfile(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "Cargo.lock"
            | "package-lock.json"
            | "npm-shrinkwrap.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lock"
            | "Gemfile.lock"
            | "poetry.lock"
            | "uv.lock"
            | "Pipfile.lock"
            | "composer.lock"
            | "go.sum"
            | "flake.lock"
            | "Package.resolved"
            | "pubspec.lock"
            | "mix.lock"
    )
}

/// A row of the diff that can take a note: a file's header or one of its
/// lines. Stable while the file's lines are read around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RowId {
    Header(usize),
    Line { file: usize, line: usize },
}

impl RowId {
    pub(crate) fn file(self) -> usize {
        match self {
            Self::Header(file) | Self::Line { file, .. } => file,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Diff {
    pub files: Vec<FileDiff>,
    /// The revision removed lines are numbered in, as a prompt names it.
    pub before: String,
}

/// Which changes a review shows. Either way the diff ends at the working
/// tree, so added and unchanged lines carry the numbers the files have now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Scope {
    /// What is not committed yet: against HEAD.
    #[default]
    Uncommitted,
    /// Everything the branch adds, as its pull request will: against the
    /// merge base with the base branch, uncommitted work included.
    Branch,
}

/// Which version of a file a line number counts in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Side {
    Added,
    Removed,
    Unchanged,
}

/// What a review note is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Anchor {
    File {
        path: String,
    },
    Line {
        path: String,
        side: Side,
        number: u32,
        code: String,
        /// For a removed line, the revision its number counts in.
        before: Option<String>,
    },
}

impl Diff {
    /// Parses `git diff` output made with `a/` and `b/` prefixes, every
    /// file read.
    #[cfg(test)]
    pub(crate) fn parse(text: &str) -> Self {
        Self {
            files: parse::parse(text)
                .into_iter()
                .map(|parsed| {
                    let mut file = FileDiff::new(parsed.path, parsed.status);
                    if let Some(old) = parsed.old_path {
                        file.set_old_path(old);
                    }
                    file.set_body(parsed.body);
                    file
                })
                .collect(),
            before: String::new(),
        }
    }

    /// Adds a file Git does not track yet, every line of it added.
    #[cfg(test)]
    pub(crate) fn add_untracked(&mut self, name: &str, contents: &str) {
        let mut file = FileDiff::new(name.into(), Status::Untracked);
        file.set_body(Body::Loaded(Arc::new(Lines::added(contents))));
        self.files.push(file);
    }

    /// What a note on `row` is about; hunks and remarks take none.
    pub(crate) fn anchor(&self, row: RowId) -> Option<Anchor> {
        let file = self.files.get(row.file())?;
        let path = file.path.clone();
        let RowId::Line { line, .. } = row else {
            return Some(Anchor::File { path });
        };
        let lines = file.lines()?;
        let found = lines.get(line)?;
        let (side, number) = match found.kind {
            Kind::Added => (Side::Added, found.new?),
            Kind::Removed => (Side::Removed, found.old?),
            Kind::Context => (Side::Unchanged, found.new?),
            Kind::Hunk | Kind::Meta => return None,
        };
        Some(Anchor::Line {
            path,
            side,
            number,
            code: lines.text_of(found).to_owned(),
            before: (side == Side::Removed).then(|| self.before.clone()),
        })
    }

    /// Each file's index by its path, to find notes' rows.
    pub(crate) fn paths(&self) -> HashMap<&str, usize> {
        let mut paths = HashMap::with_capacity(self.files.len());
        for (index, file) in self.files.iter().enumerate() {
            paths.entry(file.path.as_str()).or_insert(index);
        }
        paths
    }

    /// The row a note with `anchor` belongs on, if its file's lines are
    /// read and still quote the same line.
    pub(crate) fn row_of(&self, paths: &HashMap<&str, usize>, anchor: &Anchor) -> Option<RowId> {
        let (Anchor::File { path } | Anchor::Line { path, .. }) = anchor;
        let file = *paths.get(path.as_str())?;
        let Anchor::Line { side, number, .. } = anchor else {
            return Some(RowId::Header(file));
        };
        let lines = self.files.get(file)?.lines()?;
        let line = lines.iter().position(|line| match side {
            Side::Added => line.kind == Kind::Added && line.new == Some(*number),
            Side::Removed => line.kind == Kind::Removed && line.old == Some(*number),
            Side::Unchanged => line.kind == Kind::Context && line.new == Some(*number),
        })?;
        let row = RowId::Line { file, line };
        (self.anchor(row).as_ref() == Some(anchor)).then_some(row)
    }
}

#[cfg(test)]
mod tests;
