#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn rejects_invalid_canvas_before_allocation() {
    for (width, height, len) in [
        (0, 1, 0),
        (1, 0, 0),
        (16385, 1, 65540),
        (1, 1, 3),
        (1, 1, 5),
        (16384, 16384, 16384 * 16384 * 4),
        (usize::MAX, 1, 0),
    ] {
        assert!(matches!(row_bytes(width, height, len), Err(Error::Bounds)));
    }
}

#[test]
fn channel_order_and_alpha_are_explicit() {
    let input = [
        255, 0, 32, 255, 64, 32, 16, 128, 200, 100, 50, 0, 255, 0, 0, 1,
    ];
    let mut output = [0; 16];
    convert_row(&input, &mut output, false);
    assert_eq!(
        output,
        [
            32, 0, 255, 255, 16, 32, 64, 128, 50, 100, 200, 0, 0, 0, 255, 1
        ]
    );
    convert_row(&input, &mut output, true);
    assert_eq!(
        output,
        [32, 0, 255, 255, 32, 64, 128, 128, 0, 0, 0, 0, 0, 0, 255, 1]
    );
}

#[test]
#[allow(unsafe_code)]
fn canvas_copy_owns_pixels_and_handles_native_row_padding() {
    let mut input = vec![0; 3 * 2 * 4];
    for (i, pixel) in input.chunks_exact_mut(4).enumerate() {
        pixel.copy_from_slice(&[i as u8, 20, 40, 255]);
    }
    let buffer = copy_rgba(3, 2, &input, false).unwrap();
    input.fill(99);
    let lock = Locked::new(&buffer).unwrap();
    let stride = CVPixelBufferGetBytesPerRow(&buffer);
    let ptr = CVPixelBufferGetBaseAddress(&buffer).cast::<u8>();
    assert!(!ptr.is_null());
    // Buffer is locked and the fresh allocation reports at least stride * 2 bytes.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, stride * 2) };
    for (y, row) in bytes.chunks_exact(stride).enumerate() {
        for (x, pixel) in row[..12].chunks_exact(4).enumerate() {
            assert_eq!(pixel, &[40, 20, (y * 3 + x) as u8, 255]);
        }
        assert!(row[12..].iter().all(|b| *b == 0));
    }
    lock.finish().unwrap();
}
