//! Metadata from the authenticated native terminal controller, never cell transport.
use super::*;
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
        } = command
        else {
            return Ok(());
        };
        if version != 1
            || !self.foreground
            || self.state.surface != Surface::Workspace
            || request != self.state.request
            || presence_revision != self.presence_revision
            || self.state.selected_session.as_ref() != Some(&live_session_id)
            || self.state.selected_pane.as_ref() != Some(&pane)
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
        // The terminal controller already validated topology and revisions. The
        // metadata boundary additionally requires exactly its issued pane set;
        // a delayed or partial roster must not add/remove selection authority.
        let issued: BTreeSet<_> = self.state.panes.iter().map(|p| p.id.as_str()).collect();
        if issued.is_empty() || issued.len() > 24 || issued.len() != self.state.panes.len() {
            return Ok(());
        }
        let mut received = BTreeSet::new();
        for window in &layouts {
            for row in &window.panes {
                if let Some(id) = row.pane.as_deref()
                    && (!issued.contains(id) || !received.insert(id))
                {
                    return Ok(());
                }
            }
        }
        if received != issued {
            return Ok(());
        }
        let mut choices = Vec::with_capacity(issued.len());
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
                choices.push(Choice {
                    id: id.into(),
                    label: label(row.display_name.as_deref(), id),
                    pane_count: None,
                    window_id: Some(window_id.clone()),
                    window_label: Some(label(window.window_name.as_deref(), "Window")),
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
                    window_label: None,
                });
            }
        }
        if choices == self.state.panes && self.state.session_catalog_complete {
            return Ok(());
        }
        self.state.panes = choices;
        self.state.session_catalog_complete = true;
        self.publish()
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
