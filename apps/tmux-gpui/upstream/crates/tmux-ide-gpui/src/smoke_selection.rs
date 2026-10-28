//! Live daemon output -> exact-window AppKit drag -> OS clipboard -> normal
//! paste -> shell byte readback. Only the opt-in macOS native harness calls this.
use super::*;
use crate::sidebar::native_tests::Target;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub(super) async fn verify(handle: WindowHandle<HerdrWindow>, cx: &mut AsyncApp) -> Result<()> {
    let previous = cx.update(|cx| cx.read_from_clipboard());
    let result = cases(handle, cx).await;
    if let Some(previous) = previous {
        cx.update(|cx| cx.write_to_clipboard(previous));
    }
    result
}

async fn cases(handle: WindowHandle<HerdrWindow>, cx: &mut AsyncApp) -> Result<()> {
    wait(handle, cx, "selection input readiness", |view, _, cx| {
        Ok(view.read(cx).input_ready().then_some(()))
    })
    .await?;
    for (index, (expected, reverse)) in
        [("你好世界", false), ("你好世界", true), ("A你 好B ", false)]
            .into_iter()
            .enumerate()
    {
        let marker = format!("CJK_{}_{index}:", std::process::id());
        AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
            // Separate printf arguments keep the command echo from matching
            // the output row, even if the shell wraps its input.
            let view = root
                .downcast::<HerdrWindow>()
                .map_err(|_| anyhow!("unexpected window root"))?;
            window.focus(&view.read(cx).focus.clone(), cx);
            type_text(
                &format!("printf '%s%s%s\\n' '{marker}' '{expected}' ':END'"),
                &view,
                window,
                cx,
            )?;
            key("enter", window, cx)
        })??;

        let (target, from, to) = wait(handle, cx, "CJK output", |view, window, cx| {
            let state = view.read(cx);
            let Some(surface) = state
                .live
                .surface
                .as_ref()
                .filter(|_| state.live.surface_ready())
            else {
                return Ok(None);
            };
            let pane = surface
                .panes
                .iter()
                .find(|pane| pane.focused)
                .context("focused pane missing")?;
            let rect = pane.inner_rect;
            'rows: for row in rect.y..rect.y + rect.height {
                let offset = usize::from(row) * usize::from(surface.frame.width);
                let cells = &surface.frame.cells
                    [offset + usize::from(rect.x)..offset + usize::from(rect.x + rect.width)];
                if cells
                    .iter()
                    .take(marker.len())
                    .map(|cell| cell.symbol.as_str())
                    .collect::<String>()
                    != marker
                {
                    continue;
                }
                let mut column = marker.len();
                for ch in expected.chars().chain(":END".chars()) {
                    let Some(cell) = cells.get(column) else {
                        bail!("CJK fixture wrapped")
                    };
                    if cell.symbol != ch.to_string() {
                        // PTY output may arrive in several surface updates;
                        // the prefix alone does not mean the row is complete.
                        continue 'rows;
                    }
                    column += ch.width().unwrap_or(1).max(1);
                }
                // Report the actual wire representation for diagnosing daemon
                // version differences without deriving the expected clipboard
                // value from the selection algorithm under test.
                eprintln!(
                    "GUI CJK daemon cells: {:?}",
                    &cells[marker.len()..marker.len() + expected.width()]
                );
                let point = |column: f32| {
                    let position = state.bounds.origin
                        + point(
                            px((f32::from(rect.x) + column) * state.cell_width),
                            px((f32::from(row) + 0.5) * state.config.terminal.line_height()),
                        );
                    (
                        f64::from(f32::from(position.x)),
                        f64::from(f32::from(position.y)),
                    )
                };
                let from = point(marker.len() as f32 + 0.1);
                let to = point((marker.len() + expected.width()) as f32 - 0.1);
                return Ok(Some((Target::acquire(window)?, from, to)));
            }
            Ok(None)
        })
        .await?;

        cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string("before CJK drag".into())));
        // AppKit reenters GPUI, so dispatch only after the update releases it.
        target.drag(
            if reverse { to } else { from },
            if reverse { from } else { to },
        )?;
        drop(target);
        cx.update(|cx| -> Result<()> {
            let actual = cx.read_from_clipboard().and_then(|item| item.text());
            if actual.as_deref() != Some(expected) {
                bail!("CJK clipboard mismatch: expected {expected:?}, got {actual:?}");
            }
            Ok(())
        })?;

        // Fixed test strings contain no shell quotes. Hex readback distinguishes
        // actual shell output from both command echo and terminal cell padding.
        AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
            let view = root
                .downcast::<HerdrWindow>()
                .map_err(|_| anyhow!("unexpected window root"))?;
            type_text(
                &format!("printf 'READ_{index}:'; printf '%s' '"),
                &view,
                window,
                cx,
            )?;
            key("cmd-v", window, cx)?;
            type_text(
                "' | od -An -tx1 | tr -d ' \\n'; printf '\\n'",
                &view,
                window,
                cx,
            )?;
            key("enter", window, cx)
        })??;
        let hex = format!(
            "READ_{index}:{}",
            expected
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        wait(handle, cx, "CJK paste byte readback", |view, _, cx| {
            Ok(view
                .read(cx)
                .live
                .surface
                .as_ref()
                .filter(|s| has_output(&s.frame, &hex))
                .map(|_| ()))
        })
        .await?;
    }
    eprintln!(
        "GUI CJK selection verified: native forward/reverse drag, exact clipboard, real spaces, paste byte readback"
    );
    Ok(())
}
