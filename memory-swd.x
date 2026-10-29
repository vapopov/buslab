/* SWD application, no bootloader or separately flashed S140 SoftDevice. */
MEMORY
{
  FLASH : ORIGIN = 0x00000000, LENGTH = 1024K
  RAM   : ORIGIN = 0x20000000, LENGTH = 256K
}
