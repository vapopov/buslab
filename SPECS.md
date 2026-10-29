# XIAO nRF52840 BLE-to-I²C + UART bridge

Licensed under the [MIT License](LICENSE).

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

Legacy transactions (up to 18 read bytes) use exactly 20 bytes per command,
zero-padding unused bytes. Larger reads use the extension described below:

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

## Large reads over 20-byte Bluetooth packets

The console and scripting API now support **0 through 2047 read bytes** and up to
32768 write bytes per transaction. Writes above 16 bytes use the buffered
request protocol below. A combined write/read sends the command once,
uses a repeated START, reads the whole requested block, then stops. Splitting
happens only on Bluetooth; it does not create extra I2C reads or repeat the command.
Read lengths up to 18 keep the original packet format for existing clients.

For a larger read, the 20-byte request is:

- Byte 0: request ID.
- Byte 1: 0x80 OR the unshifted 7-bit I2C target address.
- Byte 2: write length (low 5 bits) OR ((read length >> 8) << 5).
- Byte 3: low byte of read length.
- Bytes 4–19: up to 16 command bytes, padded with zeros.

The extended read length must be 19–2047. Old firmware rejects the extended
address with status 1, which the new client reports as requiring updated firmware.
Error replies keep the existing `[id, status, padding...]` format and return no data.
Successful large reads return these 20-byte notifications in order:

1. Begin: `[id, 0x80, total_lo, total_hi, padding (16 bytes)]`.
2. Data: `[id, 0x81, offset_lo, offset_hi, data (up to 16 bytes), padding]`.
3. End: `[id, 0x82, total_lo, total_hi, padding (16 bytes)]`.

Offsets count only I2C read bytes, starting at zero. Final payload length is
inferred from total length. The browser checks IDs, total length, sequential
byte offsets and the end marker. Missing/duplicate/out-of-order fragments fail
rather than returning partial bytes. A response timeout requires reconnecting;
no I2C command is automatically retried. Large Bluetooth responses have a 15 s
client timeout; the physical I2C transfer keeps its existing 250 ms deadline.

The onboard **blue LED on P0.06** is initialized off (active-low). Incoming I2C/UART
BLE data writes and outgoing I2C/UART response packets trigger short activity pulses.
A separate async loop drives 15 ms on/off pulses without delaying I2C or BLE.
Closely spaced events coalesce into a visible flicker; it is an activity indicator,
not an exact packet counter. The green P0.30 connection indicator is unchanged.

## JavaScript scripts and selected binary files

The I2C tab includes an editable JavaScript field, file picker, Run/Stop buttons,
progress and a bounded log. The edited source is saved locally in the browser.
Files are read as raw bytes; the selected file is not automatically uploaded to
any server or sent to a device. Scripts execute only after Run is clicked.

The script environment supplies:

| Name | Behavior |
| --- | --- |
| `file` | Selected binary as a Uint8Array (empty when no file is selected). |
| `fileName` | Selected file name. |
| `await i2c.write(address, bytes)` | One I2C write, up to 32768 bytes. |
| `await i2c.read(address, count)` | One I2C read, up to 2047 bytes. |
| `await i2c.writeRead(address, bytes, count)` | Command write + repeated START + one read. |
| `await i2c.transfer(address, bytes, count)` | General write/read operation; returns read bytes. |
| `await sleep(ms)` | Delay without blocking the page. |
| `log(...)`, `progress(sent, total)` | Append output and update upload progress. |
| `ascii(string)`, `text(bytes)`, `hex(bytes)` | Encode UTF-8, decode UTF-8, or format hex. |

Await I2C calls. Calls are serialized, and I2C status errors reject the script's
operation. No write is automatically retried. Normal I2C/scan/UART send controls
are locked during a script; receiving and tab switching remain active. Stop
terminates the script worker, discards queued calls and waits for the dispatched
I2C transaction to finish or time out before unlocking controls. It cannot undo
commands that already reached the target. Run only trusted scripts: the worker
is an execution-isolation mechanism, not a security sandbox for arbitrary code.

## Buffered writes and staging

Writes of 17–32768 bytes are assembled from 20-byte BLE packets before one I2C
transaction is executed. This supports a 64-byte DATA1 register payload plus its
register and length prefix (66 write bytes total). Up to 2047 bytes can follow the
write using a repeated START. Existing writes of up to 16 bytes stay compatible.

Request frames reserve byte 1 = 0x01 (outside the supported I2C target range):

| Frame | Layout (remaining bytes zero-padded) |
| --- | --- |
| Begin | `[id, 1, 0, address, write_len_lo, write_len_hi, read_len_lo, read_len_hi, stage_flag]` |
| Data | `[id, 1, 1, offset_lo, offset_hi, payload (up to 15 bytes)]` |
| Commit | `[id, 1, 2]` |
| Write staged | `[id, 1, 3, target_address]` |
| Abort | `[id, 1, 4]` |

Begin and data frames receive ATT acknowledgements only. The firmware checks the
ID, sequential offsets, length and commit before touching I2C. Normal commit
executes one continuous transaction and returns the usual response (fragmented
if the read is larger than 18 bytes). Invalid/incomplete uploads execute nothing.

`await i2c.stage(file)` sets stage_flag=1, address=0, read length=0. Commit then
acknowledges buffering with status 0 and performs no I2C operation. Small command
writes/reads can run while that file remains staged. `await i2c.writeStaged(address)`
consumes the staged file in one local I2C write, without inserting register/length
bytes. One upload buffer is shared; while a file is staged, use short command
writes until it is consumed, or restage or disconnect to replace/discard it.

The buffer has static storage and ownership moves to the I2C worker for DMA.
It is returned only after hardware completes, including after an application
timeout. Disconnect discards upload/staged state; incomplete files cannot execute
on a later connection. The buffer is 32 KiB. At 100 kHz a maximum-size raw write
needs approximately 3 seconds of wire time; the application deadline is 250 ms
plus 0.1 ms per buffered write byte. An in-flight hardware transfer is never
cancelled, and timed-out writes are never retried automatically.

Uploads refresh the browser's 15-second inactivity deadline on each acknowledged
packet. Stop during buffering sends Abort before Commit; Stop after execution
starts waits for its result. No command can undo data already delivered to a target.

## TPS25751 Patch Burst Mode example

The default JavaScript now follows [TI SLVAFV8A](https://www.ti.com/lit/pdf/slvafv8)
and [SLVUCR8B](https://www.ti.com/lit/pdf/slvucr8), sections 4.5 and 5.2:

1. Stage the selected **Low Region Binary** on the nRF52840 before PBMs starts.
2. Verify PTCH mode, ReadyForPatch bit 81, and idle CMD1. Preserve interrupt
   masks while enabling PatchLoaded bit 80, then clear any old PatchLoaded event.
3. Write six DATA1 parameters: uint32 little-endian bundle size, unused patch
   address (example 0x30), and timeout 0x32 (5 seconds).
4. Issue PBMs at the fundamental address (example 0x20), wait at least 500 µs,
   poll CMD1 for completion / !CMD and check PatchStartStatus.
5. Send the staged raw binary to the patch address without register/length framing.
6. Issue PBMc at the fundamental address, poll CMD1, read the full 64-byte DATA1
   response (65 read bytes including its count prefix), check return/patch/config
   status, and verify PatchLoaded plus MODE APP.

DATA1's 512-bit width is its capacity; it does not require every task to write
64 bytes. TI permits partial register accesses. PBMs uses six input bytes.

Confirm TPS_ADDR matches the ADCIN-configured address and PATCH_ADDR is unused.
Use a valid Low Region Binary generated for the target; file contents are not
repaired or converted. The script refuses APP mode and nonzero completion statuses
instead of claiming success. These steps and failure paths are tested with a
protocol model; actual patch acceptance, clock stretching, electrical behavior,
and CRC results must be tested on the user's TPS25751. No physical loading was
performed here. To replace a saved older script, click Load example into editor.

## UF2 builds and GitHub releases

The **Build firmware UF2** GitHub Actions workflow can be run manually from the
Actions tab. Download `buslab-xiao-nrf52840` from the run's artifacts and extract
the `.uf2`. Pushing a `v*` tag also creates a draft GitHub Release with UF2, raw
binary, debug ELF, and SHA-256 checksums. Review and test before publishing it.
Pull requests affecting firmware or packaging also build the artifact.

The `xiao-uf2` feature selects `memory-xiao-uf2.x`: application flash starts at
`0x27000` and ends before `0xF4000`; RAM starts at `0x20008000` to preserve the
bootloader's lower RAM and double-reset marker. It initializes VTOR to the app's
vector table. This targets the stock XIAO Adafruit bootloader with S140 v7 left
in flash; the application still runs MPSL/SDC rather than enabling S140.
Other bootloader layouts require a matching build. Physical boot, BLE, I2C and
UART validation of this UF2 build is still required.

The default SWD build retains the original address-zero layout in `memory-swd.x`.
`memory.x` includes the layout selected by `build.rs` from the build output
folder, using a distinct filename to avoid the linker choosing the root file.

Local packaging with the Rust utilities (Rust 1.93 or later required by the
locked dependencies):

```sh
rustup target add thumbv7em-none-eabihf
rustup component add llvm-tools-preview
cargo install cargo-binutils --version 0.3.6 --locked
cargo install uf2conv --version 0.1.0 --locked
cargo objcopy --release --locked --features xiao-uf2 --bin embassy-nrf-i2c-bridge -- -O binary buslab-xiao-nrf52840.bin
uf2conv buslab-xiao-nrf52840.bin --base 0x27000 --family 0xADA52840 --output buslab-xiao-nrf52840.uf2
python3 scripts/verify-uf2.py buslab-xiao-nrf52840.bin buslab-xiao-nrf52840.uf2
```

With the compatible bootloader installed, double-press Reset and copy the UF2 to
its USB drive. The UF2 contains only the application; it does not install or
restore the bootloader. If BLE does not start after copying, try a physical reset
and report the bootloader version along with the firmware version.
