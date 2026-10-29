"""Check the XIAO application slot, vectors, and Rust uf2conv output."""
import struct
import sys
from pathlib import Path

binary = Path(sys.argv[1]).read_bytes()
image = Path(sys.argv[2]).read_bytes()
assert 8 <= len(binary) <= 0xCD000, "Binary exceeds application slot"
stack, reset = struct.unpack_from('<II', binary)
assert 0x20008000 < stack <= 0x20040000, "Invalid initial stack pointer"
assert reset & 1 and 0x27000 <= reset < 0xF4000, "Binary is not linked for UF2"
assert image and len(image) % 512 == 0, "Invalid UF2 size"
payload = bytearray()
for number, offset in enumerate(range(0, len(image), 512)):
    block = image[offset:offset + 512]
    magic0, magic1, flags, address, size, index, total, family = struct.unpack_from('<8I', block)
    assert (magic0, magic1) == (0x0A324655, 0x9E5D5157), "Invalid UF2 magic"
    assert flags == 0x2000 and family == 0xADA52840, "Wrong UF2 family/flags"
    assert index == number and total == len(image) // 512, "Invalid block sequence"
    assert 0 < size <= 476, "Invalid payload size"
    assert address == 0x27000 + len(payload), "Noncontiguous addresses"
    assert address + size <= 0xF4000, "UF2 overlaps bootloader"
    assert struct.unpack_from('<I', block, 508)[0] == 0x0AB16F30, "Invalid end magic"
    payload.extend(block[32:32 + size])
assert payload[:len(binary)] == binary, "UF2 payload differs from binary"
assert not any(payload[len(binary):]), "Unexpected trailing payload"
print(f'Validated {len(binary)} firmware bytes in {len(image) // 512} UF2 blocks.')
