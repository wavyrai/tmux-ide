//! Production clipboard acquisition -> AppKit Cmd-V -> isolated raw PTY readback.
use super::*;
use crate::sidebar::native_tests::Target;
use objc2_app_kit::NSPasteboard;
use objc2_foundation::{NSData, NSString};
use std::io::Cursor;

pub(super) async fn verify(handle: WindowHandle<HerdrWindow>, cx: &mut AsyncApp) -> Result<()> {
    cases(handle, "local", cx).await
}

pub(super) async fn verify_remote(cx: &mut AsyncApp) -> Result<()> {
    let handle = cx.update(|cx| {
        open_window(
            ConnectTarget::Ssh {
                target: "clipboard-fixture.invalid".into(),
                session: "default".into(),
            },
            updater::Updater::secondary(),
            cx,
            false,
        )
    })?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let ready =
            AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<bool> {
                let view = root
                    .downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                window.focus(&view.read(cx).focus.clone(), cx);
                window.refresh();
                window.draw(cx).clear(cx);
                Ok(view.read(cx).input_ready())
            })??;
        if ready {
            break;
        }
        if Instant::now() >= deadline {
            bail!("isolated SSH-shaped clipboard connection did not become ready");
        }
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
    }
    cases(handle, "remote", cx).await
}

async fn cases(handle: WindowHandle<HerdrWindow>, endpoint: &str, cx: &mut AsyncApp) -> Result<()> {
    let home = std::env::var_os("HOME").context("missing sandbox HOME")?;
    let source = std::path::PathBuf::from(home).join("clipboard-source.png");
    let mut fixtures = fixtures()?;
    let original = fixtures
        .iter()
        .find(|(name, _, _)| *name == "png")
        .context("PNG fixture missing")?
        .2
        .clone();
    let path = source.clone();
    cx.background_executor()
        .spawn(async move { std::fs::write(path, original) })
        .await?;
    fixtures.push((
        "path",
        "public.utf8-plain-text",
        source.to_string_lossy().as_bytes().to_vec(),
    ));
    for (case, kind, bytes) in fixtures {
        let name = format!("{endpoint}_{case}");
        wait(handle, cx, "clipboard input readiness", |view, _, cx| {
            Ok(view.read(cx).input_ready().then_some(()))
        })
        .await?;
        AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
            let view = root
                .downcast::<HerdrWindow>()
                .map_err(|_| anyhow!("unexpected root"))?;
            type_text(
                &format!("/usr/bin/python3 \"$HOME/clipboard_capture.py\" {name}"),
                &view,
                window,
                cx,
            )?;
            key("enter", window, cx)
        })??;
        let ready = format!("CLIP_READY_{name}");
        let target = wait(handle, cx, "raw clipboard receiver", |view, window, cx| {
            if view
                .read(cx)
                .live
                .surface
                .as_ref()
                .is_some_and(|s| has_output(&s.frame, &ready))
            {
                return Ok(Some(Target::acquire(window)?));
            }
            Ok(None)
        })
        .await?;
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if !board.setData_forType(Some(&NSData::with_bytes(&bytes)), &NSString::from_str(kind)) {
            bail!("cannot publish synthetic clipboard {name}");
        }
        target.paste()?;
        drop(target);
        // No wait for preparation: these must arrive after the reserved paste.
        AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
            let view = root
                .downcast::<HerdrWindow>()
                .map_err(|_| anyhow!("unexpected root"))?;
            type_text("!AFTER", &view, window, cx)?;
            key("enter", window, cx)
        })??;
        let done = format!("CLIP_DONE_{name}");
        let failed = format!("CLIP_FAIL_{name}");
        wait(
            handle,
            cx,
            "exact clipboard byte verification",
            |view, _, cx| {
                if view
                    .read(cx)
                    .live
                    .surface
                    .as_ref()
                    .is_some_and(|s| has_output(&s.frame, &failed))
                {
                    bail!("raw terminal clipboard assertion failed: {name}");
                }
                Ok(view
                    .read(cx)
                    .live
                    .surface
                    .as_ref()
                    .filter(|s| has_output(&s.frame, &done))
                    .map(|_| ()))
            },
        )
        .await?;
        eprintln!("GUI clipboard case verified: {name}, AppKit Cmd-V and subsequent input");
    }
    eprintln!(
        "GUI clipboard native PASS: {endpoint}, text, Unicode, multiline, PNG, TIFF, image path, exact PTY bytes and FIFO"
    );
    Ok(())
}

fn fixtures() -> Result<Vec<(&'static str, &'static str, Vec<u8>)>> {
    let mut fixtures = vec![
        ("text", "public.utf8-plain-text", b"plain text".to_vec()),
        (
            "unicode",
            "public.utf8-plain-text",
            "你好 café 🐏".as_bytes().to_vec(),
        ),
        (
            "multiline",
            "public.utf8-plain-text",
            "first\n第二行\nlast\n".as_bytes().to_vec(),
        ),
    ];
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        2,
        2,
        image::Rgba([17, 83, 191, 255]),
    ));
    for (name, kind, format) in [
        ("png", "public.png", image::ImageFormat::Png),
        ("tiff", "public.tiff", image::ImageFormat::Tiff),
    ] {
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format)?;
        fixtures.push((name, kind, bytes.into_inner()));
    }
    Ok(fixtures)
}
