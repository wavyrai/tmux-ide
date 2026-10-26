//! tmux-ide native capability receive boundary. Endpoint rights must be handed to
//! the producer through authenticated setup; this module does not publish names.
use crate::surface_port::SurfacePort;
use anyhow::{Result, ensure};
use mach2::{mach_port::*, message::*, port::*, traps::mach_task_self};
use std::mem::size_of;

const MESSAGE_ID: i32 = 0x54495053;
const ENDPOINT_MESSAGE_ID: i32 = 0x54495045;
#[repr(C)]
#[derive(Default)]
struct Message {
    header: mach_msg_header_t,
    body: mach_msg_body_t,
    surface: mach_msg_port_descriptor_t,
    ticket: [u8; 16],
    sequence: u64,
}
#[repr(C)]
struct Packet {
    message: Message,
    trailer: mach_msg_audit_trailer_t,
}
struct Received(Packet);
impl Drop for Received {
    fn drop(&mut self) {
        // SAFETY: constructed only after the kernel delivered a complete message
        // or a partial-body result. Kernel descriptor layout is valid, including
        // descriptors we reject; mach_msg_destroy frees their rights and mappings.
        unsafe { mach_msg_destroy(&mut self.0.message.header) };
    }
}

/// One owned send-right reference. A raw name is meaningful only in this task.
pub struct SendRight(mach_port_t);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendStatus {
    /// Queued in the kernel, not imported, painted or retired by the consumer.
    Queued,
    Backpressured,
    Interrupted,
}
impl SendRight {
    /// # Safety
    /// `name` must be one owned send-right reference obtained from authenticated
    /// native endpoint setup, not a numeric name decoded from wire metadata.
    pub unsafe fn from_received_right(name: mach_port_t) -> Result<Self> {
        ensure!(
            name != MACH_PORT_NULL && name != MACH_PORT_DEAD,
            "invalid surface endpoint right"
        );
        Ok(Self(name))
    }
    /// Nonblocking attempt. Ownership stays with the caller on every outcome;
    /// queued delivery carries a copy. Caller controls superseding/cancellation.
    pub fn try_send(
        &self,
        surface: &SurfacePort,
        ticket: [u8; 16],
        sequence: u64,
    ) -> Result<SendStatus> {
        self.send_named(surface.borrowed_name(), ticket, sequence)
    }
    fn send_named(&self, name: mach_port_t, ticket: [u8; 16], sequence: u64) -> Result<SendStatus> {
        self.send_port(name, ticket, sequence, MESSAGE_ID)
    }
    /// Transfer only an endpoint capability during mutual peer verification.
    /// No pixels are carried. Use a fresh reply inbox and an unpredictable
    /// challenge supplied by authenticated control setup for each handshake.
    pub fn try_send_endpoint(
        &self,
        endpoint: &SendRight,
        challenge: [u8; 16],
    ) -> Result<SendStatus> {
        self.send_port(endpoint.0, challenge, 1, ENDPOINT_MESSAGE_ID)
    }
    fn send_port(
        &self,
        name: mach_port_t,
        ticket: [u8; 16],
        sequence: u64,
        kind: i32,
    ) -> Result<SendStatus> {
        ensure!(
            ticket != [0; 16] && sequence > 0,
            "invalid surface send identity"
        );
        let mut message = Message {
            header: mach_msg_header_t {
                msgh_bits: MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0),
                msgh_size: size_of::<Message>() as u32,
                msgh_remote_port: self.0,
                msgh_id: kind,
                ..Default::default()
            },
            body: mach_msg_body_t {
                msgh_descriptor_count: 1,
            },
            surface: mach_msg_port_descriptor_t::new(name, MACH_MSG_TYPE_COPY_SEND),
            ticket,
            sequence,
        };
        // SAFETY: fixed initialized message; both rights are borrowed and copied,
        // never moved. Zero timeout plus INTERRUPT prevents implicit wait/retry.
        let status = unsafe {
            mach_msg(
                &mut message.header,
                MACH_SEND_MSG | MACH_SEND_TIMEOUT | MACH_SEND_INTERRUPT,
                size_of::<Message>() as u32,
                0,
                0,
                0,
                0,
            )
        };
        if status == MACH_MSG_SUCCESS {
            return Ok(SendStatus::Queued);
        }
        let code = status & !MACH_MSG_MASK;
        if code == MACH_SEND_TIMED_OUT || code == MACH_SEND_INTERRUPTED {
            // SAFETY: only these statuses pseudo-receive the copied rights back
            // into this message. Destroy those returned references, including the
            // destination copy, while leaving the caller's original references.
            // On other errors Mach either did nothing or destroyed copied rights;
            // destroying the original send buffer there would be incorrect.
            unsafe { mach_msg_destroy(&mut message.header) };
            return Ok(if code == MACH_SEND_TIMED_OUT {
                SendStatus::Backpressured
            } else {
                SendStatus::Interrupted
            });
        }
        anyhow::bail!("native surface send status {status}")
    }
    /// Borrow only for native capability transfer; never serialize as an endpoint.
    pub fn borrowed_name(&self) -> mach_port_t {
        self.0
    }
}
impl Drop for SendRight {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns one send/dead-name reference in this task.
        unsafe {
            mach_port_deallocate(mach_task_self(), self.0);
        }
    }
}
/// Full kernel audit identity, including the process incarnation. This value is
/// not secret and is not proof by itself: obtain the expected identity through
/// the authenticated control connection, never from the surface message body.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SenderIdentity([u32; 8]);
impl SenderIdentity {
    /// Producer identity to advertise over its authenticated control connection.
    pub fn current() -> Result<Self> {
        use mach2::task_info::{TASK_AUDIT_TOKEN, TASK_AUDIT_TOKEN_COUNT};
        let mut token = audit_token_t::default();
        let mut count = TASK_AUDIT_TOKEN_COUNT;
        // SAFETY: TASK_AUDIT_TOKEN writes exactly the initialized token's eight
        // natural_t words. The count is an in/out bound; only our own task is read.
        let status = unsafe {
            mach2::task::task_info(
                mach_task_self(),
                TASK_AUDIT_TOKEN,
                (&mut token as *mut audit_token_t).cast(),
                &mut count,
            )
        };
        ensure!(
            status == 0 && count == TASK_AUDIT_TOKEN_COUNT,
            "native surface sender query failed"
        );
        Self::from_authenticated_token(token.val)
    }
    pub fn from_authenticated_token(token: [u32; 8]) -> Result<Self> {
        ensure!(token != [0; 8], "missing native surface sender identity");
        Ok(Self(token))
    }
    pub fn token(self) -> [u32; 8] {
        self.0
    }
}
/// A kernel-delivered right with its untrusted correlation fields. Receiving is
/// not admission: the connection owner must match these against an authenticated
/// control offer before importing the right. Dropping this value frees the right.
pub struct Delivery {
    pub sender: SenderIdentity,
    pub ticket: [u8; 16],
    pub sequence: u64,
    pub surface: SurfacePort,
}
struct PortDelivery {
    sender: SenderIdentity,
    ticket: [u8; 16],
    sequence: u64,
    right: SendRight,
}
/// A connection-scoped receive right with a single queued message. Dropping it
/// destroys pending messages and their carried rights. Poll on the model worker.
pub struct Inbox {
    name: mach_port_t,
    last_sequence: u64,
}
impl Inbox {
    pub fn new() -> Result<(Self, SendRight)> {
        let mut name = 0;
        let mut options = mach_port_options_t {
            flags: MPO_QLIMIT | MPO_INSERT_SEND_RIGHT,
            mpl: mach_port_limits_t { mpl_qlimit: 1 },
            ..Default::default()
        };
        // SAFETY: both output and options pointers are valid for this call.
        let status = unsafe { mach_port_construct(mach_task_self(), &mut options, 0, &mut name) };
        ensure!(status == 0, "surface inbox construction status {status}");
        Ok((
            Self {
                name,
                last_sequence: 0,
            },
            SendRight(name),
        ))
    }
    /// Receive at most one message without waiting. The ticket comes from the
    /// admitted authenticated offer, and sequence must advance on this inbox.
    /// Rejected messages are destroyed rather than retained or automatically retried.
    pub fn try_receive(&mut self, ticket: [u8; 16], sequence: u64) -> Result<Option<SurfacePort>> {
        ensure!(
            sequence > self.last_sequence && ticket != [0; 16],
            "invalid surface handoff expectation"
        );
        let Some(delivery) = self.receive(None)? else {
            return Ok(None);
        };
        ensure!(
            delivery.ticket == ticket && delivery.sequence == sequence,
            "native surface ticket mismatch"
        );
        self.last_sequence = sequence;
        Ok(Some(delivery.surface))
    }
    /// Drain one kernel delivery without predicting control-channel arrival order.
    /// The receiver retains no unmatched rights. The caller must immediately bind
    /// this delivery to its bounded pending-offer table or drop it and request the
    /// fallback transport. Never import solely because this method succeeded.
    pub fn try_receive_next(&mut self) -> Result<Option<Delivery>> {
        let Some(delivery) = self.receive(None)? else {
            return Ok(None);
        };
        self.last_sequence = delivery.sequence;
        Ok(Some(delivery))
    }
    /// Reject any other kernel sender before transferring the surface right or
    /// advancing replay state. The expected token must be connection-authenticated
    /// and must never be reused after that connection or producer is replaced.
    pub fn try_receive_from(&mut self, expected: SenderIdentity) -> Result<Option<Delivery>> {
        let Some(delivery) = self.receive(Some(expected))? else {
            return Ok(None);
        };
        self.last_sequence = delivery.sequence;
        Ok(Some(delivery))
    }
    /// Receive an endpoint proof, not a surface. A wrong process, challenge or
    /// message kind drops the carried capability without advancing replay state.
    /// Dedicated fresh inboxes make each challenge response one-use.
    pub fn try_receive_endpoint(
        &mut self,
        expected: SenderIdentity,
        challenge: [u8; 16],
    ) -> Result<Option<SendRight>> {
        ensure!(challenge != [0; 16], "missing endpoint challenge");
        let Some(delivery) = self.receive_port(Some(expected), ENDPOINT_MESSAGE_ID)? else {
            return Ok(None);
        };
        ensure!(
            delivery.ticket == challenge && delivery.sequence == 1,
            "native endpoint challenge mismatch"
        );
        self.last_sequence = 1;
        Ok(Some(delivery.right))
    }
    fn receive(&mut self, expected: Option<SenderIdentity>) -> Result<Option<Delivery>> {
        let Some(delivery) = self.receive_port(expected, MESSAGE_ID)? else {
            return Ok(None);
        };
        // SAFETY: receive_port owns exactly one kernel-delivered send right.
        // Only after constructing its new owner do we forget the previous owner.
        let surface = unsafe { SurfacePort::from_received_right(delivery.right.0) }?;
        std::mem::forget(delivery.right);
        Ok(Some(Delivery {
            sender: delivery.sender,
            ticket: delivery.ticket,
            sequence: delivery.sequence,
            surface,
        }))
    }
    fn receive_port(
        &mut self,
        expected: Option<SenderIdentity>,
        kind: i32,
    ) -> Result<Option<PortDelivery>> {
        let mut packet = Packet {
            message: Message::default(),
            trailer: mach_msg_audit_trailer_t::default(),
        };
        // SAFETY: Packet starts with a correctly aligned message header, has the
        // declared writable capacity, and remains live throughout the syscall.
        // No MACH_RCV_LARGE: oversized messages are dequeued and destroyed by Mach.
        let status = unsafe {
            mach_msg(
                &mut packet.message.header,
                MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_INTERRUPT
                    // SDK MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT).
                    | ((MACH_RCV_TRAILER_AUDIT & 0xf) << 24) as mach_msg_option_t,
                0,
                size_of::<Packet>() as u32,
                self.name,
                0,
                MACH_PORT_NULL,
            )
        };
        if status == MACH_RCV_TIMED_OUT {
            return Ok(None);
        }
        if status & !MACH_MSG_MASK == MACH_RCV_BODY_ERROR {
            drop(Received(packet));
            anyhow::bail!("partial surface message status {status}");
        }
        ensure!(
            status == MACH_MSG_SUCCESS,
            "surface receive status {status}"
        );
        let mut received = Received(packet);
        let message = &mut received.0.message;
        ensure!(
            message.header.msgh_size as usize == size_of::<Message>()
                && message.header.msgh_id == kind
                && message.header.msgh_bits & MACH_MSGH_BITS_COMPLEX != 0
                && message.header.msgh_remote_port == MACH_PORT_NULL
                && message.header.msgh_voucher_port == MACH_PORT_NULL
                && message.header.msgh_local_port == self.name
                && message.body.msgh_descriptor_count == 1
                && message.surface.type_ == MACH_MSG_PORT_DESCRIPTOR as u8
                && message.surface.disposition == MACH_MSG_TYPE_MOVE_SEND as u8,
            "invalid native surface envelope"
        );
        ensure!(
            message.ticket != [0; 16] && message.sequence > self.last_sequence,
            "invalid native surface delivery identity"
        );
        ensure!(
            message.surface.name != MACH_PORT_NULL && message.surface.name != MACH_PORT_DEAD,
            "missing received surface right"
        );
        // The validated fixed message size places the kernel trailer exactly at
        // Packet.trailer. It is outside the sender's declared message body.
        let trailer = &received.0.trailer;
        ensure!(
            trailer.msgh_trailer_type == MACH_MSG_TRAILER_FORMAT_0
                && trailer.msgh_trailer_size as usize == size_of::<mach_msg_audit_trailer_t>(),
            "missing native surface audit trailer"
        );
        let sender = SenderIdentity::from_authenticated_token(trailer.msgh_audit.val)?;
        ensure!(
            expected.is_none_or(|expected| expected == sender),
            "native surface sender mismatch"
        );
        let name = message.surface.name;
        // Transfer precisely this received send-right reference out of the guard.
        message.surface.name = MACH_PORT_NULL;
        // SAFETY: the kernel delivered a send right, validated above; clearing its
        // descriptor prevents Received from deallocating the transferred reference.
        let right = unsafe { SendRight::from_received_right(name) }?;
        Ok(Some(PortDelivery {
            sender,
            ticket: message.ticket,
            sequence: message.sequence,
            right,
        }))
    }
}
impl Drop for Inbox {
    fn drop(&mut self) {
        // SAFETY: one owned receive right; other send-right references have their
        // own owners and become dead names when this receive right is destroyed.
        unsafe {
            mach_port_mod_refs(mach_task_self(), self.name, MACH_PORT_RIGHT_RECEIVE, -1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn send(endpoint: &SendRight, carried: &SendRight, ticket: [u8; 16], sequence: u64) {
        assert_eq!(
            endpoint
                .send_named(carried.borrowed_name(), ticket, sequence)
                .unwrap(),
            SendStatus::Queued
        );
    }
    fn references(right: &SendRight) -> u32 {
        unsafe extern "C" {
            fn mach_port_get_refs(
                task: mach_port_t,
                name: mach_port_t,
                kind: mach_port_right_t,
                refs: *mut u32,
            ) -> i32;
        }
        let mut count = 0;
        assert_eq!(
            unsafe {
                mach_port_get_refs(
                    mach_task_self(),
                    right.borrowed_name(),
                    MACH_PORT_RIGHT_SEND,
                    &mut count,
                )
            },
            0
        );
        count
    }
    #[test]
    fn kernel_handoff_is_nonblocking_scoped_and_one_use() {
        let (mut inbox, endpoint) = Inbox::new().unwrap();
        let (_other, carried) = Inbox::new().unwrap();
        let baseline = references(&carried);
        assert!(inbox.try_receive([1; 16], 1).unwrap().is_none());
        send(&endpoint, &carried, [2; 16], 1);
        assert!(inbox.try_receive([1; 16], 1).is_err());
        assert_eq!(
            references(&carried),
            baseline,
            "rejection leaked a transferred right"
        );
        send(&endpoint, &carried, [1; 16], 1);
        let received = inbox.try_receive([1; 16], 1).unwrap().unwrap();
        assert_eq!(references(&carried), baseline + 1);
        drop(received);
        assert_eq!(
            references(&carried),
            baseline,
            "accepted owner failed to release its right"
        );
        assert!(inbox.try_receive([1; 16], 1).is_err());
        assert!(inbox.try_receive([3; 16], 2).unwrap().is_none());
    }
    #[test]
    fn full_queue_pseudo_receive_releases_only_returned_copies() {
        let (mut inbox, endpoint) = Inbox::new().unwrap();
        let (_other, carried) = Inbox::new().unwrap();
        let original = references(&carried);
        let destination = references(&endpoint);
        send(&endpoint, &carried, [1; 16], 1);
        for _ in 0..32 {
            assert_eq!(
                endpoint
                    .send_named(carried.borrowed_name(), [2; 16], 2)
                    .unwrap(),
                SendStatus::Backpressured
            );
            assert_eq!(references(&carried), original);
            assert_eq!(references(&endpoint), destination);
        }
        drop(inbox.try_receive([1; 16], 1).unwrap().unwrap());
        assert_eq!(references(&carried), original);
        send(&endpoint, &carried, [2; 16], 2);
        drop(inbox.try_receive([2; 16], 2).unwrap().unwrap());
        assert_eq!(references(&carried), original);
    }
    #[test]
    fn disconnected_destination_preserves_caller_rights() {
        let (inbox, endpoint) = Inbox::new().unwrap();
        let (_other, carried) = Inbox::new().unwrap();
        let original = references(&carried);
        send(&endpoint, &carried, [1; 16], 1);
        drop(inbox); // queued copy is destroyed with the receive right.
        for _ in 0..8 {
            assert!(
                endpoint
                    .send_named(carried.borrowed_name(), [2; 16], 2)
                    .is_err()
            );
            assert_eq!(references(&carried), original);
        }
    }
}

#[cfg(test)]
#[path = "surface_delivery_tests.rs"]
mod delivery_tests;

#[cfg(test)]
#[path = "surface_endpoint_tests.rs"]
mod endpoint_tests;
