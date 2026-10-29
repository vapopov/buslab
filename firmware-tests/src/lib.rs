#[cfg(test)]
#[path = "../../src/i2c_worker.rs"]
mod i2c_worker;

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
    fn request(session: u32, id: u8) -> Message {
        let mut frame = [0; 20];
        frame[..5].copy_from_slice(&[id, 0x50, 1, 2, 0x10]);
        Message { session, frame }
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
        let busy = AtomicBool::new(true);
        requests
            .try_send(request(7, 1))
            .unwrap_or_else(|_| panic!("request queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            || {
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
        let busy = AtomicBool::new(true);
        requests
            .try_send(request(1, 2))
            .unwrap_or_else(|_| panic!("request queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            core::future::pending::<()>,
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
        let busy = AtomicBool::new(true);
        let mut frame = [0u8; 20];
        frame[..4].copy_from_slice(&[9, 0, 0xFF, 0]);
        requests
            .try_send(Message { session: 4, frame })
            .unwrap_or_else(|_| panic!("queue full"));
        let mut worker = pin!(run(
            bus,
            &requests,
            &responses,
            &busy,
            core::future::pending::<()>,
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
