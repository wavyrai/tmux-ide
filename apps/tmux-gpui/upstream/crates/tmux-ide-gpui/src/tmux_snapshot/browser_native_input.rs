//! Single bounded native input owner. Every multi-message operation is an ACK barrier.
use super::{browser_direct::NativePresentation, decode, keys, pointer};
use herdr_client::{
    tmux_control::{Input, InputResult, Lifetime},
    tmux_controller::{Controller, Update},
    tmux_delivery::{MouseEncoding, MouseProtocol},
    tmux_history::Scroll,
    tmux_input::{Admission, Dispatch, Scheduler, Scope, Ticket, Work},
    tmux_pointer::{self, MouseOwner, PointerDecision, PointerEvent, WheelDecision},
};
use std::collections::VecDeque;
pub(super) struct InputRequest<'a> {
    pub epoch: u64,
    pub pane: &'a str,
    pub token: Option<&'a str>,
    pub input: keys::Input,
}
pub(super) struct SelectionRequest<'a> {
    pub epoch: u64,
    pub pane: &'a str,
    pub operation: String,
    pub request: u64,
}
#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("native input scope unavailable")]
    Scope,
    #[error("native input encoding unsupported")]
    Unsupported,
    #[error("native input scheduler failed")]
    Scheduler(#[from] herdr_client::tmux_input::Error),
    #[error("native input controller failed")]
    Controller(#[from] herdr_client::tmux_controller::Error),
}
#[derive(Debug)]
enum Control {
    Bytes(String),
    Paste(String),
    Mouse(PointerEvent),
    Wheel(tmux_pointer::WheelEvent),
    Scroll(i16),
    Select {
        pane: String,
        lifetime: Lifetime,
        operation: String,
        request: u64,
    },
}
enum Active {
    Paste {
        ticket: Ticket,
        scope: Scope,
        sequence: u32,
        cancelled: bool,
    },
    Reports {
        ticket: Ticket,
        scope: Scope,
        sequence: u32,
        remaining: VecDeque<Input>,
        cancelled: bool,
    },
    ResumePaste {
        ticket: Ticket,
        scope: Scope,
        cancelled: bool,
    },
    ResumeReports {
        ticket: Ticket,
        scope: Scope,
        remaining: VecDeque<Input>,
        cancelled: bool,
    },
    Select {
        ticket: Ticket,
        operation: String,
        pane: String,
        request: u64,
    },
}
#[derive(Debug)]
pub(super) struct SelectionNotice {
    pub pane: String,
    pub request: u64,
    pub selected: bool,
}
#[derive(Default)]
pub(super) struct InputOwner {
    scheduler: Option<Scheduler<Control>>,
    active: Option<Active>,
    mouse: MouseOwner,
    selection: Option<SelectionNotice>,
    queued_selection: Option<SelectionNotice>,
}
impl InputOwner {
    /// A dispatch failure or failed ACK retires admission; unsupported UI events do not.
    pub fn retired(&self) -> bool {
        self.scheduler.as_ref().is_some_and(Scheduler::retired)
    }
    pub fn busy(&self) -> bool {
        self.scheduler.as_ref().is_some_and(|s| !s.idle())
    }
    pub fn waiting(&self) -> bool {
        self.scheduler.as_ref().is_some_and(Scheduler::waiting)
    }
    fn observe_pointer(&mut self, scope: Option<tmux_pointer::Scope>, actionable: bool) {
        self.mouse
            .observe(if actionable { scope.as_ref() } else { None });
    }
    fn selection_notice(&mut self, notice: SelectionNotice) {
        if self
            .selection
            .as_ref()
            .is_none_or(|old| notice.request >= old.request)
        {
            self.selection = Some(notice);
        }
    }
    fn cancel_waiting(&mut self) {
        if self
            .scheduler
            .as_mut()
            .and_then(Scheduler::cancel_waiting)
            .is_some()
            && let Some(notice) = self.queued_selection.take()
        {
            self.selection_notice(notice);
        }
    }
    pub fn focus_loss(&mut self) {
        self.mouse.retire();
        self.cancel_waiting();
        if let Some(
            Active::Paste { cancelled, .. }
            | Active::Reports { cancelled, .. }
            | Active::ResumePaste { cancelled, .. }
            | Active::ResumeReports { cancelled, .. },
        ) = self.active.as_mut()
        {
            *cancelled = true
        }
    }
    pub fn input(
        &mut self,
        controller: &mut Controller,
        presentation: &mut NativePresentation,
        request: InputRequest<'_>,
        now: u64,
    ) -> Result<(), Error> {
        let InputRequest {
            epoch,
            pane,
            token,
            input,
        } = request;
        if pane != controller.selected() {
            return Err(Error::Scope);
        }
        // History restoration can run without an input token, but still follows accepted input.
        let lifetime = if matches!(
            input,
            keys::Input::Scroll(_) | keys::Input::Wheel { shift: true, .. }
        ) || (matches!(input, keys::Input::Wheel { .. })
            && presentation.history_offset() > 0)
        {
            controller
                .committed(pane)
                .filter(|p| p.snapshot.is_some())
                .map(|p| Lifetime {
                    generation: p.identity.generation.clone(),
                    incarnation: p.identity.incarnation.clone(),
                })
        } else {
            presentation.resolve(pane, token)
        }
        .ok_or(Error::Scope)?;
        if let keys::Input::Resize {
            cols,
            rows,
            cell_width,
            cell_height,
            cell_width_milli,
            cell_height_milli,
        } = input
        {
            match (cell_width, cell_height, cell_width_milli, cell_height_milli) {
                (Some(width), Some(height), None, None) => {
                    controller.set_cell_pixels(herdr_client::tmux_controller::CellPixels {
                        width,
                        height,
                        precise: None,
                    })?
                }
                (Some(width), Some(height), Some(w), Some(h)) => {
                    controller.set_cell_pixels(herdr_client::tmux_controller::CellPixels {
                        width,
                        height,
                        precise: Some((w, h)),
                    })?
                }
                (None, None, None, None) => {}
                _ => return Err(Error::Unsupported),
            }
            controller.viewport(cols, rows, now)?;
            return Ok(());
        }
        let work = match input {
            keys::Input::Text(text) => Work::Input(Input::Text(text)),
            keys::Input::Key(key) => Work::Input(Input::Key(key)),
            keys::Input::Paste(text) => {
                if text.is_empty() || text.len() > 65536 || text.contains(['\0', '\u{1b}']) {
                    return Err(Error::Unsupported);
                }
                Work::Barrier(Control::Paste(text))
            }
            keys::Input::Mouse(command) => Work::Barrier(Control::Mouse(mouse_event(command))),
            keys::Input::Wheel {
                lines,
                row,
                col,
                shift,
                alt,
                control,
            } => Work::Barrier(Control::Wheel(tmux_pointer::WheelEvent {
                lines,
                row: usize::from(row),
                col: usize::from(col),
                modifiers: tmux_pointer::Modifiers {
                    shift,
                    alt,
                    control,
                },
            })),
            keys::Input::Scroll(lines) => Work::Barrier(Control::Scroll(lines)),
            keys::Input::Bytes(hex) => {
                if !herdr_client::tmux_control::valid_input_bytes(&hex) {
                    return Err(Error::Unsupported);
                }
                Work::Barrier(Control::Bytes(hex))
            }
            keys::Input::Resize { .. } => return Err(Error::Unsupported),
        };
        self.admit(
            controller,
            presentation,
            Scope {
                pane: pane.into(),
                lifetime,
                presentation_epoch: epoch,
            },
            work,
            now,
        )
    }
    /// Root advances the UI request on completion, including same-pane refusal.
    /// Only a successful selection advances the actual terminal input epoch.
    pub fn select(
        &mut self,
        controller: &mut Controller,
        presentation: &mut NativePresentation,
        selection: SelectionRequest<'_>,
        now: u64,
    ) -> Result<(), Error> {
        let SelectionRequest {
            epoch,
            pane,
            operation,
            request,
        } = selection;
        if self.queued_selection.is_some() {
            self.cancel_waiting();
            self.selection_notice(SelectionNotice {
                pane: pane.into(),
                request,
                selected: false,
            });
            return Ok(());
        }
        let result = (|| {
            let target = controller.selectable(pane).ok_or(Error::Scope)?;
            let source = controller.selected().to_owned();
            let lifetime = presentation.resolve(&source, None).ok_or(Error::Scope)?;
            self.queued_selection = Some(SelectionNotice {
                pane: pane.into(),
                request,
                selected: false,
            });
            self.admit(
                controller,
                presentation,
                Scope {
                    pane: source,
                    lifetime,
                    presentation_epoch: epoch,
                },
                Work::Barrier(Control::Select {
                    pane: pane.into(),
                    lifetime: target,
                    operation,
                    request,
                }),
                now,
            )
        })();
        match result {
            Err(Error::Scope | Error::Scheduler(herdr_client::tmux_input::Error::Busy))
                if !self.retired() =>
            {
                self.queued_selection = None;
                self.selection_notice(SelectionNotice {
                    pane: pane.into(),
                    request,
                    selected: false,
                });
                Ok(())
            }
            other => other,
        }
    }

    fn admit(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        scope: Scope,
        work: Work<Control>,
        now: u64,
    ) -> Result<(), Error> {
        let scheduler = self
            .scheduler
            .get_or_insert_with(|| Scheduler::new(scope.clone()));
        scheduler.change_scope(scope.clone())?;
        match scheduler
            .admit(&scope, work)
            .map_err(|rejected| rejected.reason)?
        {
            Admission::Ready(dispatch) => self.dispatch(c, p, dispatch, now),
            Admission::Queued(_) => Ok(()),
        }
    }
    fn scheduler(&mut self) -> Result<&mut Scheduler<Control>, Error> {
        self.scheduler.as_mut().ok_or(Error::Scope)
    }
    fn dispatch(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        d: Dispatch<Control>,
        now: u64,
    ) -> Result<(), Error> {
        let result = self.dispatch_inner(c, p, d, now);
        if result.is_err() && !matches!(&result, Err(Error::Unsupported)) {
            if let Some(s) = self.scheduler.as_mut() {
                s.retire();
            }
            self.mouse.retire();
            self.active = None;
        }
        result
    }
    fn dispatch_inner(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        d: Dispatch<Control>,
        now: u64,
    ) -> Result<(), Error> {
        match d.work {
            Work::Input(input) => {
                let sequence = c.input(&d.scope.pane, &d.scope.lifetime, input, now)?;
                self.scheduler()?
                    .bind_input(d.ticket, &d.scope.pane, sequence)?;
            }
            Work::Barrier(Control::Bytes(hex)) => {
                self.reports(c, p, d.ticket, d.scope, vec![Input::Bytes(hex)], now)?
            }
            Work::Barrier(Control::Paste(text)) => {
                let snapshot = c
                    .committed(&d.scope.pane)
                    .and_then(|p| p.snapshot.as_ref())
                    .ok_or(Error::Scope)?;
                let sequence = c
                    .begin_paste(
                        &d.scope.pane,
                        &d.scope.lifetime,
                        &text,
                        snapshot.modes.bracketed_paste,
                        now,
                    )?
                    .ok_or(Error::Scope)?;
                self.active = Some(Active::Paste {
                    ticket: d.ticket,
                    scope: d.scope,
                    sequence,
                    cancelled: false,
                });
            }
            Work::Barrier(Control::Mouse(event)) => {
                let scope = pointer_scope(c, &d.scope)?;
                match self.mouse.route(&scope, event) {
                    PointerDecision::Input(input) => {
                        self.reports(c, p, d.ticket, d.scope, vec![input], now)?
                    }
                    PointerDecision::Ignore => self.finish(c, p, d.ticket, true, now)?,
                    PointerDecision::UnsupportedEncoding => {
                        self.finish(c, p, d.ticket, true, now)?;
                        return Err(Error::Unsupported);
                    }
                }
            }
            Work::Barrier(Control::Wheel(event)) => {
                let scope = pointer_scope(c, &d.scope)?;
                match tmux_pointer::route_wheel(&scope, p.history_offset(), event) {
                    WheelDecision::Application { inputs } => {
                        self.reports(c, p, d.ticket, d.scope, inputs, now)?
                    }
                    WheelDecision::History { lines } => {
                        if c.materialize_history(&d.scope.pane)? {
                            p.scroll_after_materialize(Scroll::Wheel(lines));
                        } else {
                            p.scroll(Scroll::Wheel(lines));
                        }
                        self.mouse.retire();
                        self.cancel_waiting();
                        self.finish(c, p, d.ticket, true, now)?;
                    }
                    WheelDecision::Ignore => self.finish(c, p, d.ticket, true, now)?,
                    WheelDecision::UnsupportedEncoding => {
                        self.finish(c, p, d.ticket, true, now)?;
                        return Err(Error::Unsupported);
                    }
                }
            }
            Work::Barrier(Control::Scroll(lines)) => {
                let command = if lines == 0 {
                    Scroll::End
                } else {
                    Scroll::Wheel(lines)
                };
                if c.materialize_history(&d.scope.pane)? {
                    p.scroll_after_materialize(command);
                } else {
                    p.scroll(command);
                }
                self.mouse.retire();
                self.cancel_waiting();
                self.finish(c, p, d.ticket, true, now)?;
            }
            Work::Barrier(Control::Select {
                pane,
                lifetime,
                operation,
                request,
            }) => {
                self.queued_selection = None;
                if c.select_pane(&pane, &lifetime, &operation, now)? {
                    self.active = Some(Active::Select {
                        ticket: d.ticket,
                        operation,
                        pane,
                        request,
                    });
                } else {
                    self.selection_notice(SelectionNotice {
                        pane,
                        request,
                        selected: true,
                    });
                    self.cancel_waiting();
                    self.finish(c, p, d.ticket, true, now)?;
                }
            }
        }
        Ok(())
    }
    fn reports(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        ticket: Ticket,
        scope: Scope,
        inputs: Vec<Input>,
        now: u64,
    ) -> Result<(), Error> {
        let mut remaining = VecDeque::from(inputs);
        let input = remaining.pop_front().ok_or(Error::Scope)?;
        let sequence = match c.input(&scope.pane, &scope.lifetime, input, now) {
            Ok(sequence) => sequence,
            Err(herdr_client::tmux_controller::Error::Control(
                herdr_client::tmux_control::Error::Capability,
            )) => {
                self.mouse.retire();
                return self.finish(c, p, ticket, true, now);
            }
            Err(error) => return Err(error.into()),
        };
        self.active = Some(Active::Reports {
            ticket,
            scope,
            sequence,
            remaining,
            cancelled: false,
        });
        Ok(())
    }
    fn finish(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        ticket: Ticket,
        success: bool,
        now: u64,
    ) -> Result<(), Error> {
        let next = self.scheduler()?.complete_barrier(ticket, success)?;
        if let Some(dispatch) = next.next {
            self.dispatch(c, p, dispatch, now)?;
        }
        Ok(())
    }
    fn resume(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        now: u64,
    ) -> Result<(), Error> {
        let ready = match self.active.as_ref() {
            Some(
                Active::ResumePaste { cancelled, .. } | Active::ResumeReports { cancelled, .. },
            ) => *cancelled || c.input_ready(),
            _ => false,
        };
        if !ready {
            return Ok(());
        }
        match self.active.take() {
            Some(Active::ResumePaste {
                ticket,
                scope,
                cancelled,
            }) => {
                if !cancelled && let Some(sequence) = c.next_paste(now)? {
                    self.active = Some(Active::Paste {
                        ticket,
                        scope,
                        sequence,
                        cancelled,
                    });
                } else {
                    self.finish(c, p, ticket, true, now)?;
                }
            }
            Some(Active::ResumeReports {
                ticket,
                scope,
                mut remaining,
                cancelled,
            }) => {
                if !cancelled && let Some(input) = remaining.pop_front() {
                    let sequence = c.input(&scope.pane, &scope.lifetime, input, now)?;
                    self.active = Some(Active::Reports {
                        ticket,
                        scope,
                        sequence,
                        remaining,
                        cancelled,
                    });
                } else {
                    self.finish(c, p, ticket, true, now)?;
                }
            }
            _ => return Err(Error::Scope),
        }
        Ok(())
    }
    pub fn complete(
        &mut self,
        c: &mut Controller,
        p: &mut NativePresentation,
        update: &Update,
        now: u64,
    ) -> Result<Option<SelectionNotice>, Error> {
        let pointer_scope = self.scheduler.as_ref().and_then(|scheduler| {
            (c.selected() == scheduler.scope().pane)
                .then(|| pointer_scope(c, scheduler.scope()).ok())
                .flatten()
        });
        self.observe_pointer(
            pointer_scope,
            update.window.as_ref().is_some_and(|window| window.coherent)
                && p.history_offset() == 0
                && c.owns(herdr_client::tmux_control::Authority::Input),
        );
        if let Some(scheduler) = self.scheduler.as_mut() {
            scheduler.set_dispatch_enabled(c.input_ready());
        }
        for completion in &update.inputs {
            let matched = match self.active.as_ref() {
                Some(
                    Active::Paste {
                        scope, sequence, ..
                    }
                    | Active::Reports {
                        scope, sequence, ..
                    },
                ) => completion.pane == scope.pane && completion.sequence == *sequence,
                _ => false,
            };
            if matched {
                let active = self.active.take().ok_or(Error::Scope)?;
                let success = completion.result == InputResult::Ok;
                match active {
                    Active::Paste {
                        ticket,
                        scope,
                        cancelled,
                        ..
                    } => {
                        if success && !cancelled && !c.input_ready() {
                            self.active = Some(Active::ResumePaste {
                                ticket,
                                scope,
                                cancelled,
                            });
                            continue;
                        }
                        if success
                            && !cancelled
                            && let Some(sequence) = c.next_paste(now)?
                        {
                            self.active = Some(Active::Paste {
                                ticket,
                                scope,
                                sequence,
                                cancelled: false,
                            });
                            continue;
                        }
                        self.finish(c, p, ticket, success, now)?;
                    }
                    Active::Reports {
                        ticket,
                        scope,
                        mut remaining,
                        cancelled,
                        ..
                    } => {
                        if success && !cancelled && !c.input_ready() {
                            self.active = Some(Active::ResumeReports {
                                ticket,
                                scope,
                                remaining,
                                cancelled,
                            });
                            continue;
                        }
                        if success
                            && !cancelled
                            && let Some(input) = remaining.pop_front()
                        {
                            let sequence = c.input(&scope.pane, &scope.lifetime, input, now)?;
                            self.active = Some(Active::Reports {
                                ticket,
                                scope,
                                sequence,
                                remaining,
                                cancelled: false,
                            });
                            continue;
                        }
                        self.finish(c, p, ticket, success, now)?;
                    }
                    Active::Select { .. }
                    | Active::ResumePaste { .. }
                    | Active::ResumeReports { .. } => return Err(Error::Scope),
                }
            } else if let Some(scheduler) = self.scheduler.as_mut() {
                let next = scheduler.complete_input(completion);
                if let Some(dispatch) = next.next {
                    self.dispatch(c, p, dispatch, now)?;
                }
            }
        }
        if let Some(selection) = &update.selection {
            if let Some(Active::Select {
                ticket,
                operation,
                pane,
                request,
            }) = self.active.take()
            {
                if operation != selection.operation_id || pane != selection.pane {
                    return Err(Error::Scope);
                }
                self.cancel_waiting();
                self.mouse.retire();
                self.finish(c, p, ticket, true, now)?;
                self.selection_notice(SelectionNotice {
                    pane,
                    request,
                    selected: selection.selected,
                });
            } else {
                return Err(Error::Scope);
            }
        }
        if self.retired() {
            return Err(herdr_client::tmux_input::Error::Retired.into());
        }
        self.resume(c, p, now)?;
        if let Some(dispatch) = self.scheduler.as_mut().and_then(Scheduler::take_ready) {
            self.dispatch(c, p, dispatch, now)?;
        }
        Ok(self.selection.take())
    }
}
fn pointer_scope(c: &Controller, scope: &Scope) -> Result<tmux_pointer::Scope, Error> {
    let committed = c.committed(&scope.pane).ok_or(Error::Scope)?;
    if committed.identity.generation != scope.lifetime.generation
        || committed.identity.incarnation != scope.lifetime.incarnation
    {
        return Err(Error::Scope);
    }
    let s = committed.snapshot.as_ref().ok_or(Error::Scope)?;
    Ok(tmux_pointer::Scope {
        generation: scope.lifetime.generation.clone(),
        incarnation: scope.lifetime.incarnation.clone(),
        presentation_epoch: scope.presentation_epoch,
        cols: s.cols,
        rows: s.rows,
        protocol: s.modes.mouse_protocol.clone(),
        encoding: s.modes.mouse_encoding.clone(),
        alternate_screen: s.modes.alternate_screen,
    })
}
fn mouse_event(command: pointer::Command) -> PointerEvent {
    match command {
        pointer::Command::Cancel { gesture } => PointerEvent::Cancel { gesture },
        pointer::Command::Event {
            action,
            gesture,
            row,
            col,
            button,
            shift,
            alt,
            control,
            protocol,
            encoding,
            cols,
            rows,
        } => PointerEvent::Report(tmux_pointer::Report {
            action: match action {
                pointer::Action::Down => tmux_pointer::Action::Down,
                pointer::Action::Drag => tmux_pointer::Action::Drag,
                pointer::Action::Move => tmux_pointer::Action::Move,
                pointer::Action::Up => tmux_pointer::Action::Up,
            },
            gesture,
            row: usize::from(row),
            col: usize::from(col),
            button,
            modifiers: tmux_pointer::Modifiers {
                shift,
                alt,
                control,
            },
            cols: usize::from(cols),
            rows: usize::from(rows),
            protocol: match protocol {
                decode::MouseProtocol::None => MouseProtocol::None,
                decode::MouseProtocol::X10 => MouseProtocol::X10,
                decode::MouseProtocol::Vt200 => MouseProtocol::Vt200,
                decode::MouseProtocol::Drag => MouseProtocol::Drag,
                decode::MouseProtocol::Any => MouseProtocol::Any,
            },
            encoding: match encoding {
                decode::MouseEncoding::Default => MouseEncoding::Default,
                decode::MouseEncoding::Utf8 => MouseEncoding::Utf8,
                decode::MouseEncoding::Sgr => MouseEncoding::Sgr,
                decode::MouseEncoding::SgrPixels => MouseEncoding::SgrPixels,
            },
        }),
    }
}
#[cfg(test)]
#[path = "browser_native_input_tests.rs"]
mod tests;
