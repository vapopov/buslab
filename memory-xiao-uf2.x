/* Stock XIAO nRF52840 Adafruit bootloader with S140 v7 present.
 * Preserve 0..0x27000 and bootloader/settings at 0xF4000..0x100000.
 * Keep the bootloader's lower RAM and double-reset marker untouched.
 * S140 remains in flash but is not enabled: this app uses MPSL/SDC.
 */
MEMORY
{
  FLASH : ORIGIN = 0x00027000, LENGTH = 0x000CD000
  RAM   : ORIGIN = 0x20008000, LENGTH = 0x00038000
}
