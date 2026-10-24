//! Reproducible WebSocket fragmentation of the actual TDC1 seed and patch packets.
use super::*;
use std::io::Write;

pub(super) fn send(socket: &mut WebSocket<TcpStream>, packet: &[u8], mut seed: u64) {
    let mut offset = 0;
    while offset < packet.len() {
        // Fixed seeds make every split reproducible without a random dependency.
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let length = (1 + ((seed >> 32) as usize % 113)).min(packet.len() - offset);
        let final_frame = offset + length == packet.len();
        let opcode = if offset == 0 { 2 } else { 0 };
        let mut wire = vec![opcode | if final_frame { 0x80 } else { 0 }, length as u8];
        wire.extend_from_slice(&packet[offset..offset + length]);
        // Server frames are unmasked. Split writes additionally exercise header
        // boundaries, though TCP is free to coalesce these writes on receipt.
        for bytes in wire.chunks(3) {
            socket.get_mut().write_all(bytes).unwrap();
        }
        offset += length;
        if !final_frame {
            // An unsolicited pong is legal between fragments and needs no reply.
            socket.get_mut().write_all(&[0x8a, 1, 0x5a]).unwrap();
        }
    }
}
