//! Reviewing the changes an agent made: the focused checkout's uncommitted
//! diff, notes on its lines, and sending them back to the agent the way page
//! annotations go (see `agent_notes`).
mod diff;
mod highlight;
mod notes;
mod view;

pub(crate) use view::Review;
