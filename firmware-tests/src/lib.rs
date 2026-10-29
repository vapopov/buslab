#[cfg(test)]
#[path = "../../src/i2c_worker.rs"]
mod i2c_worker;
#[cfg(test)]
#[path = "../../src/write_upload.rs"]
mod write_upload;

#[cfg(test)]
mod tests {
    use super::i2c_worker::*;
    use core::{
        future::{poll_fn, Future},
        pin::pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Poll, Waker},
    };
    use embedded_hal_async::i2c::{ErrorKind, ErrorType, I2c, NoAcknowledgeSource, Operation};
    use std::{cell::Cell, rc::Rc};

    #[derive(Clone, Copy)]
    enum Mode {
        Pending,
        Success,
        Nack,
    }
    struct FakeI2c {
        mode: Rc<Cell<Mode>>,
        cancelled: Rc<Cell<usize>>,
        started: Rc<Cell<usize>>,
    }
    impl ErrorType for FakeI2c {
        type Error = ErrorKind;
    }
    struct Guard {
        cancelled: Rc<Cell<usize>>,
        complete: bool,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            if !self.complete {
                self.cancelled.set(self.cancelled.get() + 1);
            }
        }
    }
    impl I2c for FakeI2c {
        async fn transaction(
            &mut self,
            _: u8,
            ops: &mut [Operation<'_>],
        ) -> Result<(), Self::Error> {
            self.started.set(self.started.get() + 1);
            let mut guard = Guard {
                cancelled: self.cancelled.clone(),
                complete: false,
            };
            poll_fn(|_| match self.mode.get() {
                Mode::Pending => Poll::Pending,
                Mode::Success => {
                    for op in ops.iter_mut() {
                        if let Operation::Read(data) = op {
                            data.fill(0xAB);
                        }
                    }
                    guard.complete = true;
                    Poll::Ready(Ok(()))
                }
                Mode::Nack => {
                    guard.complete = true;
                    Poll::Ready(Err(ErrorKind::NoAcknowledge(NoAcknowledgeSource::Address)))
                }
            })
            .await
        }
    }
    fn request(session: u32, id: u8) -> Request {
        let mut frame = [0; 20];
        frame[..5].copy_from_slice(&[id, 0x50, 1, 2, 0x10]);
        Message { session, frame }.into()
    }
    fn poll_pending(future: core::pin::Pin<&mut impl Future>) {
        assert!(future
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
    }

    #[test]
    fn stuck_transfer_reports_timeout_without_cancelling_dma_then_recovers() {
        let mode = Rc::new(Cell::new(Mode::Pending));
        let cancelled = Rc::new(Cell::new(0));
        let started = Rc::new(Cell::new(0));
        let timer = Rc::new(Cell::new(false));
        let bus = FakeI2c {
            mode: mode.clone(),
            cancelled: cancelled.clone(),
            started: started.clone(),
        };
        let requests = Requests::new();
        let responses = Responses::new();
        let recycled = Recycled::new();
        let busy = AtomicBool::new(true);
        requests
            .try_send(request(7, 1))
            .unwrap_or_else(|_| panic!("request queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            &recycled,
            |_| {
                let timer = timer.clone();
                poll_fn(move |_| {
                    if timer.get() {
                        Poll::Ready(())
                    } else {
                        Poll::Pending
                    }
                })
            },
            || core::future::ready(())
        ));
        poll_pending(worker.as_mut());
        assert!(responses.try_receive().is_err());
        timer.set(true);
        poll_pending(worker.as_mut());
        let timeout = responses.try_receive().unwrap();
        assert_eq!(timeout.session, 7);
        assert_eq!(&timeout.frame[..2], &[1, 3]);
        assert!(busy.load(Ordering::Relaxed));
        assert_eq!(cancelled.get(), 0);
        // The client can disconnect/reconnect while the worker keeps DMA buffers alive.
        poll_pending(worker.as_mut());
        assert!(responses.try_receive().is_err());
        mode.set(Mode::Success);
        poll_pending(worker.as_mut());
        assert!(!busy.load(Ordering::Relaxed));
        assert_eq!(cancelled.get(), 0);
        assert!(
            responses.try_receive().is_err(),
            "late result must never leak to a new session"
        );
        busy.store(true, Ordering::Relaxed);
        timer.set(false);
        requests
            .try_send(request(8, 1))
            .unwrap_or_else(|_| panic!("request queue full"));
        poll_pending(worker.as_mut());
        let result = responses.try_receive().unwrap();
        assert_eq!(result.session, 8);
        assert_eq!(&result.frame[..4], &[1, 0, 0xAB, 0xAB]);
        assert_eq!(started.get(), 2);
        assert!(!busy.load(Ordering::Relaxed));
    }

    #[test]
    fn absent_target_returns_error_and_next_request_can_succeed() {
        let mode = Rc::new(Cell::new(Mode::Nack));
        let bus = FakeI2c {
            mode: mode.clone(),
            cancelled: Rc::new(Cell::new(0)),
            started: Rc::new(Cell::new(0)),
        };
        let requests = Requests::new();
        let responses = Responses::new();
        let recycled = Recycled::new();
        let busy = AtomicBool::new(true);
        requests
            .try_send(request(1, 2))
            .unwrap_or_else(|_| panic!("request queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            &recycled,
            |_| core::future::pending::<()>(),
            || core::future::ready(())
        ));
        poll_pending(worker.as_mut());
        assert_eq!(&responses.try_receive().unwrap().frame[..2], &[2, 2]);
        assert!(!busy.load(Ordering::Relaxed));
        mode.set(Mode::Success);
        busy.store(true, Ordering::Relaxed);
        requests
            .try_send(request(1, 3))
            .unwrap_or_else(|_| panic!("request queue full"));
        poll_pending(worker.as_mut());
        assert_eq!(
            &responses.try_receive().unwrap().frame[..4],
            &[3, 0, 0xAB, 0xAB]
        );
    }
    #[test]
    fn timed_out_staged_dma_keeps_buffer_until_hardware_completion() {
        let mode = Rc::new(Cell::new(Mode::Pending));
        let timer = Rc::new(Cell::new(false));
        let cancelled = Rc::new(Cell::new(0));
        let bus = FakeI2c {
            mode: mode.clone(),
            cancelled: cancelled.clone(),
            started: Rc::new(Cell::new(0)),
        };
        let requests = Requests::new();
        let responses = Responses::new();
        let recycled = Recycled::new();
        let busy = AtomicBool::new(true);
        let mut frame = [0; 20];
        frame[..6].copy_from_slice(&[1, 1, 3, 0x20, 1, 0]);
        let buffer = Box::leak(Box::new([0u8; MAX_WRITE]));
        let pointer = buffer.as_ptr();
        let mut job: Request = Message { session: 7, frame }.into();
        job.write_data = Some(buffer);
        job.write_length = 66;
        requests
            .try_send(job)
            .unwrap_or_else(|_| panic!("queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            &recycled,
            |_| {
                let timer = timer.clone();
                poll_fn(move |_| {
                    if timer.get() {
                        Poll::Ready(())
                    } else {
                        Poll::Pending
                    }
                })
            },
            || core::future::ready(())
        ));
        poll_pending(worker.as_mut());
        timer.set(true);
        poll_pending(worker.as_mut());
        assert_eq!(responses.try_receive().unwrap().frame[1], 3);
        assert!(recycled.try_receive().is_err());
        assert!(busy.load(Ordering::Relaxed));
        mode.set(Mode::Success);
        poll_pending(worker.as_mut());
        assert_eq!(recycled.try_receive().unwrap().as_ptr(), pointer);
        assert_eq!(cancelled.get(), 0);
        assert!(!busy.load(Ordering::Relaxed));
        assert!(responses.try_receive().is_err());
    }
}

#[cfg(test)]
mod scan_tests {
    use super::i2c_worker::*;
    use core::{
        future::Future,
        pin::pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Waker},
    };
    use embedded_hal_async::i2c::{ErrorKind, ErrorType, I2c, NoAcknowledgeSource, Operation};
    use std::{cell::RefCell, rc::Rc};
    struct Bus {
        calls: Rc<RefCell<Vec<u8>>>,
        present: Vec<u8>,
        fail: Option<u8>,
    }
    impl ErrorType for Bus {
        type Error = ErrorKind;
    }
    impl I2c for Bus {
        async fn transaction(
            &mut self,
            address: u8,
            ops: &mut [Operation<'_>],
        ) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push(address);
            assert_eq!(ops.len(), 1);
            match &mut ops[0] {
                Operation::Read(data) => {
                    assert_eq!(data.len(), 1);
                    data[0] = 0x55;
                }
                _ => panic!("scan must not write data"),
            }
            if self.fail == Some(address) {
                return Err(ErrorKind::Bus);
            }
            if self.present.contains(&address) {
                Ok(())
            } else {
                Err(ErrorKind::NoAcknowledge(NoAcknowledgeSource::Address))
            }
        }
    }
    fn scan(bus: Bus) -> Message {
        let requests = Requests::new();
        let responses = Responses::new();
        let recycled = Recycled::new();
        let busy = AtomicBool::new(true);
        let mut frame = [0u8; 20];
        frame[..4].copy_from_slice(&[9, 0, 0xFF, 0]);
        requests
            .try_send(Message { session: 4, frame }.into())
            .unwrap_or_else(|_| panic!("queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            &recycled,
            |_| core::future::pending::<()>(),
            || core::future::ready(())
        ));
        assert!(worker
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
        assert!(!busy.load(Ordering::Relaxed));
        responses.try_receive().unwrap()
    }
    #[test]
    fn scan_probes_only_valid_addresses_and_maps_all_bitmap_boundaries() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let reply = scan(Bus {
            calls: calls.clone(),
            present: vec![0x08, 0x0F, 0x10, 0x50, 0x77],
            fail: None,
        });
        assert_eq!(*calls.borrow(), (0x08..=0x77).collect::<Vec<u8>>());
        assert_eq!(reply.session, 4);
        assert_eq!(&reply.frame[..2], &[9, 0]);
        let mut expected = [0u8; 20];
        expected[0] = 9;
        expected[2] = 0x81;
        expected[3] = 1;
        expected[11] = 1;
        expected[15] = 0x80;
        assert_eq!(reply.frame, expected);
    }
    #[test]
    fn empty_bus_is_successful_scan_with_empty_bitmap() {
        let reply = scan(Bus {
            calls: Rc::new(RefCell::new(Vec::new())),
            present: vec![],
            fail: None,
        });
        assert_eq!(reply.frame[1], 0);
        assert!(reply.frame[2..].iter().all(|b| *b == 0));
    }
    #[test]
    fn bus_fault_aborts_scan_instead_of_reporting_absent_devices() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let reply = scan(Bus {
            calls: calls.clone(),
            present: vec![],
            fail: Some(0x10),
        });
        assert_eq!(reply.frame[1], 2);
        assert_eq!(*calls.borrow(), (0x08..=0x10).collect::<Vec<u8>>());
    }
}

#[cfg(test)]
mod large_read_tests {
    use super::i2c_worker::*;
    use core::{
        future::Future,
        pin::pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Waker},
    };
    use embedded_hal_async::i2c::{ErrorKind, ErrorType, I2c, Operation};
    use std::{cell::RefCell, rc::Rc};
    type Calls = Rc<RefCell<Vec<(u8, Vec<u8>, usize)>>>;
    struct Bus {
        calls: Calls,
    }
    impl ErrorType for Bus {
        type Error = ErrorKind;
    }
    impl I2c for Bus {
        async fn transaction(
            &mut self,
            address: u8,
            ops: &mut [Operation<'_>],
        ) -> Result<(), Self::Error> {
            let mut written = Vec::new();
            let mut count = 0;
            for op in ops {
                match op {
                    Operation::Write(bytes) => written.extend_from_slice(bytes),
                    Operation::Read(bytes) => {
                        count = bytes.len();
                        for (i, byte) in bytes.iter_mut().enumerate() {
                            *byte = (i.wrapping_mul(29) & 255) as u8;
                        }
                    }
                }
            }
            self.calls.borrow_mut().push((address, written, count));
            Ok(())
        }
    }
    fn run_request(frame: [u8; 20]) -> (Vec<Message>, Calls) {
        run_job(Message { session: 8, frame }.into())
    }
    fn run_job(job: Request) -> (Vec<Message>, Calls) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let bus = Bus {
            calls: calls.clone(),
        };
        let requests = Requests::new();
        let responses = Responses::new();
        let recycled = Recycled::new();
        let busy = AtomicBool::new(true);
        requests
            .try_send(job)
            .unwrap_or_else(|_| panic!("queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            &recycled,
            |_| core::future::pending::<()>(),
            || core::future::ready(())
        ));
        let mut packets = Vec::new();
        for _ in 0..1000 {
            assert!(worker
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            while let Ok(message) = responses.try_receive() {
                packets.push(message);
            }
            if !busy.load(Ordering::Relaxed) {
                return (packets, calls);
            }
        }
        panic!("worker did not finish");
    }
    #[test]
    fn large_read_is_one_i2c_transaction_and_ordered_padded_packets() {
        for length in [19usize, 32, 33, 255, 256, 1024, 2047] {
            let mut request = [0u8; 20];
            request[..4].copy_from_slice(&[
                5,
                0xA0,
                16 | (((length >> 8) as u8) << 5),
                length as u8,
            ]);
            for (i, b) in request[4..].iter_mut().enumerate() {
                *b = i as u8;
            }
            let (packets, calls) = run_request(request);
            assert_eq!(
                &*calls.borrow(),
                &[(0x20, (0..16).collect::<Vec<u8>>(), length)]
            );
            assert_eq!(packets.len(), 2 + length.div_ceil(16));
            assert!(packets.iter().all(|m| m.session == 8 && m.frame[0] == 5));
            assert_eq!(packets[0].frame[1], 0x80);
            assert_eq!(
                u16::from_le_bytes([packets[0].frame[2], packets[0].frame[3]]) as usize,
                length
            );
            let mut bytes = Vec::new();
            for (index, message) in packets[1..packets.len() - 1].iter().enumerate() {
                assert_eq!(message.frame[1], 0x81);
                assert_eq!(
                    u16::from_le_bytes([message.frame[2], message.frame[3]]) as usize,
                    index * 16
                );
                let count = 16.min(length - index * 16);
                bytes.extend_from_slice(&message.frame[4..4 + count]);
                assert!(message.frame[4 + count..].iter().all(|b| *b == 0));
            }
            assert_eq!(
                bytes,
                (0..length)
                    .map(|i| (i * 29 & 255) as u8)
                    .collect::<Vec<u8>>()
            );
            assert_eq!(packets.last().unwrap().frame[1], 0x82);
        }
    }
    #[test]
    fn assembled_register_write_and_staged_binary_each_use_one_physical_transaction() {
        for (length, read_length) in [(66usize, 65usize), (MAX_WRITE, 0)] {
            let mut frame = [0; 20];
            frame[..6].copy_from_slice(&[
                2,
                1,
                3,
                0x20,
                read_length as u8,
                (read_length >> 8) as u8,
            ]);
            let mut job: Request = Message { session: 8, frame }.into();
            job.write_length = length;
            let data = (0..length)
                .map(|i| (i * 31 & 255) as u8)
                .collect::<Vec<_>>();
            job.write_data = Some(Box::leak(Box::new([0; MAX_WRITE])));
            job.write_data.as_deref_mut().unwrap()[..length].copy_from_slice(&data);
            let (packets, calls) = run_job(job);
            assert_eq!(&*calls.borrow(), &[(0x20, data, read_length)]);
            assert_eq!(packets[0].frame[1], if read_length > 18 { 0x80 } else { 0 });
        }
    }
    #[test]
    fn extended_read_only_works_and_legacy_and_malformed_requests_stay_distinct() {
        let mut request = [0u8; 20];
        request[..4].copy_from_slice(&[1, 0xA0, 0, 19]);
        let (_, calls) = run_request(request);
        assert_eq!(&*calls.borrow(), &[(0x20, vec![], 19)]);
        request[1] = 0x20;
        let (packets, calls) = run_request(request);
        assert!(calls.borrow().is_empty());
        assert_eq!(packets[0].frame[1], 1);
        request[1] = 0xA0;
        request[3] = 18;
        let (packets, calls) = run_request(request);
        assert!(calls.borrow().is_empty());
        assert_eq!(packets[0].frame[1], 1);
        request[3] = 19;
        request[2] = 31;
        let (packets, calls) = run_request(request);
        assert!(calls.borrow().is_empty());
        assert_eq!(packets[0].frame[1], 1);
    }
}

#[cfg(test)]
mod upload_tests {
    use super::{i2c_worker::*, write_upload::*};
    fn begin(id: u8, address: u8, size: usize, read: usize, stage: bool) -> [u8; 20] {
        let mut f = [0; 20];
        f[..9].copy_from_slice(&[
            id,
            1,
            0,
            address,
            size as u8,
            (size >> 8) as u8,
            read as u8,
            (read >> 8) as u8,
            stage as u8,
        ]);
        f
    }
    fn control(id: u8, op: u8, address: u8) -> [u8; 20] {
        let mut f = [0; 20];
        f[..4].copy_from_slice(&[id, 1, op, address]);
        f
    }
    fn upload(state: &mut Upload, id: u8, data: &[u8]) {
        for (offset, part) in data.chunks(15).enumerate() {
            let offset = offset * 15;
            let mut f = [0; 20];
            f[..5].copy_from_slice(&[id, 1, 1, offset as u8, (offset >> 8) as u8]);
            f[5..5 + part.len()].copy_from_slice(part);
            assert!(matches!(state.ingest(7, &f), Ok(Action::Continue)));
        }
    }
    #[test]
    fn register_payload_66_bytes_is_not_released_until_full_commit() {
        let mut state = Upload::new(Box::leak(Box::new([0; MAX_WRITE])));
        let data = (0..66u8).collect::<Vec<_>>();
        assert!(matches!(
            state.ingest(7, &begin(1, 0x20, 66, 65, false)),
            Ok(Action::Continue)
        ));
        assert!(state.ingest(7, &control(1, 2, 0)).is_err()); // incomplete upload
        upload(&mut state, 1, &data);
        let Ok(Action::Transfer(job)) = state.ingest(7, &control(1, 2, 0)) else {
            panic!("no committed write")
        };
        assert_eq!(job.write_length, 66);
        assert_eq!(&job.write_data.as_deref().unwrap()[..66], &data);
        assert_eq!(&job.frame[..6], &[1, 1, 3, 0x20, 65, 0]);
    }
    #[test]
    fn maximum_binary_is_staged_without_i2c_then_committed_once_to_patch_address() {
        let mut state = Upload::new(Box::leak(Box::new([0; MAX_WRITE])));
        let data = (0..MAX_WRITE)
            .map(|i| (i * 29 & 255) as u8)
            .collect::<Vec<_>>();
        assert!(matches!(
            state.ingest(7, &begin(1, 0, MAX_WRITE, 0, true)),
            Ok(Action::Continue)
        ));
        upload(&mut state, 1, &data);
        assert!(matches!(
            state.ingest(7, &control(1, 2, 0)),
            Ok(Action::Staged)
        ));
        assert!(!state.active()); // small command transactions may now run before burst
        let Ok(Action::Transfer(mut job)) = state.ingest(7, &control(2, 3, 0x30)) else {
            panic!("staged write unavailable")
        };
        assert_eq!(job.session, 7);
        assert_eq!(job.write_length, MAX_WRITE);
        assert_eq!(&job.write_data.as_deref().unwrap()[..MAX_WRITE], &data);
        assert_eq!(job.frame[3], 0x30);
        assert!(state.ingest(7, &control(2, 3, 0x30)).is_err()); // no replay
        state.restore(job.write_data.take().unwrap());
        state.reset();
        assert!(matches!(
            state.ingest(8, &begin(3, 0, 1, 0, true)),
            Ok(Action::Continue)
        ));
    }
    #[test]
    fn bad_offsets_abort_and_disconnect_cannot_execute_partial_file() {
        let mut state = Upload::new(Box::leak(Box::new([0; MAX_WRITE])));
        state.ingest(7, &begin(1, 0, 66, 0, true)).ok();
        let mut wrong = [0; 20];
        wrong[..5].copy_from_slice(&[1, 1, 1, 15, 0]);
        assert!(state.ingest(7, &wrong).is_err());
        assert!(matches!(
            state.ingest(7, &control(1, 4, 0)),
            Ok(Action::Staged)
        ));
        assert!(state.ingest(7, &control(1, 3, 0x30)).is_err());
        let mut new_connection = Upload::new(Box::leak(Box::new([0; MAX_WRITE])));
        assert!(new_connection.ingest(8, &control(1, 3, 0x30)).is_err());
        assert!(state
            .ingest(7, &begin(1, 0, MAX_WRITE + 1, 0, true))
            .is_err());
    }
}
