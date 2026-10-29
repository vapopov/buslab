# BLE I²C + UART Console

**[Open the web client](https://buslab.let.run)** to try **Explore a sample** without hardware, or connect your board over Bluetooth.

See [SPECS.md](../SPECS.md) for the firmware protocol.

## Run locally

Open a terminal in the ble-i2c-console directory, then run:

    python3 -m http.server 8000 --bind 127.0.0.1

Open http://localhost:8000 in desktop Chrome or Edge.
Do not open index.html directly using a file:// URL. Web Bluetooth needs a
secure context: localhost works for local development; remote hosting needs HTTPS.
No npm install, build step, or ChatGPT login is required for this local export.
Internet access is optional for the Google Fonts stylesheet; system fonts are
used as fallbacks if it cannot load.

## Use

1. Disconnect the phone's nRF Connect session (firmware allows one connection).
2. Click Connect device and choose BLE-I2C-UART-v2. Allow browser/OS Bluetooth access.
3. Enter the unshifted 7-bit I2C address in hex (08 through 77).
4. Enter up to 32768 hex write bytes, such as A0 01 FF or A001FF.
5. Choose the read count in decimal (0 through 2047).
6. Send the transaction; click a response byte to inspect bits b7 through b0.

Empty write data gives a read-only transaction. A read count of zero gives a
write-only transaction. A combined transaction uses a repeated START.
Explore a sample demonstrates the inspector without connecting to hardware.
Samples are labeled and never sent to a device.

The client uses the exact 20-byte packet format from the Embassy firmware.
It subscribes to Nordic UART Service TX notifications before sending requests
to RX. Responses are checked by request ID; headers and padding are removed
from the displayed read bytes. No automatic retries are performed. Reconnect
after a timeout, because a write may already have executed.

Transactions remain in the browser tab and are not sent to a backend.
The exported version contains no deployment identity, credentials or server.

## Files

index.html, style.css: interface
app.js: UI behavior
protocol.mjs: packet encoding and decoding
transport.mjs: Web Bluetooth connection and transactions
tests/bridge.test.mjs: protocol and mocked Bluetooth tests

Run tests with Node.js:

    node --test tests/bridge.test.mjs

The hosted app's eight tests passed and the UI was checked in a browser.
A live Bluetooth/I2C hardware test has not been performed here.

## UART terminal

Flash the updated firmware, then reconnect. UART is on XIAO D6 / P1.11 (TX)
and D7 / P1.12 (RX), fixed 115200 baud, 8-N-1, no flow control. Connect TX to
target RX, RX to target TX, and ground to ground, using compatible 3.3 V logic.

Use the UART tab beside the I2C workbench. Choose UTF-8 text or hex bytes;
text can append no ending, LF, or CRLF. RX streams automatically and shows both
hex and decoded text. The bounded log retains its latest 64000 characters.
Sending is split into acknowledged BLE writes; a queued confirmation does not
confirm delivery to the target. Failed sends are never retried automatically.

I2C and UART share one connection and have independent notification channels.
The console serializes outgoing I2C/UART operations to avoid overlapping browser
GATT writes. UART reception continues during I2C requests. Older firmware still
supports I2C and displays UART as unavailable. Overflow warnings mean receive
bytes were lost; sustained full-rate serial input may exceed BLE throughput.
Data received while disconnected is discarded.

For loopback validation, connect D6 to D7 and send a short text/hex message.
Physical Bluetooth and UART validation must be performed on the board.

## Firmware v2 troubleshooting

Select **BLE-I2C-UART-v2** after flashing the rebuilt firmware. This revision uses
a fresh BLE address to avoid an old cached I2C-only service table. If UART setup
fails, the terminal status now identifies whether the service is missing or
characteristic/notification setup failed. Forget the saved device and reconnect
if the host still uses a stale service table.

An unplugged I2C bus now has internal idle pull-ups. With no target, requests
should report an I2C error. Stuck transfers report a firmware timeout after
250 ms without freezing Bluetooth or UART. Status 4 means hardware is still
busy; release the stuck lines or reset the board if needed. These replies are
completed transactions, so the console keeps the connection usable. A browser
response timeout still requires reconnecting because delivery is uncertain.

## Bus tabs and scan

I2C is the default tab. UART has a separate tab; the Bluetooth connection is shared
and UART reception continues while I2C is visible. Switching tabs preserves inputs
and logs. Use the arrow keys, Home or End to navigate the tabs by keyboard.

After flashing the latest firmware, click **Scan I2C bus** in the I2C tab. It checks
0x08 through 0x77 and displays responding addresses as buttons. Click an address
to use it in the transaction form. Scan results are cleared on disconnect.

Scanning reads one byte per address; it may consume data or change state on some
devices and may not find write-only devices. Bus errors/timeouts are shown as scan
failures rather than an empty result. Scan requests use the existing I2C service,
so no new Bluetooth service permission or identity is needed for this upgrade.

## Large reads and file scripts

Flash the updated firmware, then reload the console. Read counts now support
0–2047 bytes. Large reads remain one I2C transaction; 20-byte Bluetooth packets
are reassembled and checked before data is displayed. Failed or incomplete
responses are never returned as partial data. The command write limit is now
32768 bytes, and reads up to 18 bytes remain compatible with older firmware.

In the I2C tab, use **I2C script & binary file** to choose a binary and edit the
JavaScript example. The file appears as `file` (a Uint8Array) and `fileName`.
The TPS25751 example uses a valid Low Region Binary selected as `file`. Click Run
to execute; choosing a file alone sends nothing. The script first buffers the
binary with `await i2c.stage(file)`, then configures PBMs and calls
`await i2c.writeStaged(PATCH_ADDR)` to stream it locally. This keeps Bluetooth
latency outside the device's burst-mode timeout.

Scripts run in a separate worker. Source is saved locally; files remain in memory
for the current page. Run only scripts you trust. APIs include `await i2c.write`,
`read`, `writeRead`, `stage`, `writeStaged`, plus `sleep`, `log`, `progress`, `ascii`,
`text` and `hex`. Normal send/scan controls are locked during scripts; UART RX and
tabs stay active. Stop aborts buffered data before execution, or waits for an
in-flight I2C transfer. No write is automatically retried.

Writes up to 32 KiB, including 66-byte framed DATA1 writes, are sent as one I2C
transaction after BLE reassembly. One staging buffer is shared: short command
writes may run while a file is staged, but another buffered large write requires
consuming or replacing that staged file first. Reads support up to 2047 bytes.

The updated default follows TI's documented sequence: PTCH / ReadyForPatch checks,
six PBMs parameters, CMD1 polling and status checks, raw patch-address data, PBMc
status and APP verification. Set the fundamental and unused patch addresses for
your hardware. The DATA1 register is 64 bytes wide but PBMs takes six input bytes.
Hardware patch loading remains unverified. Reload the page and click **Load example
into editor** to replace a saved earlier script.

Blue P0.06 activity pulses indicate Bluetooth data packets; rapid packets may
merge into flicker. Green P0.30 remains the connection indicator.

Run console regressions:

    node --test tests/bridge.test.mjs tests/scripts.test.mjs tests/highlight.test.mjs

For real browser worker tests without hardware, open `tests/script-harness.html`
through the local server and click Run browser tests. It uses simulated I2C only.

The JavaScript editor includes live syntax highlighting for comments, strings,
keywords, numbers, functions, templates and regex literals. Prism 1.30.0 is bundled
locally in `vendor/` with its MIT license, so highlighting works offline. Editing,
selection, Tab indentation, saved scripts and Run/Stop still use the same textarea.
