//! Explicit actions on the focused branch's pull request: reading its review
//! conversation, commenting, and merging.
//!
//! One worker thread owns every request, so the UI thread only queues work and
//! reads the answer on a later tick. Reading the conversation is cancelled by
//! generation when the pull request changes. Commenting and merging are sent
//! once, never cancelled midway, and never retried or replayed: a repeated
//! comment is a duplicate and a repeated merge is a different decision. A
//! merge names the head commit the user saw, so GitHub refuses it if the
//! branch moved since. Remote text is cleaned and bounded before display.
use crate::{
    Error,
    pull_request::{MergeMethod, PullRequest, State, clean},
};
use secrecy::SecretString;
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[cfg(test)]
mod tests;

const API_TIMEOUT: Duration = Duration::from_secs(30);
/// GitHub accepts far longer bodies; the dialog field is one line, so this is
/// a sanity bound rather than a product limit.
pub(crate) const BODY_LIMIT: usize = 4096;
/// Comments shown, newest last. The query asks for at most 20 of each kind.
const COMMENT_LIMIT: usize = 40;
const AUTHOR_LIMIT: usize = 64;
const PATH_LIMIT: usize = 160;

const CONVERSATION_QUERY: &str = r#"query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      comments(last: 20) { nodes { author { login } body createdAt } }
      reviews(last: 20) { nodes { author { login } state body submittedAt } }
      reviewThreads(last: 20) {
        nodes { isResolved path comments(first: 1) { totalCount nodes { author { login } body createdAt } } }
      }
    }
  }
}"#;
const COMMENT_MUTATION: &str = r#"mutation($subject: ID!, $body: String!) {
  addComment(input: {subjectId: $subject, body: $body}) { commentEdge { node { url } } }
}"#;
const MERGE_MUTATION: &str = r#"mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) {
  mergePullRequest(input: {pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head}) {
    pullRequest { state url }
  }
}"#;

/// The pull request an action addresses, taken from a lookup whose URL,
/// repository, and branch were already verified. Comparing targets compares
/// the head too, so a pushed branch is a different target to merge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
    id: String,
    head: String,
}

impl Target {
    /// The same pull request, whatever its head commit.
    pub fn same_pull_request(&self, other: &Self) -> bool {
        self.number == other.number
            && self.owner.eq_ignore_ascii_case(&other.owner)
            && self.repo.eq_ignore_ascii_case(&other.repo)
    }
}

impl TryFrom<&PullRequest> for Target {
    type Error = Error;

    fn try_from(pr: &PullRequest) -> crate::Result<Self> {
        if pr.state != State::Open || pr.id.is_empty() || pr.head_ref_oid.is_empty() {
            return Err(Error::PrActionTarget);
        }
        // Parsing re-wrote the URL to exactly this shape after checking it.
        let path = pr
            .url
            .strip_prefix("https://github.com/")
            .ok_or(Error::PrActionTarget)?;
        let mut parts = path.split('/');
        let (Some(owner), Some(repo), Some("pull"), Some(number), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return Err(Error::PrActionTarget);
        };
        if owner.is_empty() || repo.is_empty() || number != pr.number.to_string() {
            return Err(Error::PrActionTarget);
        }
        Ok(Self {
            owner: owner.into(),
            repo: repo.into(),
            number: pr.number,
            url: pr.url.clone(),
            id: pr.id.clone(),
            head: pr.head_ref_oid.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Comment(String),
    Merge(MergeMethod),
}

impl Action {
    pub fn running_label(&self) -> &'static str {
        match self {
            Self::Comment(_) => "Posting comment...",
            Self::Merge(_) => "Merging...",
        }
    }
}

/// What an action achieved. `url` is offered as a link, never opened here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub message: String,
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Review {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CommentKind {
    /// A comment on the pull request's conversation.
    Conversation,
    /// A submitted review, with its verdict.
    Review(Review),
    /// The first comment of an inline review thread on a file.
    Thread {
        path: String,
        resolved: bool,
        replies: u64,
    },
}

impl CommentKind {
    pub fn label(&self) -> String {
        match self {
            Self::Conversation => "commented".into(),
            Self::Review(Review::Approved) => "approved".into(),
            Self::Review(Review::ChangesRequested) => "requested changes".into(),
            Self::Review(Review::Commented) => "reviewed".into(),
            Self::Review(Review::Dismissed) => "review dismissed".into(),
            Self::Thread {
                path,
                resolved,
                replies,
            } => {
                let mut label = format!("on {path}");
                if *replies > 0 {
                    label.push_str(&format!(
                        ", {replies} {}",
                        if *replies == 1 { "reply" } else { "replies" }
                    ));
                }
                if *resolved {
                    label.push_str(" (resolved)");
                }
                label
            }
        }
    }
}

/// One entry of the review conversation, display-ready and bounded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Comment {
    pub author: String,
    pub kind: CommentKind,
    pub body: String,
    pub created_at: String,
}

enum Job {
    Conversation,
    Run(Action),
}

enum Completion {
    Conversation(crate::Result<Vec<Comment>>),
    Action(crate::Result<Outcome>),
}

type Request = (u64, Target, Job, Arc<SecretString>);

struct Worker {
    requests: mpsc::SyncSender<Request>,
    results: mpsc::Receiver<(u64, Target, Completion)>,
}

/// Client-local action state for one pull request at a time. Dropping it
/// retires an in-flight read; a running mutation still finishes on GitHub.
#[derive(Default)]
pub(crate) struct Actions {
    worker: Option<Worker>,
    generation: Arc<AtomicU64>,
    busy: bool,
    waiting: Option<(Target, Job, Arc<SecretString>)>,
    target: Option<Target>,
    comments: Option<Vec<Comment>>,
    loading: bool,
    comments_error: Option<String>,
    running: Option<Action>,
    error: Option<String>,
    outcome: Option<Outcome>,
    /// Set when a mutation finished, so the owner can refresh the PR lookup.
    settled: bool,
}

impl Drop for Actions {
    fn drop(&mut self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }
}

impl Actions {
    pub fn target(&self) -> Option<&Target> {
        self.target.as_ref()
    }

    pub fn comments(&self) -> Option<&[Comment]> {
        self.comments.as_deref()
    }

    pub fn loading(&self) -> bool {
        self.loading
    }

    pub fn comments_error(&self) -> Option<&str> {
        self.comments_error.as_deref()
    }

    pub fn running(&self) -> Option<&Action> {
        self.running.as_ref()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// Whether a mutation finished since the last call.
    pub fn take_settled(&mut self) -> bool {
        std::mem::take(&mut self.settled)
    }

    /// Follow the pull request the chrome shows. Another pull request drops
    /// the conversation and retires its read; a new head on the same one only
    /// updates what a merge will name. A last report is cleared only by
    /// another pull request, so "Merged" outlives the PR leaving the open state.
    pub fn track(&mut self, target: Option<Target>) {
        let same = match (&self.target, &target) {
            (Some(old), Some(new)) => old.same_pull_request(new),
            (None, None) => true,
            _ => false,
        };
        if !same {
            self.generation.fetch_add(1, Ordering::Relaxed);
            if matches!(self.waiting, Some((_, Job::Conversation, _))) {
                self.waiting = None;
            }
            self.comments = None;
            self.loading = false;
            self.comments_error = None;
            // A running action keeps its result, and a pull request that just
            // stopped being actionable (merged by this client) keeps its
            // report: both name their own PR number.
            if self.running.is_none() && target.is_some() {
                self.error = None;
                self.outcome = None;
            }
        }
        self.target = target;
    }

    /// Read the review conversation. An explicit request each time the user
    /// opens it; a failure is shown, not retried in the background.
    pub fn load_comments(&mut self, token: Arc<SecretString>) -> crate::Result<()> {
        let target = self.target.clone().ok_or(Error::PrActionTarget)?;
        if self.running.is_some() {
            return Err(Error::PrActionBusy);
        }
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.loading = true;
        self.comments_error = None;
        self.waiting = Some((target, Job::Conversation, token));
        Ok(())
    }

    /// Queue an explicit comment or merge. Validation happens here, so a
    /// refused request never reaches the worker.
    pub fn start(
        &mut self,
        action: Action,
        allowed: &[MergeMethod],
        token: Arc<SecretString>,
    ) -> crate::Result<()> {
        if self.running.is_some() {
            return Err(Error::PrActionBusy);
        }
        let target = self.target.clone().ok_or(Error::PrActionTarget)?;
        let action = match action {
            Action::Comment(body) => {
                let body = body.trim();
                if body.is_empty() || body.chars().count() > BODY_LIMIT {
                    return Err(Error::PrCommentBody);
                }
                Action::Comment(body.to_owned())
            }
            Action::Merge(method) if !allowed.contains(&method) => {
                return Err(Error::PrMergeMethod);
            }
            action @ Action::Merge(_) => action,
        };
        // A queued read yields to the user's action; it can be reopened.
        if matches!(self.waiting, Some((_, Job::Conversation, _))) {
            self.waiting = None;
            self.loading = false;
        }
        self.error = None;
        self.outcome = None;
        self.running = Some(action.clone());
        self.waiting = Some((target, Job::Run(action), token));
        Ok(())
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        if let Some(worker) = &self.worker {
            match worker.results.try_recv() {
                Ok((generation, target, completion)) => {
                    self.busy = false;
                    changed = true;
                    match completion {
                        Completion::Conversation(result) => {
                            // A read for another pull request, or one the user
                            // asked again for, is dropped.
                            if generation == self.generation.load(Ordering::Relaxed)
                                && self
                                    .target
                                    .as_ref()
                                    .is_some_and(|current| current.same_pull_request(&target))
                            {
                                self.loading = false;
                                match result {
                                    Ok(comments) => self.comments = Some(comments),
                                    Err(error) => self.comments_error = Some(error.to_string()),
                                }
                            }
                        }
                        Completion::Action(result) => {
                            self.running = None;
                            self.settled = true;
                            match result {
                                Ok(outcome) => self.outcome = Some(outcome),
                                Err(error) => self.error = Some(error.to_string()),
                            }
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.stopped(Error::PrActionWorker);
                    return true;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if !self.busy
            && let Some((target, job, token)) = self.waiting.take()
        {
            if self.worker.is_none() {
                match spawn(self.generation.clone()) {
                    Ok(worker) => self.worker = Some(worker),
                    Err(error) => {
                        self.stopped(error);
                        return true;
                    }
                }
            }
            if let Some(worker) = &self.worker {
                let generation = self.generation.load(Ordering::Relaxed);
                match worker.requests.try_send((generation, target, job, token)) {
                    Ok(()) => self.busy = true,
                    Err(mpsc::TrySendError::Full((_, target, job, token))) => {
                        self.waiting = Some((target, job, token))
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        self.stopped(Error::PrActionWorker);
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    /// The worker is gone. Nothing is resubmitted: an action that may have
    /// reached GitHub is reported as unknown rather than sent again.
    fn stopped(&mut self, error: Error) {
        self.busy = false;
        self.waiting = None;
        self.worker = None;
        self.loading = false;
        if self.running.take().is_some() {
            self.settled = true;
        }
        self.error = Some(error.to_string());
    }
}

fn spawn(current: Arc<AtomicU64>) -> crate::Result<Worker> {
    let (requests, incoming) = mpsc::sync_channel::<Request>(1);
    let (outgoing, results) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("herdr-pr-actions".into())
        .spawn(move || {
            for (generation, target, job, token) in incoming {
                let cancelled = || current.load(Ordering::Relaxed) != generation;
                let completion = match job {
                    Job::Conversation => {
                        Completion::Conversation(conversation(&target, &token, cancelled))
                    }
                    Job::Run(action) => {
                        Completion::Action(perform(&target, action, |context, query, variables| {
                            crate::github::mutation(context, &token, query, variables, API_TIMEOUT)
                        }))
                    }
                };
                if outgoing.send((generation, target, completion)).is_err() {
                    break;
                }
            }
        })
        .map_err(|source| Error::PrActionProcess { source })?;
    Ok(Worker { requests, results })
}

fn conversation(
    target: &Target,
    token: &SecretString,
    cancelled: impl Fn() -> bool,
) -> crate::Result<Vec<Comment>> {
    let response = crate::github::graphql(
        "pr_conversation",
        token,
        CONVERSATION_QUERY,
        serde_json::json!({"owner": target.owner, "repo": target.repo, "number": target.number}),
        API_TIMEOUT,
        cancelled,
        &mut None,
    )?;
    parse_conversation(&response, target)
}

/// Run one mutation through `send`, exactly once. The transport is injected
/// so tests can prove what is sent and that a failure is not retried.
pub(super) fn perform(
    target: &Target,
    action: Action,
    mut send: impl FnMut(&'static str, &str, Value) -> crate::Result<Value>,
) -> crate::Result<Outcome> {
    match action {
        Action::Comment(body) => {
            let response = send(
                "pr_comment",
                COMMENT_MUTATION,
                serde_json::json!({"subject": target.id, "body": body}),
            )?;
            Ok(commented(&response, target))
        }
        Action::Merge(method) => {
            let response = send(
                "pr_merge",
                MERGE_MUTATION,
                serde_json::json!({"id": target.id, "method": method.graphql(), "head": target.head}),
            )?;
            merged(&response, target)
        }
    }
}

/// The comment exists once GitHub answered without errors, so an odd reply
/// is still a success: reporting failure would invite a duplicate. Only a
/// link on this pull request is offered.
pub(super) fn commented(response: &Value, target: &Target) -> Outcome {
    let url = response["data"]["addComment"]["commentEdge"]["node"]["url"]
        .as_str()
        .filter(|url| {
            url.strip_prefix(target.url.as_str())
                .and_then(|anchor| anchor.strip_prefix("#issuecomment-"))
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .map(str::to_owned);
    Outcome {
        message: format!("Commented on pull request #{}", target.number),
        url,
    }
}

pub(super) fn merged(response: &Value, target: &Target) -> crate::Result<Outcome> {
    let pr = &response["data"]["mergePullRequest"]["pullRequest"];
    if pr["url"].as_str() != Some(target.url.as_str()) {
        return Err(Error::PrIdentity);
    }
    Ok(Outcome {
        message: if pr["state"] == "MERGED" {
            format!("Merged pull request #{}", target.number)
        } else {
            // Accepted without error but not merged yet, as a merge queue does.
            format!(
                "GitHub accepted the merge of #{}; it is not merged yet",
                target.number
            )
        },
        url: Some(target.url.clone()),
    })
}

pub(super) fn parse_conversation(response: &Value, target: &Target) -> crate::Result<Vec<Comment>> {
    let pr = &response["data"]["repository"]["pullRequest"];
    if pr["id"].as_str() != Some(target.id.as_str()) {
        return Err(Error::PrIdentity);
    }
    let nodes = |value: &Value| value["nodes"].as_array().cloned().unwrap_or_default();
    let mut comments = Vec::new();
    for node in nodes(&pr["comments"]) {
        if let Some(comment) = entry(&node, "createdAt", CommentKind::Conversation) {
            comments.push(comment);
        }
    }
    for node in nodes(&pr["reviews"]) {
        let review = match node["state"].as_str() {
            Some("APPROVED") => Review::Approved,
            Some("CHANGES_REQUESTED") => Review::ChangesRequested,
            Some("COMMENTED") => Review::Commented,
            Some("DISMISSED") => Review::Dismissed,
            // A pending review is its author's unsubmitted draft.
            _ => continue,
        };
        // An empty "commented" review only wraps inline threads, which are
        // listed on their own.
        if review == Review::Commented && text(&node["body"]).is_empty() {
            continue;
        }
        if let Some(comment) = entry(&node, "submittedAt", CommentKind::Review(review)) {
            comments.push(comment);
        }
    }
    for thread in nodes(&pr["reviewThreads"]) {
        let first = &thread["comments"]["nodes"][0];
        let kind = CommentKind::Thread {
            path: bounded(&text(&thread["path"]), PATH_LIMIT),
            resolved: thread["isResolved"] == true,
            replies: thread["comments"]["totalCount"]
                .as_u64()
                .unwrap_or(1)
                .saturating_sub(1),
        };
        if let Some(comment) = entry(first, "createdAt", kind) {
            comments.push(comment);
        }
    }
    // RFC 3339 UTC timestamps order as text; a malformed one only misplaces
    // its own entry.
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let excess = comments.len().saturating_sub(COMMENT_LIMIT);
    comments.drain(..excess);
    Ok(comments)
}

fn entry(node: &Value, time: &str, kind: CommentKind) -> Option<Comment> {
    if !node.is_object() {
        return None;
    }
    let author = bounded(&text(&node["author"]["login"]), AUTHOR_LIMIT);
    Some(Comment {
        // A deleted account is GitHub's "ghost".
        author: if author.is_empty() {
            "ghost".into()
        } else {
            author
        },
        kind,
        body: text(&node["body"]),
        created_at: bounded(&text(&node[time]), 32),
    })
}

/// Untrusted remote text, cleaned and bounded, with whitespace collapsed so a
/// multi-line body reads as one paragraph.
fn text(value: &Value) -> String {
    clean(value.as_str().unwrap_or_default())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn bounded(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}
