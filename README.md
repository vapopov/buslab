# XIAO nRF52840 BLE-to-I²C + UART bridge

A complete no_std Embassy firmware project. The nRF52840 is a BLE peripheral
and an I2C master/controller plus a full-duplex UART bridge. This package replaces the earlier incomplete snippets.

## Build

Install a current stable Rust toolchain and target:

```sh
rustup update stable
rustup target add thumbv7em-none-eabihf
cargo build --release --locked
```

Run commands from this project directory so `.cargo/config.toml` is applied.
The Nordic crates generate C bindings using libclang. On macOS, install Xcode
Command Line Tools (`xcode-select --install`) if not already installed. If bindgen
cannot locate libclang, install LLVM (`brew install llvm`) and build with:

```sh
LIBCLANG_PATH="$(brew --prefix llvm)/lib" cargo build --release --locked
```

The firmware uses `#![no_std]` and `#![no_main]`; build.rs runs on the computer
and legitimately uses std. No Rust std library is linked into firmware.

This is a minimal bridge project; unrelated networking dependencies from the
uploaded Cargo.toml are omitted. Embassy NRF is updated from 0.10.0 to 0.11.0,
as required by nrf-sdc/nrf-mpsl 0.4.0. Use the included Cargo.lock.

## Wiring and startup

- SDA: P0.04 (XIAO D4)
- SCL: P0.05 (XIAO D5)
- I2C speed: 100 kHz
- Internal SDA/SCL pull-ups keep an unplugged bus idle-high. External pull-ups
  are still recommended for a connected bus.
- Connect target ground to nRF ground and use external SDA/SCL pull-ups to the
  compatible logic supply (typically 3.3 V). Do not pull GPIO up to USB VBUS.
- TWIM's constructor takes SDA first, then SCL. The earlier snippets had this reversed.
- Internal low-frequency RC clock is selected, so no 32.768 kHz crystal is required.
  The board must still have the normal nRF52840 high-frequency crystal/radio hardware.
- Assign a unique static-random BLE address per device; main.rs contains an example.

memory.x assumes an application programmed at flash address zero through SWD.
It does not preserve a preinstalled bootloader, and it does not use a separately
flashed S140 SoftDevice image. For a bootloader-based board, use its correct memory
map and flashing procedure instead of this memory.x.

Optional SWD launch with probe-rs installed:

```sh
cargo run --release --locked
```

## Connection indicator

The onboard green LED (P0.30) is off at startup and while advertising, on while
Bluetooth is connected, and off again after disconnection is detected. The LED
is active-low (LOW = on, HIGH = off).

## BLE protocol

Advertised name: BLE-I2C-UART-v2. Connect with a BLE client; this is not a Bluetooth
Classic serial/COM port. Enable notifications on TX before sending commands.

NUS service: 6e400001-b5a3-f393-e0a9-e50e24dcca9e
RX (write with response): 6e400002-b5a3-f393-e0a9-e50e24dcca9e
TX (notify): 6e400003-b5a3-f393-e0a9-e50e24dcca9e

Exactly 20 bytes per command, zero-padding unused bytes:

| Byte | Meaning |
| --- | --- |
| 0 | Request ID |
| 1 | Unshifted 7-bit I2C address (0x08 through 0x77) |
| 2 | Write length, 0 through 16 |
| 3 | Read length, 0 through 18 |
| 4-19 | Write data plus zero padding |

At least one length must be nonzero. A combined write/read uses a repeated START.
The 20-byte notification is `[request_id, status, read_data..., zero_padding...]`.
Status 0 = success, 1 = invalid command, 2 = I2C error, 3 = deadline expired,
4 = previous I2C hardware transfer still active.
A 250 ms application deadline reports status 3 if hardware has not completed.
The I2C worker keeps the in-flight EasyDMA buffers alive until hardware finishes;
Bluetooth handling and UART continue independently. Further I2C requests return
status 4 while that transfer is still active. Release the stuck line or reset the
board if it cannot finish. Automatic bus recovery is not implemented.
Send one command and wait for its notification before sending the next.
An ATT write acknowledgement only acknowledges receipt; the notification carries
transaction completion. Do not blindly retry writes after a lost response: the
write may already have reached the target.

Example: read two bytes from register 0x10 of address 0x50:

```
01 50 01 02 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

Possible reply:

```
01 00 AB CD 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

This development firmware does not require pairing or authenticate clients.
Anyone within BLE range can connect and issue I2C operations. Add link security
and access control before deploying to equipment needing restricted access.

## Validation

See BUILD-RESULT.txt for the actual build verification performed on this package.
No physical BLE connection or I2C hardware testing was possible here.

## Physical UART (XIAO nRF52840)

The same BLE-I2C-UART-v2 device and connection expose a second, custom GATT service.
The original I2C service and 20-byte protocol remain compatible with existing clients.

- TX: P1.11 (XIAO D6), connect to target RX.
- RX: P1.12 (XIAO D7), connect to target TX.
- Connect grounds. Use compatible 3.3 V logic, not RS-232 voltage levels.
- Fixed 115200 baud, 8 data bits, no parity, 1 stop bit, no RTS/CTS.
- UART uses UARTE0, TIMER1, PPI channels 0/1 and PPI group 0.

UART service: `93b10001-e8a8-4f6c-a592-31a52c5db031`  
RX (write with response): `93b10002-e8a8-4f6c-a592-31a52c5db031`  
TX (notify): `93b10003-e8a8-4f6c-a592-31a52c5db031`

Enable TX notifications to receive physical UART input. Frames are exactly 20 bytes:

- Host to UART: `[length, data..., zero_padding...]`, length 1 through 19.
  A BLE write acknowledgement means bytes were queued for UART transmission,
  not that the target received or processed them. Wait for each write acknowledgement.
- UART to host: `[kind, length, data..., zero_padding...]`, up to 18 data bytes.
  Kind 0 carries serial data; kind 1 with length 0 reports lost incoming bytes.
  An overflow report means loss occurred somewhere in the buffered stream; it
  does not identify the exact byte boundary. Larger messages span multiple frames.

UART reception and notifications run independently from I2C transaction execution.
Reception uses a 2048-byte hardware-driver buffer and a 64-frame notification queue;
TX has a 256-byte buffer. Continuous 115200-baud traffic is not guaranteed lossless
because BLE throughput depends on the central and connection parameters. Overflow
is reported before a subsequent queued data frame. Data received while disconnected
or before notification subscription is discarded; this is not a persistent logger.
Queued UART TX bytes can finish transmitting after disconnection.

The updated `ble-i2c-console` includes a live UART terminal with text/hex sending,
optional LF or CRLF for text, and incoming hex plus UTF-8 text display. UART service
absence is tolerated so the console can still use older I2C-only firmware. Reconnect
and grant access to the new service after flashing; a client caching the old GATT
layout may need its saved device association cleared.

For a first hardware check, connect D6 to D7, send text from the UART terminal,
and confirm the same bytes appear as RX. Then remove the loopback and wire the target.

## Upgrading from the first UART build

This revision advertises as **BLE-I2C-UART-v2** and changes the example static
random address from C0:05:04:03:02:01 to C0:05:04:03:02:02. This deliberately gives
hosts a fresh identity after adding the UART GATT service. Choose the new name
in the browser device picker; disconnect other clients first. If only the old
name appears after a power cycle, verify the firmware file and flashing process.
The console now distinguishes a missing service from characteristic/subscription
setup failures instead of calling every NotFoundError an old firmware version.

A connected peripheral is normally absent from a new-device scan while its one
BLE connection is active. Disconnect in the console before checking advertising.
I2C transfers no longer hold up disconnect processing or the advertising loop.

Host firmware regression tests (using the actual I2C worker with simulated hardware):

```sh
cargo test --manifest-path firmware-tests/Cargo.toml --target aarch64-apple-darwin --locked --offline
```

Replace the target with your host triple on another platform. Tests cover a NACK
from an absent target, deadline expiry without DMA cancellation, retaining busy
state until hardware completes, discarding late results, and subsequent recovery.

## I2C bus scanning

The console opens on the I2C tab. UART has its own tab; switching tabs preserves
both panels and keeps UART notifications active in the background. The Bluetooth
connection controls are shared. Tabs support arrow keys, Home and End.

Click **Scan I2C bus** to probe the unshifted addresses 0x08 through 0x77. Responding
addresses appear as buttons; selecting one fills the transaction address field.
The scan uses one-byte reads, not register writes or an address-only probe. Reads
can consume FIFO data, advance pointers, or affect some devices; only scan when
appropriate for the attached devices. Write-only devices may not respond.

Dedicated scan request: exactly 20 bytes, `[id, 0x00, 0xFF, 0x00, zero_padding...]`.
Older firmware rejects it with status 1. The success response remains exactly
20 bytes: `[id, 0, bitmap (14 bytes), zero_padding (4 bytes)]`. Bit 0 of bitmap
byte 0 corresponds to address 0x08, bit 7 to 0x0F, and so on through 0x77.
Only a complete successful scan should be displayed as an address list.
Address NACKs mean no response; other bus errors abort with status 2. A stuck
scan reports status 3 after the existing 250 ms deadline and retains ownership
of its in-flight DMA buffers, while Bluetooth/UART continue operating.

A 1 ms pause between probes gives the driver's requested STOP time to finish
before another START and yields to BLE processing. No scan retries are performed.
