//! Assemble BLE fragments before allowing a single physical I2C write.
use crate::i2c_worker::{Message, Request, WriteBuffer, MAX_READ, MAX_WRITE};

pub struct Upload {
    id: u8,
    address: u8,
    length: usize,
    received: usize,
    read_length: usize,
    staging: bool,
    active: bool,
    staged: bool,
    bytes: Option<WriteBuffer>,
}
pub enum Action {
    Continue,
    Staged,
    Transfer(Request),
}
impl Upload {
    pub fn new(buffer: WriteBuffer) -> Self {
        Self {
            id: 0,
            address: 0,
            length: 0,
            received: 0,
            read_length: 0,
            staging: false,
            active: false,
            staged: false,
            bytes: Some(buffer),
        }
    }
    pub fn reset(&mut self) {
        self.active = false;
        self.staged = false;
        self.length = 0;
    }
    pub fn restore(&mut self, buffer: WriteBuffer) {
        self.bytes = Some(buffer);
    }
    pub fn active(&self) -> bool {
        self.active
    }
    pub fn ingest(&mut self, session: u32, frame: &[u8; 20]) -> Result<Action, ()> {
        if frame[1] != 1 {
            return Err(());
        }
        match frame[2] {
            0 => {
                let length = u16::from_le_bytes([frame[4], frame[5]]) as usize;
                let read_length = u16::from_le_bytes([frame[6], frame[7]]) as usize;
                let staging = frame[8] == 1;
                if self.bytes.is_none()
                    || self.active
                    || (self.staged && !staging)
                    || length == 0
                    || length > MAX_WRITE
                    || read_length > MAX_READ
                    || frame[8] > 1
                    || frame[9..].iter().any(|b| *b != 0)
                    || (staging && (frame[3] != 0 || read_length != 0))
                    || (!staging && !(0x08..=0x77).contains(&frame[3]))
                {
                    return Err(());
                }
                self.id = frame[0];
                self.address = frame[3];
                self.length = length;
                self.read_length = read_length;
                self.received = 0;
                self.staging = staging;
                self.active = true;
                self.staged = false;
                Ok(Action::Continue)
            }
            1 => {
                let offset = u16::from_le_bytes([frame[3], frame[4]]) as usize;
                if !self.active
                    || frame[0] != self.id
                    || offset != self.received
                    || offset >= self.length
                {
                    return Err(());
                }
                let count = 15.min(self.length - offset);
                self.bytes.as_deref_mut().ok_or(())?[offset..offset + count]
                    .copy_from_slice(&frame[5..5 + count]);
                self.received += count;
                Ok(Action::Continue)
            }
            2 => {
                if !self.active
                    || frame[0] != self.id
                    || self.received != self.length
                    || frame[3..].iter().any(|b| *b != 0)
                {
                    return Err(());
                }
                self.active = false;
                if self.staging {
                    self.staged = true;
                    Ok(Action::Staged)
                } else {
                    Ok(Action::Transfer(self.take(
                        session,
                        frame[0],
                        self.address,
                        self.read_length,
                    )))
                }
            }
            3 => {
                if !self.staged
                    || self.active
                    || !(0x08..=0x77).contains(&frame[3])
                    || frame[4..].iter().any(|b| *b != 0)
                {
                    return Err(());
                }
                self.staged = false;
                Ok(Action::Transfer(self.take(session, frame[0], frame[3], 0)))
            }
            4 => {
                self.active = false;
                self.staged = false;
                self.length = 0;
                Ok(Action::Staged)
            }
            _ => Err(()),
        }
    }
    fn take(&mut self, session: u32, id: u8, address: u8, read_length: usize) -> Request {
        let mut frame = [0u8; 20];
        frame[..6].copy_from_slice(&[
            id,
            1,
            3,
            address,
            read_length as u8,
            (read_length >> 8) as u8,
        ]);
        let mut request = Request::from(Message { session, frame });
        request.write_length = self.length;
        request.write_data = self.bytes.take();
        self.length = 0;
        request
    }
}
