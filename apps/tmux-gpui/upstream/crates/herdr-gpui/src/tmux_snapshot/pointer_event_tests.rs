use super::*;
use crate::tmux_snapshot::pointer::{Action, Command};
#[gpui::test]
fn pointer_selected_painted_press_release_and_shift_stays_local(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        let frame = view.frame.as_ref().unwrap();
        view.browser_state.request = view.browser_request;
        view.browser_state.input_ready = true;
        view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
            id: "pane-a".into(),
            left: 0,
            top: 0,
            width: frame.width,
            height: frame.height,
            wrapped: vec![false; usize::from(frame.height)],
        });
        let content = view.browser_state.copy_region.as_ref().unwrap();
        view.browser_state.regions = vec![crate::tmux_snapshot::hit_regions::Region {
            id: content.id.clone(),
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
        }];
        view.browser_state.pointer_modes = Some(decode::PointerModes {
            protocol: decode::MouseProtocol::Vt200,
            encoding: decode::MouseEncoding::Sgr,
            alternate: false,
        });
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        let bounds = view.input_geometry.unwrap().0;
        let position = bounds.origin
            + point(
                px(view.input_cell_width.unwrap() * 0.5),
                px(view.terminal_height() * 0.5),
            );
        assert!(view.pointer_event(
            Action::Down,
            position,
            Some(MouseButton::Left),
            Modifiers::default(),
            cx
        ));
        view.frame = Some(Arc::new((**view.frame.as_ref().unwrap()).clone()));
        assert!(!crate::tmux_snapshot::hit_regions::is_painted(
            view.frame.as_ref(),
            view.painted_frame.as_ref()
        ));
        assert!(view.pointer_event(
            Action::Up,
            position,
            Some(MouseButton::Left),
            Modifiers::default(),
            cx
        ));
        assert!(!view.pointer_event(
            Action::Down,
            position,
            Some(MouseButton::Left),
            Modifiers {
                shift: true,
                ..Default::default()
            },
            cx
        ));
    });
    let commands: Vec<_> = receiver.try_iter().collect();
    assert_eq!(commands.len(), 2);
    assert!(matches!(
        &commands[0],
        browser::Command::Input {
            input: Input::Mouse(Command::Event {
                action: Action::Down,
                row: 0,
                col: 0,
                ..
            }),
            ..
        }
    ));
    assert!(matches!(
        &commands[1],
        browser::Command::Input {
            input: Input::Mouse(Command::Event {
                action: Action::Up,
                ..
            }),
            ..
        }
    ));
}
#[gpui::test]
fn pointer_mode_loss_cancels_and_late_release_is_not_delivered(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        let frame = view.frame.as_ref().unwrap();
        view.browser_state.request = view.browser_request;
        view.browser_state.input_ready = true;
        view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
            id: "pane-a".into(),
            left: 0,
            top: 0,
            width: frame.width,
            height: frame.height,
            wrapped: vec![false; usize::from(frame.height)],
        });
        let content = view.browser_state.copy_region.as_ref().unwrap();
        view.browser_state.regions = vec![crate::tmux_snapshot::hit_regions::Region {
            id: content.id.clone(),
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
        }];
        view.browser_state.pointer_modes = Some(decode::PointerModes {
            protocol: decode::MouseProtocol::Any,
            encoding: decode::MouseEncoding::Sgr,
            alternate: false,
        });
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        let position = view.input_geometry.unwrap().0.origin
            + point(
                px(view.input_cell_width.unwrap() * 0.5),
                px(view.terminal_height() * 0.5),
            );
        assert!(view.pointer_event(
            Action::Down,
            position,
            Some(MouseButton::Right),
            Modifiers::default(),
            cx
        ));
        view.browser_state.pointer_modes = None;
        view.observe_pointer();
        assert!(!view.pointer_event(
            Action::Up,
            position,
            Some(MouseButton::Right),
            Modifiers::default(),
            cx
        ));
    });
    let commands: Vec<_> = receiver.try_iter().collect();
    assert_eq!(commands.len(), 2);
    assert!(matches!(
        &commands[1],
        browser::Command::Input {
            input: Input::Mouse(Command::Cancel { .. }),
            ..
        }
    ));
}
#[test]
fn pointer_serialization_is_semantic_and_modes_are_explicit() {
    let value = serde_json::to_value(Input::Mouse(Command::Event {
        action: Action::Down,
        gesture: 1,
        row: 2,
        col: 4,
        button: Some(0),
        shift: false,
        alt: false,
        control: false,
        protocol: decode::MouseProtocol::Vt200,
        encoding: decode::MouseEncoding::Sgr,
        cols: 80,
        rows: 24,
    }))
    .unwrap();
    assert_eq!(value["kind"], "mouse");
    assert_eq!(value["data"]["action"], "down");
    assert_eq!(value["data"]["protocol"], "vt200");
    assert_eq!(
        serde_json::to_value(Input::Mouse(Command::Cancel { gesture: 1 })).unwrap()["data"]["action"],
        "cancel"
    );
}
#[gpui::test]
fn pointer_uses_content_origin_and_refuses_headers_and_geometry_changes(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(128);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    for (left, top, width, height) in [(0, 1, 8, 7), (0, 0, 8, 7), (0, 0, 8, 8), (9, 5, 8, 7)] {
        view.update(cx,|view,cx|{
  view.browser_state.request=view.browser_request;view.browser_state.input_ready=true;
  view.browser_state.pointer_modes=Some(decode::PointerModes{protocol:decode::MouseProtocol::Drag,encoding:decode::MouseEncoding::Sgr,alternate:false});
  view.browser_state.copy_region=Some(crate::tmux_snapshot::copy::Region{id:"pane-a".into(),left,top,width,height,wrapped:vec![false;usize::from(height)]});
  view.browser_state.regions=vec![crate::tmux_snapshot::hit_regions::Region{id:"pane-a".into(),left,top:0,width,height:top+height}];
  view.painted_frame=view.frame.clone();
  let origin=view.input_geometry.unwrap().0.origin;
  let cell=view.input_cell_width.unwrap();let row=view.terminal_height();
  let position=origin+point(px((f32::from(left)+2.5)*cell),px((f32::from(top)+3.5)*row));
  if top>0 {assert!(!view.pointer_event(Action::Down,origin+point(px((f32::from(left)+0.5)*cell),px((f32::from(top)-0.5)*row)),Some(MouseButton::Left),Modifiers::default(),cx));}
  assert!(view.pointer_event(Action::Down,position,Some(MouseButton::Left),Modifiers::default(),cx));
  assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input{input:Input::Mouse(Command::Event{row:3,col:2,cols:8,rows,..}),..} if rows==height));
  view.browser_state.copy_region.as_mut().unwrap().width+=1;
  view.observe_pointer();
  assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input{input:Input::Mouse(Command::Cancel{..}),..}));
  assert!(!view.pointer_event(Action::Up,position,Some(MouseButton::Left),Modifiers::default(),cx));
 });
    }
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn pointer_interruption_retires_before_release(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        view.browser_state.request = view.browser_request;
        view.browser_state.input_ready = true;
        view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
            id: "pane-a".into(),
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            wrapped: vec![false],
        });
        let content = view.browser_state.copy_region.as_ref().unwrap();
        view.browser_state.regions = vec![crate::tmux_snapshot::hit_regions::Region {
            id: content.id.clone(),
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
        }];
        view.browser_state.pointer_modes = Some(decode::PointerModes {
            protocol: decode::MouseProtocol::Any,
            encoding: decode::MouseEncoding::Sgr,
            alternate: false,
        });
        view.painted_frame = view.frame.clone();
        let position = view.input_geometry.unwrap().0.origin
            + point(
                px(view.input_cell_width.unwrap() * 0.5),
                px(view.terminal_height() * 0.5),
            );
        assert!(view.pointer_event(
            Action::Down,
            position,
            Some(MouseButton::Left),
            Modifiers::default(),
            cx
        ));
        view.interrupt_input(cx);
        assert!(!view.pointer_event(
            Action::Up,
            position,
            Some(MouseButton::Left),
            Modifiers::default(),
            cx
        ));
    });
    let observed: Vec<_> = receiver.try_iter().collect();
    eprintln!(
        "pointer-interruption commands: {}",
        serde_json::to_string(&observed).unwrap()
    );
    let commands: Vec<_> = observed
        .into_iter()
        .filter(|command| {
            // The view may enqueue its first geometry update after cx.notify().
            !matches!(
                command,
                browser::Command::Input {
                    input: Input::Resize { .. },
                    ..
                }
            )
        })
        .collect();
    assert_eq!(
        commands.len(),
        2,
        "{}",
        serde_json::to_string(&commands).unwrap()
    );
    assert!(matches!(
        &commands[1],
        browser::Command::Input {
            input: Input::Mouse(Command::Cancel { .. }),
            ..
        }
    ));
}
