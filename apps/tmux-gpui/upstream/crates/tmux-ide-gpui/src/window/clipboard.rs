//! Bounded clipboard acquisition, including image copies and hashing, off the UI thread.

use crate::{Error, Result};
use gpui::ClipboardItem;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use gpui::{Image, ImageFormat};

#[cfg(any(target_os = "macos", target_os = "linux", test))]
const TEXT_LIMIT: usize = 2 * 1024 * 1024;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const IMAGE_LIMIT: usize = super::image_source::MAX_IMAGE_INPUT_BYTES;

/// Blocking: invoke only on a background executor, never through an App context.
/// Normal paste reads text first and never fetches an image when text is present.
/// Image-only paste ignores text. No files, URLs, or clipboard metadata are followed.
pub(super) fn read(image_only: bool) -> Result<Option<ClipboardItem>> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::autoreleasepool;
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSString;

        autoreleasepool(|_| {
            let pasteboard = NSPasteboard::generalPasteboard();
            let revision = pasteboard.changeCount();
            let result = read_with(image_only, |format, limit| {
                let kind = NSString::from_str(match format {
                    None => "public.utf8-plain-text",
                    Some(ImageFormat::Png) => "public.png",
                    Some(ImageFormat::Jpeg) => "public.jpeg",
                    Some(ImageFormat::Gif) => "com.compuserve.gif",
                    Some(ImageFormat::Webp) => "org.webmproject.webp",
                    Some(ImageFormat::Bmp) => "com.microsoft.bmp",
                    Some(ImageFormat::Tiff) => "public.tiff",
                    Some(ImageFormat::Svg | ImageFormat::Ico | ImageFormat::Pnm) => {
                        return Err(Error::ImageFormat);
                    }
                });
                let Some(data) = pasteboard.dataForType(&kind) else {
                    return Ok(None);
                };
                // AppKit materializes NSData before exposing its length. Bound the
                // additional Rust allocation before copying, decoding, or hashing.
                if data.len() > limit {
                    return Err(Error::ClipboardSize { limit });
                }
                Ok(Some(data.to_vec()))
            });
            if pasteboard.changeCount() != revision {
                return Err(Error::ClipboardChanged);
            }
            result
        })
    }
    #[cfg(target_os = "linux")]
    {
        linux::read(image_only)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = image_only;
        Err(Error::ClipboardUnsupported)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn read_with(
    image_only: bool,
    mut acquire: impl FnMut(Option<ImageFormat>, usize) -> Result<Option<Vec<u8>>>,
) -> Result<Option<ClipboardItem>> {
    if !image_only && let Some(bytes) = acquire(None, TEXT_LIMIT)? {
        if bytes.len() > TEXT_LIMIT {
            return Err(Error::ClipboardSize { limit: TEXT_LIMIT });
        }
        let text = String::from_utf8(bytes)
            .map_err(|error| Error::ClipboardEncoding(error.utf8_error()))?;
        return Ok(Some(ClipboardItem::new_string(text)));
    }
    // TIFF is last: AppKit apps often publish it beside a PNG that needs no
    // conversion, while Preview and some browsers publish only TIFF.
    for format in [
        ImageFormat::Png,
        ImageFormat::Jpeg,
        ImageFormat::Gif,
        ImageFormat::Webp,
        ImageFormat::Bmp,
        ImageFormat::Tiff,
    ] {
        if let Some(bytes) = acquire(Some(format), IMAGE_LIMIT)? {
            if bytes.len() > IMAGE_LIMIT {
                return Err(Error::ClipboardSize { limit: IMAGE_LIMIT });
            }
            if !bytes.is_empty() {
                // From<Image> moves the bytes; new_image(&Image) would clone them.
                return Ok(Some(Image::from_bytes(format, bytes).into()));
            }
        }
    }
    Ok(None)
}

// Exercise the Unix process policy on macOS as well, without reading a real clipboard.
#[cfg(any(target_os = "linux", all(test, unix)))]
mod linux {
    use super::*;
    use std::{
        io::{self, Read},
        os::{fd::OwnedFd, unix::net::UnixStream},
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    #[cfg(target_os = "linux")]
    pub(super) fn read(image_only: bool) -> Result<Option<ClipboardItem>> {
        read_commands(
            image_only,
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            std::env::var_os("DISPLAY").is_some(),
            |program, args, limit, deadline| {
                output(Command::new(program).args(args), limit, deadline)
            },
        )
    }

    fn read_commands(
        image_only: bool,
        wayland: bool,
        x11: bool,
        mut run: impl FnMut(&str, &[&str], usize, Instant) -> Result<Option<Vec<u8>>>,
    ) -> Result<Option<ClipboardItem>> {
        // One deadline for the entire acquisition, not a fresh timeout per format.
        let deadline = Instant::now() + Duration::from_secs(3);
        read_with(image_only, |format, limit| {
            let types: &[&str] = match format {
                None => &["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"],
                Some(ImageFormat::Jpeg) => &["image/jpeg", "image/jpg"],
                Some(format) => &[format.mime_type()],
            };
            for mime in types {
                for (enabled, program, args) in [
                    (
                        wayland && *mime != "UTF8_STRING",
                        "wl-paste",
                        &["--no-newline", "--type", mime][..],
                    ),
                    (
                        x11,
                        "xclip",
                        &["-selection", "clipboard", "-t", mime, "-o"][..],
                    ),
                ] {
                    if !enabled {
                        continue;
                    }
                    if let Some(bytes) = run(program, args, limit, deadline)? {
                        if let Some(format) = format {
                            // Some X11 owners return text even for an image target.
                            // Inspect only the signature, never decode untrusted pixels.
                            let expected = match format {
                                ImageFormat::Png => image::ImageFormat::Png,
                                ImageFormat::Jpeg => image::ImageFormat::Jpeg,
                                ImageFormat::Gif => image::ImageFormat::Gif,
                                ImageFormat::Webp => image::ImageFormat::WebP,
                                ImageFormat::Bmp => image::ImageFormat::Bmp,
                                ImageFormat::Tiff => image::ImageFormat::Tiff,
                                ImageFormat::Svg | ImageFormat::Ico | ImageFormat::Pnm => {
                                    return Err(Error::ImageFormat);
                                }
                            };
                            if image::guess_format(&bytes).ok() != Some(expected) {
                                continue;
                            }
                        }
                        return Ok(Some(bytes));
                    }
                }
            }
            Ok(None)
        })
    }

    fn output(command: &mut Command, limit: usize, deadline: Instant) -> Result<Option<Vec<u8>>> {
        if Instant::now() >= deadline {
            return Err(Error::ClipboardTimeout);
        }
        // A nonblocking socket avoids reader threads that can outlive a timed-out
        // child when a descendant inherits stdout. Never merge stderr into images.
        let (mut reader, writer) = UnixStream::pair().map_err(Error::ClipboardProcess)?;
        reader
            .set_nonblocking(true)
            .map_err(Error::ClipboardProcess)?;
        let spawned = command
            .stdin(Stdio::null())
            .stdout(Stdio::from(OwnedFd::from(writer)))
            .stderr(Stdio::null())
            .spawn();
        command.stdout(Stdio::null());
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(Error::ClipboardProcess(error)),
        };
        let result = (|| {
            let mut bytes = Vec::new();
            let mut buffer = [0; 8192];
            let mut eof = false;
            loop {
                if Instant::now() >= deadline {
                    return Err(Error::ClipboardTimeout);
                }
                match reader.read(&mut buffer) {
                    Ok(0) => eof = true,
                    Ok(count) => {
                        if count > limit - bytes.len() {
                            return Err(Error::ClipboardSize { limit });
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                        continue;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(Error::ClipboardProcess(error)),
                }
                if let Some(status) = child.try_wait().map_err(Error::ClipboardProcess)?
                    && eof
                {
                    return Ok(status.success().then_some(bytes));
                }
                thread::sleep(Duration::from_millis(5));
            }
        })();
        if result.is_err() {
            let _ = child.kill();
        }
        let waited = child.wait().map_err(Error::ClipboardProcess);
        let result = result?;
        waited?;
        Ok(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn commands_preserve_text_and_skip_image_requests() -> Result<()> {
            let item = read_commands(false, true, true, |program, args, limit, _| {
                assert_eq!(program, "wl-paste");
                assert_eq!(args, ["--no-newline", "--type", "text/plain;charset=utf-8"]);
                assert_eq!(limit, TEXT_LIMIT);
                Ok(Some(b"text\n".to_vec()))
            })?;
            assert_eq!(item.and_then(|item| item.text()).as_deref(), Some("text\n"));
            Ok(())
        }

        #[test]
        fn image_commands_fall_back_and_reject_text_from_image_targets() -> Result<()> {
            let mut calls = Vec::new();
            let mut first_deadline = None;
            let item = read_commands(true, true, true, |program, args, limit, deadline| {
                assert_eq!(limit, IMAGE_LIMIT);
                assert_eq!(*first_deadline.get_or_insert(deadline), deadline);
                calls.push(program.to_owned());
                if program == "xclip" && args.contains(&"image/jpg") {
                    Ok(Some(vec![0xff, 0xd8, 0xff]))
                } else {
                    Ok(Some(b"not an image".to_vec()))
                }
            })?;
            assert_eq!(
                calls,
                [
                    "wl-paste", "xclip", "wl-paste", "xclip", "wl-paste", "xclip"
                ]
            );
            assert!(matches!(item.as_ref().map(|item| item.entries()),
                Some([gpui::ClipboardEntry::Image(image)]) if image.format == ImageFormat::Jpeg));
            assert!(
                read_commands(true, false, false, |_, _, _, _| panic!("no display"))?.is_none()
            );
            Ok(())
        }

        #[test]
        fn process_output_is_bounded_binary_and_separate_from_stderr() -> Result<()> {
            let run = |script, limit| {
                output(
                    Command::new("/bin/sh").args(["-c", script]),
                    limit,
                    Instant::now() + Duration::from_secs(3),
                )
            };
            assert_eq!(
                run("printf '\\377abc'; printf error >&2", 4)?,
                Some(vec![255, b'a', b'b', b'c'])
            );
            assert!(matches!(
                run("printf abcde", 4),
                Err(Error::ClipboardSize { limit: 4 })
            ));
            assert!(run("printf partial; exit 1", 16)?.is_none());
            assert_eq!(run("exit 0", 0)?, Some(Vec::new()));
            assert!(
                output(
                    &mut Command::new("/nonexistent/herdr-clipboard-helper"),
                    4,
                    Instant::now() + Duration::from_secs(3)
                )?
                .is_none()
            );
            Ok(())
        }

        #[test]
        fn timeout_covers_open_and_closed_stdout_and_continuous_output() {
            for script in [
                "exec sleep 30",
                "exec 1>&-; exec sleep 30",
                "while :; do printf x; done",
            ] {
                let start = Instant::now();
                let result = output(
                    Command::new("/bin/sh").args(["-c", script]),
                    usize::MAX,
                    start + Duration::from_millis(100),
                );
                assert!(matches!(result, Err(Error::ClipboardTimeout)));
                assert!(start.elapsed() < Duration::from_secs(5));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn text_precedes_images_even_when_empty() -> Result<()> {
        for text in ["", "text\n"] {
            let item = read_with(false, |format, limit| {
                assert_eq!(format, None);
                assert_eq!(limit, TEXT_LIMIT);
                Ok(Some(text.as_bytes().to_vec()))
            })?;
            // `ClipboardItem::text` reports empty text as `None`; inspect the entry.
            assert!(matches!(
                item.as_ref().map(ClipboardItem::entries),
                Some([gpui::ClipboardEntry::String(entry)]) if entry.text() == text
            ));
        }
        Ok(())
    }

    #[test]
    fn image_only_skips_text_and_empty_images() -> Result<()> {
        let item = read_with(true, |format, limit| {
            assert!(format.is_some());
            assert_eq!(limit, IMAGE_LIMIT);
            Ok(Some(if format == Some(ImageFormat::Jpeg) {
                vec![1, 2, 3]
            } else {
                Vec::new()
            }))
        })?;
        assert!(matches!(item.as_ref().map(|item| item.entries()),
            Some([gpui::ClipboardEntry::Image(image)]) if image.format == ImageFormat::Jpeg && image.bytes == [1, 2, 3]));
        assert!(read_with(true, |_, _| Ok(None))?.is_none());
        Ok(())
    }

    #[test]
    fn tiff_is_requested_only_after_every_bridge_format() -> Result<()> {
        let mut requested = Vec::new();
        let item = read_with(true, |format, _| {
            requested.push(format);
            Ok((format == Some(ImageFormat::Tiff)).then(|| vec![1, 2, 3]))
        })?;
        assert_eq!(
            requested,
            [
                Some(ImageFormat::Png),
                Some(ImageFormat::Jpeg),
                Some(ImageFormat::Gif),
                Some(ImageFormat::Webp),
                Some(ImageFormat::Bmp),
                Some(ImageFormat::Tiff),
            ]
        );
        assert!(matches!(item.as_ref().map(|item| item.entries()),
            Some([gpui::ClipboardEntry::Image(image)]) if image.format == ImageFormat::Tiff));
        Ok(())
    }

    #[test]
    fn size_and_encoding_errors_never_fall_through_to_images() -> Result<()> {
        for image_only in [false, true] {
            let limit = if image_only { IMAGE_LIMIT } else { TEXT_LIMIT };
            // Acquisition rejects oversized native data before copying or hashing it.
            // Exercise that contract without allocating a 128 MiB test clipboard.
            assert!(matches!(read_with(image_only, |_, requested| {
                    assert_eq!(requested, limit);
                    Err(Error::ClipboardSize { limit: requested })
                }),
                Err(Error::ClipboardSize { limit: actual }) if actual == limit));
        }
        assert!(read_with(false, |_, _| Ok(Some(vec![b'a'; TEXT_LIMIT])))?.is_some());
        assert!(matches!(
            read_with(false, |_, _| Ok(Some(vec![b'a'; TEXT_LIMIT + 1]))),
            Err(Error::ClipboardSize { limit: TEXT_LIMIT })
        ));
        let result = read_with(false, |format, _| {
            assert_eq!(format, None);
            Ok(Some(vec![255]))
        });
        assert!(matches!(result, Err(Error::ClipboardEncoding(_))));
        if let Err(error) = result {
            assert!(
                error
                    .source()
                    .is_some_and(|source| source.is::<std::str::Utf8Error>())
            );
        }
        Ok(())
    }

    #[test]
    fn image_acquisition_allows_resize_inputs_above_the_upload_limit() -> Result<()> {
        assert_eq!(IMAGE_LIMIT, 128 * 1024 * 1024);
        let bytes = vec![0; herdr_client::protocol::MAX_CLIPBOARD_IMAGE_PAYLOAD + 1];
        let pointer = bytes.as_ptr();
        let mut bytes = Some(bytes);
        let item = read_with(true, |format, limit| {
            assert_eq!(format, Some(ImageFormat::Png));
            assert_eq!(limit, IMAGE_LIMIT);
            Ok(bytes.take())
        })?;
        assert!(matches!(item.as_ref().map(|item| item.entries()),
            Some([gpui::ClipboardEntry::Image(image)])
                if image.bytes.as_ptr() == pointer
                    && image.bytes.len() > herdr_client::protocol::MAX_CLIPBOARD_IMAGE_PAYLOAD));
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn unsupported_platform_is_explicit() {
        assert!(matches!(read(true), Err(Error::ClipboardUnsupported)));
    }
}
