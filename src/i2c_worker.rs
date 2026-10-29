//! Keep in-flight EasyDMA buffers alive even after the client deadline expires.
use core::{
    future::Future,
    pin::pin,
    sync::atomic::{AtomicBool, Ordering},
};
use embassy_futures::select::{select, Either};
use embassy_sync::{blocking_mutex::raw::NoopRawMutex, channel::Channel};
use embedded_hal_async::i2c::{Error, ErrorKind, I2c};

pub const FRAME_SIZE: usize = 20;
pub const MAX_READ: usize = 2047;
pub const MAX_WRITE: usize = 32768;

struct Outcome {
    frame: [u8; FRAME_SIZE],
    data: [u8; MAX_READ],
    length: usize,
    extended: bool,
}
impl Outcome {
    fn new(id: u8) -> Self {
        let mut frame = [0; FRAME_SIZE];
        frame[0] = id;
        Self {
            frame,
            data: [0; MAX_READ],
            length: 0,
            extended: false,
        }
    }
}
#[derive(Clone, Copy)]
pub struct Message {
    pub session: u32,
    pub frame: [u8; FRAME_SIZE],
}
pub type WriteBuffer = &'static mut [u8; MAX_WRITE];
pub type Recycled = Channel<NoopRawMutex, WriteBuffer, 1>;

pub struct Request {
    pub session: u32,
    pub frame: [u8; FRAME_SIZE],
    pub write_data: Option<WriteBuffer>,
    pub write_length: usize,
}
impl From<Message> for Request {
    fn from(message: Message) -> Self {
        Self {
            session: message.session,
            frame: message.frame,
            write_data: None,
            write_length: 0,
        }
    }
}
pub type Requests = Channel<NoopRawMutex, Request, 1>;
pub type Responses = Channel<NoopRawMutex, Message, 4>;

async fn execute<I: I2c, P: Future<Output = ()>>(
    i2c: &mut I,
    job: &Request,
    probe_pause: &impl Fn() -> P,
) -> Outcome {
    let request = &job.frame;
    let mut outcome = Outcome::new(request[0]);
    let response = &mut outcome.frame;
    // Dedicated scan: [id, 0x00, 0xFF, 0x00, zero padding].
    // Read probes avoid the driver's zero-length write/STOP race.
    if request[1..4] == [0, 0xFF, 0] && request[4..].iter().all(|byte| *byte == 0) {
        for address in 0x08u8..=0x77 {
            let mut byte = [0u8; 1];
            match i2c.read(address, &mut byte).await {
                Ok(()) => {
                    let bit = (address - 0x08) as usize;
                    response[2 + bit / 8] |= 1 << (bit % 8);
                }
                Err(error) if matches!(error.kind(), ErrorKind::NoAcknowledge(_)) => {}
                Err(_) => {
                    response[1] = 2;
                    return outcome;
                }
            }
            // HAL reports address NACK as soon as STOP is requested. Allow STOP
            // to settle before another START; also yield to the BLE runner.
            probe_pause().await;
        }
        return outcome;
    }
    let uploaded = request[1] == 1 && request[2] == 3;
    let extended = if uploaded {
        u16::from_le_bytes([request[4], request[5]]) > 18
    } else {
        request[1] & 0x80 != 0
    };
    let address = if uploaded {
        request[3]
    } else {
        request[1] & 0x7F
    };
    let wlen = if uploaded {
        job.write_length
    } else if extended {
        (request[2] & 0x1F) as usize
    } else {
        request[2] as usize
    };
    let rlen = if uploaded {
        u16::from_le_bytes([request[4], request[5]]) as usize
    } else {
        request[3] as usize
            | if extended {
                ((request[2] >> 5) as usize) << 8
            } else {
                0
            }
    };
    if !(0x08..=0x77).contains(&address)
        || wlen > MAX_WRITE
        || rlen > MAX_READ
        || (!uploaded && wlen > 16)
        || (!extended && rlen > 18)
        || (!uploaded && extended && rlen <= 18)
        || (wlen == 0 && rlen == 0)
        || (uploaded && (wlen == 0 || job.write_data.is_none()))
    {
        response[1] = 1;
        return outcome;
    }
    let input = &mut outcome.data;
    let output = if uploaded {
        &job.write_data.as_deref().expect("uploaded write buffer")[..wlen]
    } else {
        &request[4..4 + wlen]
    };
    let operation = async {
        match (wlen, rlen) {
            (0, _) => i2c.read(address, &mut input[..rlen]).await,
            (_, 0) => i2c.write(address, output).await,
            _ => i2c.write_read(address, output, &mut input[..rlen]).await,
        }
    };
    // Do not cancel a TWIM transfer while EasyDMA still owns these buffers.
    match operation.await {
        Ok(()) => {
            if extended {
                outcome.extended = true;
                outcome.length = rlen;
            } else {
                response[2..2 + rlen].copy_from_slice(&input[..rlen]);
            }
        }
        Err(_) => response[1] = 2,
    }
    outcome
}

async fn send_outcome(outcome: Outcome, session: u32, responses: &Responses) {
    if !outcome.extended {
        responses
            .send(Message {
                session,
                frame: outcome.frame,
            })
            .await;
        return;
    }
    // Stream envelope: begin(total), data(offset + 16 bytes), end(total).
    let id = outcome.frame[0];
    let total = (outcome.length as u16).to_le_bytes();
    let mut frame = [0; FRAME_SIZE];
    frame[..4].copy_from_slice(&[id, 0x80, total[0], total[1]]);
    responses.send(Message { session, frame }).await;
    for (index, chunk) in outcome.data[..outcome.length].chunks(16).enumerate() {
        let offset = ((index * 16) as u16).to_le_bytes();
        let mut frame = [0; FRAME_SIZE];
        frame[..4].copy_from_slice(&[id, 0x81, offset[0], offset[1]]);
        frame[4..4 + chunk.len()].copy_from_slice(chunk);
        responses.send(Message { session, frame }).await;
    }
    let mut frame = [0; FRAME_SIZE];
    frame[..4].copy_from_slice(&[id, 0x82, total[0], total[1]]);
    responses.send(Message { session, frame }).await;
}

pub async fn run<I: I2c, D: Future<Output = ()>, P: Future<Output = ()>>(
    mut i2c: I,
    requests: &Requests,
    responses: &Responses,
    busy: &AtomicBool,
    recycled: &Recycled,
    deadline: impl Fn(usize) -> D,
    probe_pause: impl Fn() -> P,
) {
    loop {
        let mut request = requests.receive().await;
        {
            let mut transfer = pin!(execute(&mut i2c, &request, &probe_pause));
            match select(transfer.as_mut(), deadline(request.write_length)).await {
                Either::First(outcome) => send_outcome(outcome, request.session, responses).await,
                Either::Second(()) => {
                    let mut frame = [0; FRAME_SIZE];
                    frame[0] = request.frame[0];
                    frame[1] = 3; // Timed out; target write may have already happened.
                    responses
                        .send(Message {
                            session: request.session,
                            frame,
                        })
                        .await;
                    // Do not cancel TWIM: its DMA still references the transfer's buffers.
                    // Keep the bus reserved until hardware finishes. BLE/UART stay live.
                    let _ = transfer.await;
                    // Never send the late result: IDs may have been reused after reconnect.
                }
            }
        }
        if let Some(buffer) = request.write_data.take() {
            recycled.send(buffer).await;
        }
        busy.store(false, Ordering::Relaxed);
    }
}
