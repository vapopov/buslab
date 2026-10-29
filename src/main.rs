#![no_std]
#![no_main]

use defmt_rtt as _;
use embassy_executor::Spawner;
use embassy_nrf::gpio::{Level, Output, OutputDrive};
use embassy_nrf::interrupt::typelevel::Interrupt as _;
use embassy_nrf::{bind_interrupts, buffered_uarte, interrupt, peripherals, rng, twim, uarte};
use nrf_mpsl::{self as mpsl, MultiprotocolServiceLayer};
use nrf_sdc as sdc;
use panic_probe as _;
use static_cell::StaticCell;

mod bridge;
mod i2c_worker;
mod write_upload;

bind_interrupts!(struct Irqs {
    EGU0_SWI0 => mpsl::LowPrioInterruptHandler;
    CLOCK_POWER => mpsl::ClockInterruptHandler;
    RADIO => mpsl::HighPrioInterruptHandler;
    TIMER0 => mpsl::HighPrioInterruptHandler;
    RTC0 => mpsl::HighPrioInterruptHandler;
    RNG => rng::InterruptHandler<peripherals::RNG>;
    UARTE0 => buffered_uarte::InterruptHandler<peripherals::UARTE0>;
    TWISPI0 => twim::InterruptHandler<peripherals::TWISPI0>;
});

#[embassy_executor::task]
async fn mpsl_task(layer: &'static MultiprotocolServiceLayer<'static>) -> ! {
    layer.run().await
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let mut config = embassy_nrf::config::Config::default();
    // Keep application interrupts below MPSL's reserved high-priority interrupts.
    config.time_interrupt_priority = interrupt::Priority::P6;
    let p = embassy_nrf::init(config);
    // XIAO's onboard green LED is active-low: start off while advertising.
    let connection_led = Output::new(p.P0_30, Level::High, OutputDrive::Standard);
    let activity_led = Output::new(p.P0_06, Level::High, OutputDrive::Standard);

    interrupt::typelevel::UARTE0::set_priority(interrupt::Priority::P6);
    interrupt::typelevel::RNG::set_priority(interrupt::Priority::P6);
    interrupt::typelevel::TWISPI0::set_priority(interrupt::Priority::P6);

    let mpsl_peripherals =
        mpsl::Peripherals::new(p.RTC0, p.TIMER0, p.TEMP, p.PPI_CH19, p.PPI_CH30, p.PPI_CH31);
    // Internal 32 kHz RC clock: no external 32.768 kHz crystal required.
    let clock = mpsl::raw::mpsl_clock_lfclk_cfg_t {
        source: mpsl::raw::MPSL_CLOCK_LF_SRC_RC as u8,
        rc_ctiv: 16,
        rc_temp_ctiv: 2,
        accuracy_ppm: 500,
        skip_wait_lfclk_started: false,
    };
    static MPSL: StaticCell<MultiprotocolServiceLayer<'static>> = StaticCell::new();
    let layer = MPSL.init(MultiprotocolServiceLayer::new(mpsl_peripherals, Irqs, clock).unwrap());
    spawner.spawn(mpsl_task(layer).unwrap());

    let sdc_peripherals = sdc::Peripherals::new(
        p.PPI_CH17, p.PPI_CH18, p.PPI_CH20, p.PPI_CH21, p.PPI_CH22, p.PPI_CH23, p.PPI_CH24,
        p.PPI_CH25, p.PPI_CH26, p.PPI_CH27, p.PPI_CH28, p.PPI_CH29,
    );
    let mut random = rng::Rng::new(p.RNG, Irqs);
    let mut radio_memory = sdc::Mem::<8192>::new();
    let controller = sdc::Builder::new()
        .unwrap()
        .support_adv()
        .support_peripheral()
        .peripheral_count(1)
        .unwrap()
        .build(sdc_peripherals, &mut random, layer, &mut radio_memory)
        .unwrap();

    let mut i2c_config = twim::Config::default();
    i2c_config.frequency = twim::Frequency::K100;
    // Keep an unplugged bus idle-high; external pull-ups are still recommended.
    i2c_config.sda_pullup = true;
    i2c_config.scl_pullup = true;
    let mut tx_buffer = [0u8; 32];
    // Twim::new takes SDA FIRST, then SCL.
    let i2c = twim::Twim::new(
        p.TWISPI0,
        Irqs,
        p.P0_04, // SDA
        p.P0_05, // SCL
        i2c_config,
        &mut tx_buffer,
    );
    let mut uart_config = uarte::Config::default();
    uart_config.baudrate = uarte::Baudrate::Baud115200;
    let mut uart_rx_buffer = [0u8; 2048];
    let mut uart_tx_buffer = [0u8; 256];
    let uart = buffered_uarte::BufferedUarte::new(
        p.UARTE0,
        p.TIMER1,
        p.PPI_CH0,
        p.PPI_CH1,
        p.PPI_GROUP0,
        p.P1_12, // RX: XIAO D7
        p.P1_11, // TX: XIAO D6
        Irqs,
        uart_config,
        &mut uart_rx_buffer,
        &mut uart_tx_buffer,
    );
    // Changed for the v2 GATT layout so hosts rediscover the added UART service.
    // A fixed example address; assign a unique static-random address per unit.
    let address = trouble_host::prelude::Address::random([2, 2, 3, 4, 5, 0xC0]);
    static UPLOAD_BUFFER: StaticCell<[u8; i2c_worker::MAX_WRITE]> = StaticCell::new();
    let upload_buffer = UPLOAD_BUFFER.init_with(|| [0; i2c_worker::MAX_WRITE]);
    bridge::run(
        controller,
        i2c,
        uart,
        address,
        connection_led,
        activity_led,
        upload_buffer,
    )
    .await;
}
