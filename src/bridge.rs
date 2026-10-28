use crate::i2c_worker::{self, Message, Requests, Responses};
use core::sync::atomic::{AtomicBool, Ordering};
use embassy_futures::{
    join::{join, join4},
    select::select,
};
use embassy_nrf::buffered_uarte::BufferedUarte;
use embassy_sync::{blocking_mutex::raw::NoopRawMutex, channel::Channel};
use embassy_time::{Duration, Timer};
use embedded_hal_async::i2c::I2c;
use trouble_host::prelude::*;

const FRAME_SIZE: usize = 20;

#[gatt_service(uuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e")]
struct UartService {
    #[characteristic(uuid = "6e400002-b5a3-f393-e0a9-e50e24dcca9e", write, value = [0u8; FRAME_SIZE])]
    rx: [u8; FRAME_SIZE],
    #[characteristic(uuid = "6e400003-b5a3-f393-e0a9-e50e24dcca9e", notify, value = [0u8; FRAME_SIZE])]
    tx: [u8; FRAME_SIZE],
}

// Keep the original NUS-based I2C protocol unchanged.
#[gatt_service(uuid = "93b10001-e8a8-4f6c-a592-31a52c5db031")]
struct SerialService {
    // Host -> UART: [length (1..19), data..., zero padding].
    #[characteristic(uuid = "93b10002-e8a8-4f6c-a592-31a52c5db031", write, value = [0u8; FRAME_SIZE])]
    rx: [u8; FRAME_SIZE],
    // UART -> host: [kind (0=data, 1=overflow), length (0..18), data..., padding].
    #[characteristic(uuid = "93b10003-e8a8-4f6c-a592-31a52c5db031", notify, value = [0u8; FRAME_SIZE])]
    tx: [u8; FRAME_SIZE],
}

#[gatt_server]
struct Server {
    uart: UartService,
    serial: SerialService,
}

pub async fn run<C: Controller, I: I2c>(
    controller: C,
    i2c: I,
    uart: BufferedUarte<'_>,
    address: Address,
) {
    let requests = Requests::new();
    let responses = Responses::new();
    let i2c_busy = AtomicBool::new(false);
    let (mut uart_rx, mut uart_tx) = uart.split();
    let queue: Channel<NoopRawMutex, [u8; FRAME_SIZE], 64> = Channel::new();
    let connected = AtomicBool::new(false);
    let overflow = AtomicBool::new(false);
    let mut resources: HostResources<DefaultPacketPool, 1, 2> = HostResources::new();
    let stack = trouble_host::new(controller, &mut resources)
        .set_random_address(address)
        .build();
    let mut runner = stack.runner();
    let mut peripheral = stack.peripheral();
    let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
        name: "BLE-I2C-UART-v2",
        appearance: &appearance::power_device::GENERIC_POWER_DEVICE,
    }))
    .unwrap();
    let mut advertising = [0; 31];
    let length = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteLocalName(b"BLE-I2C-UART-v2"),
        ],
        &mut advertising,
    )
    .unwrap();
    join4(
        i2c_worker::run(i2c, &requests, &responses, &i2c_busy, || {
            Timer::after(Duration::from_millis(250))
        }),
        async {
            // Always drain the physical UART, including while disconnected.
            loop {
                let mut frame = [0; FRAME_SIZE];
                match uart_rx.read(&mut frame[2..]).await {
                    Ok(n) => frame[1] = n as u8,
                    Err(_) => {
                        overflow.store(true, Ordering::Relaxed);
                        continue;
                    }
                }
                if connected.load(Ordering::Relaxed) && queue.try_send(frame).is_err() {
                    overflow.store(true, Ordering::Relaxed);
                }
            }
        },
        async {
            runner.run().await.unwrap();
        },
        async {
            let mut session = 0u32;
            loop {
                let advertiser = match peripheral
                    .advertise(
                        &Default::default(),
                        Advertisement::ConnectableScannableUndirected {
                            adv_data: &advertising[..length],
                            scan_data: &[],
                        },
                    )
                    .await
                {
                    Ok(a) => a,
                    Err(e) => {
                        defmt::warn!("Advertising error: {:?}", e);
                        continue;
                    }
                };
                let connection = match advertiser.accept().await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let connection = match connection.with_attribute_server(&server) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                defmt::info!("BLE connected: UART enabled, firmware v2");
                session = session.wrapping_add(1);
                while queue.try_receive().is_ok() {}
                overflow.store(false, Ordering::Relaxed);
                connected.store(true, Ordering::Relaxed);
                select(
                    async {
                        loop {
                            match connection.next().await {
                                GattConnectionEvent::Disconnected { .. } => break,
                                GattConnectionEvent::Gatt { event } => {
                                    let mut request = None;
                                    let mut malformed = false;
                                    let mut serial_request = None;
                                    if let GattEvent::Write(write) = &event {
                                        if write.handle() == server.uart.rx.handle {
                                            write.with_data(|offset, data| {
                                                if offset == 0 && data.len() == FRAME_SIZE {
                                                    let mut frame = [0; FRAME_SIZE];
                                                    frame.copy_from_slice(data);
                                                    request = Some(frame);
                                                } else {
                                                    malformed = true;
                                                }
                                            });
                                        }
                                    }
                                    if let GattEvent::Write(write) = &event {
                                        if write.handle() == server.serial.rx.handle {
                                            write.with_data(|offset, data| {
                                                if offset == 0
                                                    && data.len() == FRAME_SIZE
                                                    && (1..=19).contains(&data[0])
                                                {
                                                    let mut frame = [0; FRAME_SIZE];
                                                    frame.copy_from_slice(data);
                                                    serial_request = Some(frame);
                                                } else {
                                                    malformed = true;
                                                }
                                            });
                                        }
                                    }
                                    if malformed {
                                        if let Ok(reply) = event
                                            .reject(AttErrorCode::INVALID_ATTRIBUTE_VALUE_LENGTH)
                                        {
                                            reply.send().await;
                                        }
                                        continue;
                                    }
                                    // Enqueue all serial bytes before acknowledging the BLE write.
                                    if let Some(frame) = serial_request {
                                        let mut data = &frame[1..1 + frame[0] as usize];
                                        while !data.is_empty() {
                                            match uart_tx.write(data).await {
                                                Ok(n) if n > 0 => data = &data[n..],
                                                _ => {
                                                    malformed = true;
                                                    break;
                                                }
                                            }
                                        }
                                        if malformed {
                                            if let Ok(reply) =
                                                event.reject(AttErrorCode::UNLIKELY_ERROR)
                                            {
                                                reply.send().await;
                                            }
                                            continue;
                                        }
                                    }
                                    if let Ok(reply) = event.accept() {
                                        reply.send().await;
                                    }
                                    if let Some(request) = request {
                                        if i2c_busy
                                            .compare_exchange(
                                                false,
                                                true,
                                                Ordering::Relaxed,
                                                Ordering::Relaxed,
                                            )
                                            .is_ok()
                                        {
                                            requests
                                                .send(Message {
                                                    session,
                                                    frame: request,
                                                })
                                                .await;
                                        } else {
                                            let mut response = [0; FRAME_SIZE];
                                            response[0] = request[0];
                                            response[1] = 4; // Previous hardware transfer still active.
                                            let _ = server
                                                .uart
                                                .tx
                                                .notify(&connection, &response, true)
                                                .await;
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    },
                    join(
                        async {
                            loop {
                                let response = responses.receive().await;
                                if response.session == session {
                                    let _ = server
                                        .uart
                                        .tx
                                        .notify(&connection, &response.frame, true)
                                        .await;
                                }
                            }
                        },
                        async {
                            loop {
                                let frame = queue.receive().await;
                                if overflow.swap(false, Ordering::Relaxed) {
                                    let mut status = [0; FRAME_SIZE];
                                    status[0] = 1;
                                    let _ =
                                        server.serial.tx.notify(&connection, &status, true).await;
                                }
                                // Subscription is independent of the existing I2C notifications.
                                let _ = server.serial.tx.notify(&connection, &frame, true).await;
                            }
                        },
                    ),
                )
                .await;
                connected.store(false, Ordering::Relaxed);
            }
        },
    )
    .await;
}
