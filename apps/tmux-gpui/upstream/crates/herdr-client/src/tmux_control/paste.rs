use super::*;
pub(super) struct Transaction {
    pane: String,
    lifetime: Lifetime,
    chunks: VecDeque<String>,
    waiting: Option<u32>,
}
impl Policy {
    /// Freeze pane lifetime and bracketed-paste mode before sending the first byte.
    /// The transaction excludes ordinary input and control barriers until its final ACK.
    pub fn begin_paste(
        &mut self,
        pane: &str,
        lifetime: &Lifetime,
        data: &str,
        bracketed: bool,
        now: u64,
    ) -> Result<Command> {
        self.check()?;
        if !self.barrier_ready() || !self.intents.is_empty() {
            return Err(Error::Busy);
        }
        if data.is_empty()
            || data.len() > 65536
            || data.encode_utf16().count() > 65536
            || data.contains(['\0', '\u{1b}'])
        {
            return Err(Error::Invalid);
        }
        let text = if bracketed {
            format!("\u{1b}[200~{data}\u{1b}[201~")
        } else {
            data.into()
        };
        let mut chunks = VecDeque::new();
        let mut current = String::new();
        let mut units = 0;
        for c in text.chars() {
            if units + c.len_utf16() > 1024 {
                chunks.push_back(std::mem::take(&mut current));
                units = 0;
            }
            current.push(c);
            units += c.len_utf16();
        }
        if !current.is_empty() {
            chunks.push_back(current);
        }
        self.paste = Some(Transaction {
            pane: pane.into(),
            lifetime: lifetime.clone(),
            chunks,
            waiting: None,
        });
        self.next_paste(now)?.ok_or(Error::Invalid)
    }
    /// Call after processing ACKs; Busy means the previous chunk is still uncertain.
    /// No suffix is sent after timeout, authority loss, focus loss, or lifetime change.
    pub fn next_paste(&mut self, now: u64) -> Result<Option<Command>> {
        self.check()?;
        let Some(mut transaction) = self.paste.take() else {
            return Ok(None);
        };
        if transaction.waiting.is_some() {
            self.paste = Some(transaction);
            return Err(Error::Busy);
        }
        let Some(data) = transaction.chunks.pop_front() else {
            return Ok(None);
        };
        let command = self.input_chunk(
            &transaction.pane,
            &transaction.lifetime,
            Input::Text(data),
            now,
        )?;
        transaction.waiting = self.sequences.get(&transaction.pane).copied();
        self.paste = Some(transaction);
        Ok(Some(command))
    }
    pub(super) fn cancel_paste_for(&mut self, pane: &str) {
        if self.paste.as_ref().is_some_and(|p| p.pane == pane) {
            self.paste = None;
        }
    }
    pub fn next_paste_submission(&mut self, now: u64) -> Result<Option<(u32, Command)>> {
        let Some(command) = self.next_paste(now)? else {
            return Ok(None);
        };
        let sequence = self
            .paste
            .as_ref()
            .and_then(|p| p.waiting)
            .ok_or(Error::Invalid)?;
        Ok(Some((sequence, command)))
    }
    pub fn begin_paste_submission(
        &mut self,
        pane: &str,
        lifetime: &Lifetime,
        data: &str,
        bracketed: bool,
        now: u64,
    ) -> Result<(u32, Command)> {
        let command = self.begin_paste(pane, lifetime, data, bracketed, now)?;
        let sequence = self
            .paste
            .as_ref()
            .and_then(|p| p.waiting)
            .ok_or(Error::Invalid)?;
        Ok((sequence, command))
    }
    pub fn cancel_paste(&mut self) {
        self.paste = None;
    }
    pub fn paste_pending(&self) -> bool {
        self.paste.is_some()
    }
    pub(super) fn paste_completion(&mut self, pane: &str, sequence: u32, result: InputResult) {
        let Some(t) = self.paste.as_mut() else {
            return;
        };
        if t.pane != pane || t.waiting != Some(sequence) {
            return;
        }
        if result != InputResult::Ok || t.chunks.is_empty() {
            self.paste = None;
        } else {
            t.waiting = None;
        }
    }
}
