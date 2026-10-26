//! The transport worker's native endpoint and storage owner. Construct only after
//! authenticated same-host provider negotiation; never infer locality from TCP.
use super::Image;
use gpui_apple::{
    surface_inbox::SenderIdentity, surface_receiver::Receiver, surface_rendezvous::Registration,
};
use herdr_client::{
    tmux_graphics::{surface_control::FallbackReason, surface_session::Session},
    tmux_native_session::CommittedPane,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native surface control failed")]
    Control(#[from] herdr_client::tmux_graphics::surface_session::Error),
    #[error("native surface platform endpoint failed")]
    Platform(#[source] anyhow::Error),
    #[error("native surface handoff has no current admitted pane")]
    Identity,
    #[error("native surface image import failed")]
    Import(#[from] super::Error),
}

/// One original authenticated socket owns this object. Never transfer it to a
/// replacement socket. Imported Images may outlive it, but cannot emit old ACKs.
pub struct Connection {
    session: Session,
    nonce: Uuid,
    registration: Option<Registration>,
    receiver: Option<Receiver>,
    deadline: Instant,
}
impl Connection {
    pub fn set_waker(&mut self, wake: herdr_client::tmux_native_session::surfaces::WakeSender) {
        self.session.set_waker(wake);
    }
    pub fn waiting(&self) -> bool {
        self.registration.is_some()
            || self
                .receiver
                .as_ref()
                .is_some_and(|receiver| !receiver.ready())
            || self.session.has_pending()
    }
    /// Registration is prepared on the worker before publishing receiver_frame.
    /// A failed constructor drops it and revokes the rendezvous automatically.
    pub fn new(generation: Uuid, registration: Registration) -> Result<Self, Error> {
        Self::with_nonce(generation, Uuid::new_v4(), registration)
    }
    pub fn nonce(&self) -> Uuid {
        self.nonce
    }
    pub fn with_nonce(
        generation: Uuid,
        nonce: Uuid,
        registration: Registration,
    ) -> Result<Self, Error> {
        let identity = SenderIdentity::current().map_err(Error::Platform)?;
        Ok(Self {
            nonce,
            session: Session::with_nonce(
                generation,
                nonce,
                std::process::id(),
                registration.slot(),
                identity.token(),
            )?,
            registration: Some(registration),
            receiver: None,
            deadline: Instant::now() + Duration::from_secs(5),
        })
    }
    pub fn receiver_frame(&self) -> Result<String, Error> {
        Ok(self.session.receiver_frame()?)
    }
    pub fn accept_peer(&mut self, raw: &[u8]) -> Result<(), Error> {
        if !self.session.accept_peer(raw)? {
            return Ok(());
        }
        let peer = self.session.expected_peer().ok_or(Error::Identity)?;
        let registration = self.registration.take().ok_or(Error::Identity)?;
        self.receiver = Some(
            Receiver::new(
                registration,
                SenderIdentity::from_authenticated_token(peer).map_err(Error::Platform)?,
                self.session.challenge(),
                self.deadline,
            )
            .map_err(Error::Platform)?,
        );
        Ok(())
    }
    /// Nonblocking worker tick. A returned fallback belongs to this socket only.
    /// Offer admission remains disabled until reciprocal kernel proof completes.
    pub fn poll(&mut self, now: Instant) -> Result<Option<String>, Error> {
        if let Some(frame) = self.session.poll(now)? {
            self.registration = None;
            self.receiver = None;
            return Ok(Some(frame));
        }
        if let Some(receiver) = &mut self.receiver
            && !receiver.ready()
        {
            match receiver.poll(now) {
                Ok(true) => self
                    .session
                    .confirm_kernel_peer(self.session.expected_peer().ok_or(Error::Identity)?)?,
                Ok(false) => {}
                Err(_) => return self.fallback(FallbackReason::Identity).map(Some),
            }
        }
        Ok(None)
    }
    pub fn admit(
        &mut self,
        raw: &[u8],
        pane: &str,
        current: &CommittedPane,
        now: Instant,
    ) -> Result<(), Error> {
        Ok(self.session.admit(raw, pane, current, now)?)
    }
    /// Import at most one queued right per worker tick. The admitted offer chooses
    /// the pane lookup; the native message carries no authority to select a pane.
    pub fn receive(
        &mut self,
        now: Instant,
        current: impl FnOnce(&str) -> Option<Arc<CommittedPane>>,
    ) -> Result<Option<Image>, Error> {
        if !self.session.has_pending() {
            return Ok(None);
        }
        let receiver = self.receiver.as_mut().ok_or(Error::Identity)?;
        let Some(delivery) = receiver.try_receive().map_err(Error::Platform)? else {
            return Ok(None);
        };
        let ticket = Uuid::from_bytes(delivery.ticket);
        let pane = self
            .session
            .pending_pane(delivery.sequence, ticket)
            .ok_or(Error::Identity)?
            .to_owned();
        let committed = current(&pane).ok_or(Error::Identity)?;
        let (accepted, port) = self.session.bind(
            delivery.sequence,
            ticket,
            delivery.surface,
            &pane,
            &committed,
            now,
        )?;
        Ok(Some(Image::import(accepted, port, &pane, &committed)?))
    }
    pub fn fallback(&mut self, reason: FallbackReason) -> Result<String, Error> {
        self.registration = None;
        self.receiver = None;
        Ok(self.session.fallback(reason)?)
    }
    pub fn accept_fallback(&mut self, raw: &[u8]) -> Result<(), Error> {
        self.session.accept_fallback(raw)?;
        self.registration = None;
        self.receiver = None;
        Ok(())
    }
    /// Call only from the original socket's bounded write loop. Dropping a CPU
    /// image alone cannot acknowledge storage still retained by a GPUI scene/GPU.
    pub fn next_retirement(&mut self) -> Result<Option<String>, Error> {
        Ok(self.session.next_retirement()?)
    }
    pub fn reserved_bytes(&self) -> usize {
        self.session.reserved_bytes()
    }
    pub fn close(&mut self) {
        self.session.close();
        self.registration = None;
        self.receiver = None;
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}
