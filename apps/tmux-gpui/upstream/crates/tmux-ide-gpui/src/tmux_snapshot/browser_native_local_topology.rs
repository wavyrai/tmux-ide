//! Metadata from the authenticated native terminal controller, never cell transport.
use super::*;
use crate::tmux_snapshot::browser::NameSource;
use std::collections::BTreeSet;

impl Local {
    pub(super) fn native_catalog(&mut self, command: Command) -> Result<(), Error> {
        let Command::NativeTerminalCatalog {
            version,
            id,
            request,
            pane,
            live_session_id,
            generation,
            presence_revision,
            layouts,
            issued: stream_panes,
        } = command
        else {
            return Ok(());
        };
        if version != 1
            || self.state.surface != Surface::Workspace
            || request != self.state.request
            || presence_revision != self.presence_revision
            || self.state.selected_session.as_ref() != Some(&live_session_id)
            || !self.active.as_ref().is_some_and(|route| {
                route.id == id
                    && route.request == request
                    && route.target.live == live_session_id
                    && route.target.scope.generation == generation
            })
            || layouts.len() > 256
        {
            return Ok(());
        }
        // A stream that follows pane changes in place names its own pane set:
        // this side's list (the next lease, the pane choices) follows it.
        // Also behind other windows (PM, 17 Nov: a pane closed elsewhere stayed
        // listed until the window was activated). The labels below wait for
        // the front, as before.
        // #806: a window stream's layout shows every window; its own pane set
        // is the route's, and `state.panes` lists every window's panes.
        let window_panes = (self.active.as_ref())
            .filter(|route| route.window.is_some())
            .map(|route| route.window_panes.clone());
        if let Some(stream_panes) = &stream_panes {
            let before = (self.state.panes.clone(), self.state.selected_pane.clone());
            let followed = if window_panes.is_some() {
                self.follow_window_panes(stream_panes, &pane)
            } else {
                self.follow_stream_panes(stream_panes, &pane)
            };
            if !followed {
                return Ok(());
            }
            if !self.foreground {
                return if before != (self.state.panes.clone(), self.state.selected_pane.clone()) {
                    self.publish()
                } else {
                    Ok(())
                };
            }
        }
        if !self.foreground || self.state.selected_pane.as_ref() != Some(&pane) {
            return Ok(());
        }
        // The terminal controller already validated topology and revisions. The
        // metadata boundary additionally requires exactly its issued pane set;
        // a delayed or partial roster must not add/remove selection authority.
        // Followed above: the route's set may have just changed.
        let window_panes = (self.active.as_ref())
            .filter(|route| route.window.is_some())
            .map(|route| route.window_panes.clone());
        let window_route = window_panes.is_some();
        let issued: BTreeSet<_> = match &window_panes {
            Some(panes) => panes.iter().map(String::as_str).collect(),
            None => self.state.panes.iter().map(|p| p.id.as_str()).collect(),
        };
        let issued_len = window_panes
            .as_ref()
            .map_or(self.state.panes.len(), Vec::len);
        if issued.is_empty() || issued.len() > 24 || issued.len() != issued_len {
            return Ok(());
        }
        let mut received = BTreeSet::new();
        for window in &layouts {
            for row in &window.panes {
                if let Some(id) = row.pane.as_deref()
                    && ((!window_route && !issued.contains(id)) || !received.insert(id))
                {
                    return Ok(());
                }
            }
        }
        // A whole-session stream's layout shows exactly its panes; a window
        // stream's shows its own panes and every other window's.
        if if window_route {
            !issued.is_subset(&received)
        } else {
            received != issued
        } {
            return Ok(());
        }
        let issued = if window_route { received } else { issued };
        let mut choices = Vec::with_capacity(issued.len());
        let mut readers = BTreeMap::new();
        let mut remaining = issued;
        for window in &layouts {
            let Some(window_id) = &window.semantic_window_id else {
                continue;
            };
            for row in &window.panes {
                let Some(id) = row.pane.as_deref() else {
                    continue;
                };
                if !remaining.remove(id) {
                    continue;
                }
                if let Some(reader) = &row.reader {
                    readers.insert(id.to_owned(), reader.name.clone());
                }
                choices.push(Choice {
                    id: id.into(),
                    label: label(row.display_name.as_deref(), id),
                    pane_count: None,
                    window_id: Some(window_id.clone()),
                    browser_icon: row.browser_icon.clone(),
                    display_name_source: row.display_name_source.map(name_source),
                    window_label: Some(label(window.window_name.as_deref(), "Window")),
                    largest_window: None,
                });
            }
        }
        // Preserve original inventory order when topology has no window identity.
        for old in &self.state.panes {
            if remaining.contains(old.id.as_str()) {
                choices.push(Choice {
                    id: old.id.clone(),
                    label: old.id.clone(),
                    pane_count: None,
                    window_id: None,
                    browser_icon: None,
                    display_name_source: None,
                    window_label: None,
                    largest_window: None,
                });
            }
        }
        let readers_changed = readers != self.state.reader_panes;
        self.state.reader_panes = readers;
        if choices == self.state.panes && self.state.session_catalog_complete && !readers_changed {
            return Ok(());
        }
        self.state.panes = choices;
        self.state.session_catalog_complete = true;
        self.publish()
    }
}

impl Local {
    /// Takes the pane set of a stream that followed a pane change in place
    /// (capability 119). Panes that stayed keep their entry and order; added
    /// ones are appended until the layout names them. The selected pane moves
    /// to `selected` only when the one this side holds left the stream: a
    /// selection the user made travels by its own acknowledgement. `false`
    /// when the set is not one a stream can have.
    fn follow_stream_panes(&mut self, stream_panes: &[String], selected: &str) -> bool {
        let unique: BTreeSet<&str> = stream_panes.iter().map(String::as_str).collect();
        if stream_panes.is_empty()
            || stream_panes.len() > 24
            || unique.len() != stream_panes.len()
            || !unique.contains(selected)
        {
            return false;
        }
        if (self.state.selected_pane.as_deref()).is_none_or(|held| !unique.contains(held)) {
            self.state.selected_pane = Some(selected.to_owned());
        }
        let mut panes: Vec<Choice> = std::mem::take(&mut self.state.panes)
            .into_iter()
            .filter(|choice| unique.contains(choice.id.as_str()))
            .collect();
        for id in stream_panes {
            if !panes.iter().any(|choice| &choice.id == id) {
                panes.push(Choice {
                    id: id.clone(),
                    label: id.clone(),
                    pane_count: None,
                    window_id: None,
                    browser_icon: None,
                    display_name_source: None,
                    window_label: None,
                    largest_window: None,
                });
            }
        }
        self.state.panes = panes;
        true
    }
    /// The window-stream form of `follow_stream_panes` (#806): the stream's
    /// pane set is the route's; `state.panes` keeps every window's panes and
    /// gains a pane added to this window until the layout labels it.
    fn follow_window_panes(&mut self, stream_panes: &[String], selected: &str) -> bool {
        let unique: BTreeSet<&str> = stream_panes.iter().map(String::as_str).collect();
        let Some(route) = self.active.as_mut() else {
            return false;
        };
        if stream_panes.is_empty()
            || stream_panes.len() > 24
            || unique.len() != stream_panes.len()
            || !unique.contains(selected)
        {
            return false;
        }
        route.window_panes = stream_panes.to_vec();
        if (self.state.selected_pane.as_deref()).is_none_or(|held| !unique.contains(held)) {
            self.state.selected_pane = Some(selected.to_owned());
        }
        for id in stream_panes {
            if !self.state.panes.iter().any(|choice| &choice.id == id) {
                self.state.panes.push(Choice {
                    id: id.clone(),
                    label: id.clone(),
                    pane_count: None,
                    window_id: None,
                    browser_icon: None,
                    display_name_source: None,
                    window_label: None,
                    largest_window: None,
                });
            }
        }
        true
    }
}

fn name_source(source: herdr_client::tmux_topology::DisplayNameSource) -> NameSource {
    use herdr_client::tmux_topology::DisplayNameSource as Wire;
    match source {
        Wire::Manual => NameSource::Manual,
        Wire::Agent => NameSource::Agent,
        Wire::Process => NameSource::Process,
        Wire::Title => NameSource::Title,
        Wire::Generated => NameSource::Generated,
    }
}

fn label(value: Option<&str>, fallback: &str) -> String {
    let clean: String = value
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let clean = clean.trim();
    let value = if clean.is_empty() { fallback } else { clean };
    let mut end = value.len().min(512);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}
