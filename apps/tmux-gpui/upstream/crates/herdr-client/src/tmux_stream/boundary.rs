//! Observes framing boundaries only; tungstenite owns all protocol validation and decoding.
//! Its read buffer can contain a complete message followed by a partial next frame.
//! Observing the bytes read from TCP prevents commands crossing that partial boundary.
#[derive(Default)]
pub(super) struct Boundary {
    upgraded: bool,
    delimiter: u32,
    header: [u8; 14],
    header_len: usize,
    payload: Option<u64>,
    fragmented: bool,
    binary: bool,
    binary_bytes: u64,
    binary_oversized: bool,
}

impl Boundary {
    pub(super) fn binary_oversized(&self) -> bool {
        self.binary_oversized
    }
    pub(super) fn is_partial(&self) -> bool {
        !self.upgraded || self.header_len != 0 || self.payload.is_some() || self.fragmented
    }

    pub(super) fn observe(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if !self.upgraded {
                self.delimiter = (self.delimiter << 8) | u32::from(bytes[0]);
                bytes = &bytes[1..];
                self.upgraded = self.delimiter == 0x0d0a0d0a;
                continue;
            }
            if let Some(remaining) = self.payload {
                let take = remaining.min(bytes.len() as u64) as usize;
                bytes = &bytes[take..];
                let remaining = remaining - take as u64;
                if remaining == 0 {
                    self.finish_frame();
                } else {
                    self.payload = Some(remaining);
                }
                continue;
            }
            self.header[self.header_len] = bytes[0];
            self.header_len += 1;
            bytes = &bytes[1..];
            if self.header_len < 2 {
                continue;
            }
            let length_code = self.header[1] & 0x7f;
            let extended = match length_code {
                126 => 2,
                127 => 8,
                _ => 0,
            };
            let mask = if self.header[1] & 0x80 != 0 { 4 } else { 0 };
            if self.header_len < 2 + extended + mask {
                continue;
            }
            let length = match extended {
                2 => u64::from(u16::from_be_bytes([self.header[2], self.header[3]])),
                8 => self.header[2..10]
                    .iter()
                    .fold(0_u64, |total, byte| (total << 8) | u64::from(*byte)),
                _ => u64::from(length_code),
            };
            let opcode = self.header[0] & 0x0f;
            if opcode == 2 {
                self.binary = true;
                self.binary_bytes = 0;
            }
            if self.binary && (opcode == 2 || opcode == 0) {
                self.binary_bytes = self.binary_bytes.saturating_add(length);
                if self.binary_bytes > 8 + 4096 + 512 * 1024 {
                    self.binary_oversized = true;
                    return;
                }
            }
            if length == 0 {
                self.finish_frame();
            } else {
                self.payload = Some(length);
            }
        }
    }

    fn finish_frame(&mut self) {
        let opcode = self.header[0] & 0x0f;
        // Control frames can occur within a fragmented data message.
        if opcode < 8 {
            self.fragmented = self.header[0] & 0x80 == 0;
            if !self.fragmented {
                self.binary = false;
            }
        }
        self.payload = None;
        self.header_len = 0;
    }
}
