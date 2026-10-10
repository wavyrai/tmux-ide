//! Keep all pasteboard items/types opaque and in memory, including on GUI failure.
//! The parent owns restoration so killing a timed-out GUI cannot lose the clipboard.
#![allow(clippy::expect_used)]
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
use objc2_foundation::NSArray;

pub struct ClipboardGuard(Vec<Retained<NSPasteboardItem>>);

impl ClipboardGuard {
    pub fn acquire() -> Self {
        let board = NSPasteboard::generalPasteboard();
        let revision = board.changeCount();
        let mut saved = Vec::new();
        if let Some(items) = board.pasteboardItems() {
            for item in items {
                let copy = NSPasteboardItem::new();
                for kind in item.types() {
                    let data = item
                        .dataForType(&kind)
                        .expect("clipboard type unavailable; refusing to replace clipboard");
                    assert!(copy.setData_forType(&data, &kind));
                }
                saved.push(copy);
            }
        }
        assert_eq!(
            revision,
            board.changeCount(),
            "clipboard changed during backup"
        );
        let guard = Self(saved);
        board.clearContents();
        guard
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if !self.0.is_empty() {
            let items: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = self
                .0
                .iter()
                .map(|item| ProtocolObject::from_ref(&**item))
                .collect();
            assert!(
                board.writeObjects(&NSArray::from_slice(&items)),
                "clipboard restoration failed"
            );
        }
    }
}

#[test]
#[ignore = "uses the real macOS clipboard; run native tests serially"]
fn native_clipboard_restore_preserves_items_types_and_empty_state() {
    use objc2_foundation::{NSData, NSString};

    let _personal = ClipboardGuard::acquire();
    let board = NSPasteboard::generalPasteboard();
    let expected = [
        vec![
            ("public.utf8-plain-text", b"synthetic text".as_slice()),
            ("org.herdr.synthetic", &[0, 255, 17]),
        ],
        vec![("org.herdr.synthetic.second", b"second item".as_slice())],
    ];
    let items = expected
        .iter()
        .map(|types| {
            let item = NSPasteboardItem::new();
            for (kind, bytes) in types {
                assert!(
                    item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind))
                );
            }
            item
        })
        .collect::<Vec<_>>();
    let writers = items
        .iter()
        .map(|item| ProtocolObject::<dyn NSPasteboardWriting>::from_ref(&**item))
        .collect::<Vec<_>>();
    assert!(board.writeObjects(&NSArray::from_slice(&writers)));
    {
        let _synthetic = ClipboardGuard::acquire();
        assert!(board.setString_forType(
            &NSString::from_str("replacement"),
            &NSString::from_str("public.utf8-plain-text")
        ));
    }
    let actual = board.pasteboardItems().expect("restored synthetic items");
    assert_eq!(actual.len(), expected.len());
    for (item, types) in actual.iter().zip(&expected) {
        assert_eq!(item.types().len(), types.len());
        for (kind, bytes) in types {
            // Only synthetic bytes are inspected or compared here.
            assert_eq!(
                item.dataForType(&NSString::from_str(kind))
                    .expect("restored synthetic type")
                    .to_vec(),
                *bytes
            );
        }
    }
    board.clearContents();
    {
        let _empty = ClipboardGuard::acquire();
        assert!(board.setString_forType(
            &NSString::from_str("replacement"),
            &NSString::from_str("public.utf8-plain-text")
        ));
    }
    assert!(board.pasteboardItems().is_none_or(|items| items.is_empty()));
}
