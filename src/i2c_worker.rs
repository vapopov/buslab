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
#[derive(Clone, Copy)]
pub struct Message {
    pub session: u32,
    pub frame: [u8; FRAME_SIZE],
}
pub type Requests = Channel<NoopRawMutex, Message, 1>;
pub type Responses = Channel<NoopRawMutex, Message, 4>;

async fn execute<I: I2c, P: Future<Output = ()>>(
    i2c: &mut I,
    request: &[u8; FRAME_SIZE],
    probe_pause: &impl Fn() -> P,
) -> [u8; FRAME_SIZE] {
    let mut response = [0; FRAME_SIZE];
    response[0] = request[0];
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
                    return response;
                }
            }
            // HAL reports address NACK as soon as STOP is requested. Allow STOP
            // to settle before another START; also yield to the BLE runner.
            probe_pause().await;
        }
        return response;
    }
    let address = request[1];
    let wlen = request[2] as usize;
    let rlen = request[3] as usize;
    if !(0x08..=0x77).contains(&address) || wlen > 16 || rlen > 18 || (wlen == 0 && rlen == 0) {
        response[1] = 1;
        return response;
    }
    let mut input = [0; 18];
    let output = &request[4..4 + wlen];
    let operation = async {
        match (wlen, rlen) {
            (0, _) => i2c.read(address, &mut input[..rlen]).await,
            (_, 0) => i2c.write(address, output).await,
            _ => i2c.write_read(address, output, &mut input[..rlen]).await,
        }
    };
    // Do not cancel a TWIM transfer while EasyDMA still owns these buffers.
    match operation.await {
        Ok(()) => response[2..2 + rlen].copy_from_slice(&input[..rlen]),
        Err(_) => response[1] = 2,
    }
    response
}

pub async fn run<I: I2c, D: Future<Output = ()>, P: Future<Output = ()>>(
    mut i2c: I,
    requests: &Requests,
    responses: &Responses,
    busy: &AtomicBool,
    deadline: impl Fn() -> D,
    probe_pause: impl Fn() -> P,
) {
    loop {
        let request = requests.receive().await;
        let mut transfer = pin!(execute(&mut i2c, &request.frame, &probe_pause));
        match select(transfer.as_mut(), deadline()).await {
            Either::First(frame) => {
                responses
                    .send(Message {
                        session: request.session,
                        frame,
                    })
                    .await
            }
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
        busy.store(false, Ordering::Relaxed);
    }
}
