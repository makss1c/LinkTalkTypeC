//! AES67 network audio backend for the LinkTalk Bridge.
//!
//! Pure Rust, no runtime to install and no licence: RTP (L24/L16, 48 kHz, 1 ms packets) over
//! multicast, a minimal PTPv2 slave (IEEE 1588, E2E, software timestamps) for the sender
//! timestamps, and SAP/SDP (RFC 2974 / RFC 4566) for discovery and announcement.
//!
//! Any console or gateway in AES67 mode can be connected: Dante devices with AES67 enabled,
//! Riedel, Yamaha, Allen & Heath, DiGiCo, Ravenna and so on.
//!
//! Devices exposed to the Bridge:
//!   * `aes67:recv:<hash>`  every AES67 stream announced via SAP (or listed in `aes67.json`),
//!   * `aes67:send:<1..8>`  eight multichannel (default 8 ch) sender slots "LinkTalk Bridge N".
//!
//! One mono four-wire line = one channel of a slot (or a source); a Bridge port is assigned a
//! channel (left == right means mono) exactly like for NDI/OMT.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, SockAddr, Socket, Type};

use crate::audio::{AudioConfigRange, AudioDeviceInfo, ChannelPair};
use crate::bridge_media::{BridgeOutputLevel, BridgeOutputMixerSource};

const AES67_INPUT_PREFIX: &str = "aes67:recv:";
const AES67_OUTPUT_PREFIX: &str = "aes67:send:";
const AES67_OUTPUT_SLOTS: usize = 8;
const MAX_CHANNELS: usize = 8;
const FRAMES_PER_PACKET: usize = 48; // 1 ms at 48 kHz (AES67 mandatory packet time)
const INPUT_CHUNK_FRAMES: usize = 480; // 10 ms handed to the Opus path
const DEFAULT_RTP_PORT: u16 = 5004;
const DEFAULT_PAYLOAD_TYPE: u8 = 97;

const PTP_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 1, 129);
const PTP_EVENT_PORT: u16 = 319;
const PTP_GENERAL_PORT: u16 = 320;
const SAP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 255);
const SAP_PORT: u16 = 9875;

const SOURCE_TTL: Duration = Duration::from_secs(300);
const SAP_INTERVAL: Duration = Duration::from_secs(30);
const PTP_STALE_NS: i64 = 5_000_000_000;
const MASTER_TIMEOUT_NS: i64 = 10_000_000_000;
const DELAY_REQ_INTERVAL: Duration = Duration::from_secs(1);
const D1_WINDOW: usize = 16;
const DELAY_WINDOW: usize = 8;

// ------------------------------------------------------------------ configuration

fn default_rtp_port() -> u16 {
    DEFAULT_RTP_PORT
}
fn default_payload_type() -> u8 {
    DEFAULT_PAYLOAD_TYPE
}
fn default_manual_channels() -> u16 {
    2
}
fn default_bits() -> u8 {
    24
}

/// Optional `aes67.json` (see docs/AES67.md). Every field has a default.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Aes67Config {
    /// IPv4 address of the network adapter connected to the AES67/Dante network.
    pub interface: Option<String>,
    /// PTP domain number (Dante in AES67 mode uses 0).
    pub ptp_domain: u8,
    /// Channels per sender slot, 1..=8.
    pub output_channels: u16,
    /// Base for sender multicast groups, e.g. "239.69.50" -> 239.69.50.<slot>.
    pub output_base: Option<String>,
    /// RTP payload type of our sender streams.
    pub payload_type: u8,
    /// Announce our sender streams via SAP.
    pub sap_announce: bool,
    /// Streams that do not announce themselves.
    pub sources: Vec<ManualSource>,
}

impl Default for Aes67Config {
    fn default() -> Self {
        Self {
            interface: None,
            ptp_domain: 0,
            output_channels: 8,
            output_base: None,
            payload_type: DEFAULT_PAYLOAD_TYPE,
            sap_announce: true,
            sources: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManualSource {
    pub name: String,
    pub multicast: String,
    #[serde(default = "default_rtp_port")]
    pub port: u16,
    #[serde(default = "default_manual_channels")]
    pub channels: u16,
    #[serde(default = "default_payload_type")]
    pub payload_type: u8,
    /// 24 (L24) or 16 (L16)
    #[serde(default = "default_bits")]
    pub bits: u8,
}

static CONFIG: OnceLock<Mutex<Aes67Config>> = OnceLock::new();
static CONFIG_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn config_cell() -> &'static Mutex<Aes67Config> {
    CONFIG.get_or_init(|| {
        let (config, error) = read_config_file();
        if let Ok(mut slot) = CONFIG_ERROR.lock() {
            *slot = error;
        }
        Mutex::new(config)
    })
}

fn config() -> Aes67Config {
    config_cell()
        .lock()
        .map(|config| config.clone())
        .unwrap_or_default()
}

fn reload_config() {
    let (config, error) = read_config_file();
    if let Ok(mut current) = config_cell().lock() {
        *current = config;
    }
    if let Ok(mut slot) = CONFIG_ERROR.lock() {
        *slot = error;
    }
}

pub fn config_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("LINKTALK_AES67_CONFIG") {
        return Some(PathBuf::from(path));
    }
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(|dir| PathBuf::from(dir).join("LinkTalk Bridge").join("aes67.json"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|dir| {
            PathBuf::from(dir)
                .join("Library")
                .join("Application Support")
                .join("LinkTalk Bridge")
                .join("aes67.json")
        })
    } else {
        std::env::var_os("HOME").map(|dir| {
            PathBuf::from(dir)
                .join(".config")
                .join("linktalk-bridge")
                .join("aes67.json")
        })
    }
}

fn read_config_file() -> (Aes67Config, Option<String>) {
    let Some(path) = config_path() else {
        return (Aes67Config::default(), None);
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Aes67Config>(&text) {
            Ok(config) => (config, None),
            Err(error) => (
                Aes67Config::default(),
                Some(format!("{}: {error}", path.display())),
            ),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => (Aes67Config::default(), None),
        Err(error) => (
            Aes67Config::default(),
            Some(format!("{}: {error}", path.display())),
        ),
    }
}

fn output_channels() -> usize {
    usize::from(config().output_channels).clamp(1, MAX_CHANNELS)
}

// ------------------------------------------------------------------ helpers

fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "linktalk".to_string())
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::ConnectionReset
    )
}

/// Monotonic clock expressed in "unix" nanoseconds. Immune to wall clock steps; the PTP offset
/// estimate absorbs the (constant) difference to the PTP/TAI timescale.
fn local_now_ns() -> i64 {
    static ANCHOR: OnceLock<(Instant, i64)> = OnceLock::new();
    let (instant, base) = ANCHOR.get_or_init(|| {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as i64)
            .unwrap_or(0);
        (Instant::now(), epoch)
    });
    *base + instant.elapsed().as_nanos() as i64
}

fn detect_default_interface() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // UDP connect only selects a route, no packet is sent.
    socket.connect("192.0.2.1:9").ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(address) => Some(*address.ip()),
        SocketAddr::V6(_) => None,
    }
}

fn local_interface() -> Ipv4Addr {
    if let Some(text) = config().interface {
        if let Ok(address) = text.trim().parse::<Ipv4Addr>() {
            return address;
        }
    }
    detect_default_interface().unwrap_or(Ipv4Addr::UNSPECIFIED)
}

fn new_udp_socket() -> io::Result<Socket> {
    Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
}

/// Multicast receiver. Windows binds to the wildcard address (it filters by membership),
/// other systems bind to the group address so streams sharing a port do not mix.
fn multicast_receiver(group: Ipv4Addr, port: u16, iface: Ipv4Addr) -> io::Result<UdpSocket> {
    let socket = new_udp_socket()?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    {
        let _ = socket.set_reuse_port(true);
    }
    let _ = socket.set_recv_buffer_size(1 << 20);
    let bind_ip = if cfg!(windows) {
        Ipv4Addr::UNSPECIFIED
    } else {
        group
    };
    socket.bind(&SockAddr::from(SocketAddrV4::new(bind_ip, port)))?;
    socket.join_multicast_v4(&group, &iface)?;
    let udp: UdpSocket = socket.into();
    udp.set_read_timeout(Some(Duration::from_millis(100)))?;
    Ok(udp)
}

fn rms_milli_db(sum_squares: f64, sample_count: usize) -> i32 {
    if sample_count == 0 || sum_squares <= 0.0 {
        return -120_000;
    }
    let rms = (sum_squares / sample_count as f64).sqrt();
    if rms <= 0.0 {
        return -120_000;
    }
    ((20.0 * rms.log10()).clamp(-120.0, 0.0) * 1000.0).round() as i32
}

fn fmt_clock_id(id: &[u8; 8]) -> String {
    id.iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join("-")
}

// ------------------------------------------------------------------ PTPv2 slave

struct PtpShared {
    /// local clock minus PTP clock, nanoseconds
    offset_ns: AtomicI64,
    /// local time of the last accepted Sync (0 = never)
    last_sync_local_ns: AtomicI64,
    grandmaster: Mutex<Option<[u8; 8]>>,
    error: Mutex<Option<String>>,
}

static PTP: OnceLock<Arc<PtpShared>> = OnceLock::new();

fn ptp_shared() -> Arc<PtpShared> {
    PTP.get_or_init(|| {
        let shared = Arc::new(PtpShared {
            offset_ns: AtomicI64::new(0),
            last_sync_local_ns: AtomicI64::new(0),
            grandmaster: Mutex::new(None),
            error: Mutex::new(None),
        });
        let thread_shared = Arc::clone(&shared);
        let _ = thread::Builder::new()
            .name("aes67-ptp".to_string())
            .spawn(move || ptp_supervisor(thread_shared));
        shared
    })
    .clone()
}

/// PTP time in nanoseconds, or `None` while no master is being tracked.
fn ptp_time_ns() -> Option<i64> {
    let shared = ptp_shared();
    let last = shared.last_sync_local_ns.load(Ordering::Relaxed);
    let now = local_now_ns();
    if last != 0 && now - last < PTP_STALE_NS {
        Some(now - shared.offset_ns.load(Ordering::Relaxed))
    } else {
        None
    }
}

#[derive(Clone)]
struct Master {
    port_id: [u8; 10],
    gm_id: [u8; 8],
    /// priority1, class, accuracy, variance(2), priority2, grandmaster identity; lower is better
    rank: [u8; 14],
    last_announce_ns: i64,
}

struct PtpEngine {
    shared: Arc<PtpShared>,
    domain: u8,
    our_id: [u8; 10],
    master: Option<Master>,
    pending_sync: Option<(u16, i64, i64)>, // sequence, t2, correction
    pending_delay: Option<(u16, i64)>,     // sequence, t3
    d1_window: VecDeque<i64>,
    delay_window: VecDeque<i64>,
    delay_seq: u16,
}

fn read_timestamp(bytes: &[u8]) -> i64 {
    let seconds = u64::from_be_bytes([0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]]);
    let nanos = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]);
    (seconds as i64) * 1_000_000_000 + i64::from(nanos)
}

fn read_correction(message: &[u8]) -> i64 {
    let raw = i64::from_be_bytes([
        message[8], message[9], message[10], message[11], message[12], message[13], message[14],
        message[15],
    ]);
    raw >> 16
}

impl PtpEngine {
    fn new(shared: Arc<PtpShared>, domain: u8) -> Self {
        let hash = stable_hash(&format!("{}:{}", hostname(), std::process::id()));
        let mut our_id = [0u8; 10];
        our_id[..8].copy_from_slice(&hash.to_be_bytes());
        our_id[8..10].copy_from_slice(&1u16.to_be_bytes());
        Self {
            shared,
            domain,
            our_id,
            master: None,
            pending_sync: None,
            pending_delay: None,
            d1_window: VecDeque::new(),
            delay_window: VecDeque::new(),
            delay_seq: 0,
        }
    }

    fn header_ok(&self, message: &[u8], minimum: usize) -> bool {
        message.len() >= minimum.max(34) && (message[1] & 0x0F) == 2 && message[4] == self.domain
    }

    fn is_selected_master(&self, message: &[u8]) -> bool {
        match &self.master {
            Some(master) => message[20..30] == master.port_id[..],
            None => false,
        }
    }

    fn on_announce(&mut self, message: &[u8], now_ns: i64) {
        if !self.header_ok(message, 64) {
            return;
        }
        let mut port_id = [0u8; 10];
        port_id.copy_from_slice(&message[20..30]);
        if port_id[..8] == self.our_id[..8] {
            return;
        }
        let mut gm_id = [0u8; 8];
        gm_id.copy_from_slice(&message[53..61]);
        let mut rank = [0u8; 14];
        rank[..6].copy_from_slice(&message[47..53]);
        rank[6..].copy_from_slice(&gm_id);
        let replace = match &self.master {
            None => true,
            Some(current) => {
                current.port_id == port_id
                    || now_ns - current.last_announce_ns > MASTER_TIMEOUT_NS
                    || rank < current.rank
            }
        };
        if !replace {
            return;
        }
        let changed = self
            .master
            .as_ref()
            .map(|current| current.port_id != port_id)
            .unwrap_or(true);
        if changed {
            self.d1_window.clear();
            self.delay_window.clear();
            self.pending_sync = None;
            self.pending_delay = None;
            self.shared.last_sync_local_ns.store(0, Ordering::Relaxed);
        }
        self.master = Some(Master {
            port_id,
            gm_id,
            rank,
            last_announce_ns: now_ns,
        });
        if let Ok(mut grandmaster) = self.shared.grandmaster.lock() {
            *grandmaster = Some(gm_id);
        }
    }

    fn on_sync(&mut self, message: &[u8], t2: i64) {
        if !self.header_ok(message, 44) || !self.is_selected_master(message) {
            return;
        }
        let sequence = u16::from_be_bytes([message[30], message[31]]);
        let correction = read_correction(message);
        let two_step = message[6] & 0x02 != 0;
        if two_step {
            self.pending_sync = Some((sequence, t2, correction));
        } else {
            let t1 = read_timestamp(&message[34..44]) + correction;
            self.process_sample(t1, t2);
        }
    }

    fn on_follow_up(&mut self, message: &[u8]) {
        if !self.header_ok(message, 44) || !self.is_selected_master(message) {
            return;
        }
        let sequence = u16::from_be_bytes([message[30], message[31]]);
        if let Some((pending_sequence, t2, sync_correction)) = self.pending_sync {
            if pending_sequence == sequence {
                self.pending_sync = None;
                let t1 = read_timestamp(&message[34..44]) + read_correction(message) + sync_correction;
                self.process_sample(t1, t2);
            }
        }
    }

    fn on_delay_resp(&mut self, message: &[u8]) {
        if !self.header_ok(message, 54) || !self.is_selected_master(message) {
            return;
        }
        if message[44..54] != self.our_id[..] {
            return;
        }
        let sequence = u16::from_be_bytes([message[30], message[31]]);
        if let Some((pending_sequence, t3)) = self.pending_delay {
            if pending_sequence == sequence {
                self.pending_delay = None;
                let t4 = read_timestamp(&message[34..44]) + read_correction(message);
                let d2 = t4 - t3;
                if let Some(min_d1) = self.d1_window.iter().copied().min() {
                    // d1 = offset + delay, d2 = delay - offset  =>  delay = (d1 + d2) / 2
                    let delay = (min_d1 + d2) / 2;
                    if (0..20_000_000).contains(&delay) {
                        self.delay_window.push_back(delay);
                        while self.delay_window.len() > DELAY_WINDOW {
                            self.delay_window.pop_front();
                        }
                    }
                }
            }
        }
    }

    fn process_sample(&mut self, t1: i64, t2: i64) {
        let d1 = t2 - t1;
        if let Some(&last) = self.d1_window.back() {
            if (d1 - last).abs() > 50_000_000 {
                self.d1_window.clear();
                self.delay_window.clear();
            }
        }
        self.d1_window.push_back(d1);
        while self.d1_window.len() > D1_WINDOW {
            self.d1_window.pop_front();
        }
        // Software timestamps only ever add latency, so the minimum is the best estimate.
        let min_d1 = self.d1_window.iter().copied().min().unwrap_or(d1);
        let delay = self.delay_window.iter().copied().min().unwrap_or(0);
        self.shared.offset_ns.store(min_d1 - delay, Ordering::Relaxed);
        self.shared.last_sync_local_ns.store(t2, Ordering::Relaxed);
    }

    fn build_delay_req(&mut self) -> Option<(u16, [u8; 44])> {
        self.master.as_ref()?;
        if self.shared.last_sync_local_ns.load(Ordering::Relaxed) == 0 {
            return None;
        }
        self.delay_seq = self.delay_seq.wrapping_add(1);
        let mut message = [0u8; 44];
        message[0] = 0x01; // Delay_Req
        message[1] = 0x02; // PTP version 2
        message[2..4].copy_from_slice(&44u16.to_be_bytes());
        message[4] = self.domain;
        message[20..30].copy_from_slice(&self.our_id);
        message[30..32].copy_from_slice(&self.delay_seq.to_be_bytes());
        message[32] = 0x01; // controlField: Delay_Req
        message[33] = 0x7F; // logMessageInterval
        Some((self.delay_seq, message))
    }
}

fn ptp_socket(port: u16, iface: Ipv4Addr) -> io::Result<UdpSocket> {
    let socket = new_udp_socket()?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    {
        let _ = socket.set_reuse_port(true);
    }
    socket.bind(&SockAddr::from(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)))?;
    socket.join_multicast_v4(&PTP_GROUP, &iface)?;
    if !iface.is_unspecified() {
        socket.set_multicast_if_v4(&iface)?;
    }
    socket.set_multicast_loop_v4(false)?;
    socket.set_multicast_ttl_v4(1)?;
    let udp: UdpSocket = socket.into();
    udp.set_read_timeout(Some(Duration::from_millis(100)))?;
    Ok(udp)
}

fn ptp_supervisor(shared: Arc<PtpShared>) {
    loop {
        let result = ptp_run(&shared);
        if let Err(error) = result {
            let text = format!("PTP: {error}");
            eprintln!("[aes67] {text}");
            if let Ok(mut slot) = shared.error.lock() {
                *slot = Some(text);
            }
        }
        thread::sleep(Duration::from_secs(3));
    }
}

fn ptp_run(shared: &Arc<PtpShared>) -> io::Result<()> {
    let iface = local_interface();
    let domain = config().ptp_domain;
    let event = ptp_socket(PTP_EVENT_PORT, iface)?;
    let general = ptp_socket(PTP_GENERAL_PORT, iface)?;
    if let Ok(mut slot) = shared.error.lock() {
        *slot = None;
    }
    let engine = Arc::new(Mutex::new(PtpEngine::new(Arc::clone(shared), domain)));
    let failed = Arc::new(AtomicBool::new(false));
    {
        let engine = Arc::clone(&engine);
        let failed = Arc::clone(&failed);
        thread::Builder::new()
            .name("aes67-ptp-general".to_string())
            .spawn(move || {
                if let Err(error) = ptp_general_loop(&engine, &general, &failed) {
                    eprintln!("[aes67] PTP general socket: {error}");
                }
                failed.store(true, Ordering::Relaxed);
            })?;
    }
    let result = ptp_event_loop(&engine, &event, &failed);
    failed.store(true, Ordering::Relaxed);
    result
}

fn ptp_general_loop(
    engine: &Arc<Mutex<PtpEngine>>,
    socket: &UdpSocket,
    failed: &AtomicBool,
) -> io::Result<()> {
    let mut buffer = [0u8; 512];
    loop {
        if failed.load(Ordering::Relaxed) {
            return Ok(());
        }
        match socket.recv_from(&mut buffer) {
            Ok((length, _)) => {
                let now = local_now_ns();
                if length < 34 {
                    continue;
                }
                let message = &buffer[..length];
                if let Ok(mut engine) = engine.lock() {
                    match message[0] & 0x0F {
                        11 => engine.on_announce(message, now),
                        8 => engine.on_follow_up(message),
                        9 => engine.on_delay_resp(message),
                        _ => {}
                    }
                }
            }
            Err(error) if is_timeout(&error) => {}
            Err(error) => return Err(error),
        }
    }
}

fn ptp_event_loop(
    engine: &Arc<Mutex<PtpEngine>>,
    socket: &UdpSocket,
    failed: &AtomicBool,
) -> io::Result<()> {
    let mut buffer = [0u8; 512];
    let mut last_request = Instant::now();
    loop {
        if failed.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "PTP general socket stopped",
            ));
        }
        match socket.recv_from(&mut buffer) {
            Ok((length, _)) => {
                // Software receive timestamp: take it as early as possible.
                let t2 = local_now_ns();
                if length >= 34 && (buffer[0] & 0x0F) == 0 {
                    if let Ok(mut engine) = engine.lock() {
                        engine.on_sync(&buffer[..length], t2);
                    }
                }
            }
            Err(error) if is_timeout(&error) => {}
            Err(error) => return Err(error),
        }
        if last_request.elapsed() >= DELAY_REQ_INTERVAL {
            last_request = Instant::now();
            let request = engine.lock().ok().and_then(|mut engine| engine.build_delay_req());
            if let Some((sequence, message)) = request {
                if socket
                    .send_to(&message, SocketAddrV4::new(PTP_GROUP, PTP_EVENT_PORT))
                    .is_ok()
                {
                    let t3 = local_now_ns();
                    if let Ok(mut engine) = engine.lock() {
                        engine.pending_delay = Some((sequence, t3));
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ stream registry (SAP/SDP)

#[derive(Debug, Clone)]
struct StreamDesc {
    id: String,
    name: String,
    group: Ipv4Addr,
    port: u16,
    channels: u16,
    bits: u8,
    payload_type: u8,
    last_seen: Instant,
    manual: bool,
}

static SOURCES: OnceLock<Mutex<HashMap<String, StreamDesc>>> = OnceLock::new();

fn sources() -> &'static Mutex<HashMap<String, StreamDesc>> {
    SOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stream_id(group: Ipv4Addr, port: u16) -> String {
    format!(
        "{AES67_INPUT_PREFIX}{:016x}",
        stable_hash(&format!("{group}:{port}"))
    )
}

fn find_stream(device_id: &str) -> Option<StreamDesc> {
    sources()
        .lock()
        .ok()
        .and_then(|map| map.get(device_id.trim()).cloned())
}

fn prune_sources() {
    if let Ok(mut map) = sources().lock() {
        map.retain(|_, desc| desc.manual || desc.last_seen.elapsed() < SOURCE_TTL);
    }
}

fn refresh_manual_sources() {
    let manual = config().sources;
    let mut wanted = HashSet::new();
    let mut descs = Vec::new();
    for source in manual {
        let Ok(group) = source.multicast.trim().parse::<Ipv4Addr>() else {
            continue;
        };
        if !group.is_multicast() || source.channels == 0 || !(source.bits == 16 || source.bits == 24)
        {
            continue;
        }
        let id = stream_id(group, source.port);
        wanted.insert(id.clone());
        descs.push(StreamDesc {
            id,
            name: source.name.trim().to_string(),
            group,
            port: source.port,
            channels: source.channels,
            bits: source.bits,
            payload_type: source.payload_type,
            last_seen: Instant::now(),
            manual: true,
        });
    }
    if let Ok(mut map) = sources().lock() {
        map.retain(|id, desc| !desc.manual || wanted.contains(id));
        for desc in descs {
            map.insert(desc.id.clone(), desc);
        }
    }
}

fn parse_connection(value: &str) -> Option<Ipv4Addr> {
    // "IN IP4 239.69.1.1/32"
    let address = value.split_whitespace().nth(2)?;
    address.split('/').next()?.parse::<Ipv4Addr>().ok()
}

fn parse_sdp(text: &str) -> Option<StreamDesc> {
    let mut name = String::new();
    let mut session_group: Option<Ipv4Addr> = None;
    let mut media_group: Option<Ipv4Addr> = None;
    let mut port: Option<u16> = None;
    let mut payload_types: Vec<u8> = Vec::new();
    let mut in_audio = false;
    let mut rtpmaps: Vec<(u8, u8, u16)> = Vec::new(); // payload type, bits, channels

    for raw in text.lines() {
        let line = raw.trim();
        if let Some(value) = line.strip_prefix("s=") {
            name = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("c=") {
            if let Some(address) = parse_connection(value) {
                if in_audio {
                    media_group = Some(address);
                } else if port.is_none() {
                    session_group = Some(address);
                }
            }
        } else if let Some(value) = line.strip_prefix("m=") {
            in_audio = false;
            if port.is_none() {
                let mut parts = value.split_whitespace();
                if parts.next() == Some("audio") {
                    let parsed_port = parts
                        .next()
                        .and_then(|text| text.split('/').next())
                        .and_then(|text| text.parse::<u16>().ok());
                    if let (Some(parsed_port), Some("RTP/AVP")) = (parsed_port, parts.next()) {
                        port = Some(parsed_port);
                        payload_types = parts.filter_map(|pt| pt.parse::<u8>().ok()).collect();
                        in_audio = true;
                    }
                }
            }
        } else if in_audio {
            if let Some(value) = line.strip_prefix("a=rtpmap:") {
                if let Some((pt, rest)) = value.split_once(' ') {
                    let mut encoding = rest.trim().split('/');
                    let codec = encoding.next().unwrap_or("").to_ascii_uppercase();
                    let rate = encoding
                        .next()
                        .and_then(|text| text.parse::<u32>().ok())
                        .unwrap_or(0);
                    let channels = encoding
                        .next()
                        .and_then(|text| text.parse::<u16>().ok())
                        .unwrap_or(1);
                    let bits = match codec.as_str() {
                        "L24" => 24,
                        "L16" => 16,
                        _ => 0,
                    };
                    if let (Ok(pt), true) = (pt.trim().parse::<u8>(), bits != 0 && rate == 48_000) {
                        rtpmaps.push((pt, bits, channels));
                    }
                }
            }
        }
    }

    let port = port?;
    let group = media_group.or(session_group)?;
    if !group.is_multicast() {
        return None;
    }
    let (payload_type, bits, channels) = rtpmaps
        .into_iter()
        .find(|(pt, _, _)| payload_types.contains(pt))?;
    if channels == 0 || channels > 64 {
        return None;
    }
    if name.is_empty() {
        name = format!("AES67 {group}:{port}");
    }
    Some(StreamDesc {
        id: stream_id(group, port),
        name,
        group,
        port,
        channels,
        bits,
        payload_type,
        last_seen: Instant::now(),
        manual: false,
    })
}

/// Returns (is_deletion, sdp text).
fn parse_sap(packet: &[u8]) -> Option<(bool, String)> {
    if packet.len() < 8 || packet[0] >> 5 != 1 {
        return None;
    }
    let ipv6 = packet[0] & 0x10 != 0;
    let delete = packet[0] & 0x04 != 0;
    let encrypted = packet[0] & 0x02 != 0;
    let compressed = packet[0] & 0x01 != 0;
    if encrypted || compressed {
        return None;
    }
    let origin_length = if ipv6 { 16 } else { 4 };
    let start = 4 + origin_length + usize::from(packet[1]) * 4;
    if start >= packet.len() {
        return None;
    }
    let body = &packet[start..];
    let text = if body.starts_with(b"v=0") {
        body
    } else {
        let end = body.iter().position(|byte| *byte == 0)?;
        &body[end + 1..]
    };
    Some((delete, String::from_utf8_lossy(text).into_owned()))
}

fn handle_sap(packet: &[u8]) {
    let Some((delete, text)) = parse_sap(packet) else {
        return;
    };
    let Some(desc) = parse_sdp(&text) else {
        return;
    };
    if is_own_stream(desc.group, desc.port) {
        return;
    }
    let Ok(mut map) = sources().lock() else {
        return;
    };
    if delete {
        if map.get(&desc.id).map(|known| !known.manual).unwrap_or(false) {
            map.remove(&desc.id);
        }
        return;
    }
    match map.get_mut(&desc.id) {
        Some(known) if known.manual => {}
        Some(known) => *known = desc,
        None => {
            map.insert(desc.id.clone(), desc);
        }
    }
}

fn sap_listener_supervisor() {
    loop {
        if let Err(error) = sap_listen() {
            eprintln!("[aes67] SAP listener stopped: {error}");
        }
        thread::sleep(Duration::from_secs(5));
    }
}

fn sap_listen() -> io::Result<()> {
    let socket = multicast_receiver(SAP_GROUP, SAP_PORT, local_interface())?;
    let mut buffer = vec![0u8; 4096];
    loop {
        match socket.recv(&mut buffer) {
            Ok(length) => handle_sap(&buffer[..length]),
            Err(error) if is_timeout(&error) => {}
            Err(error) => return Err(error),
        }
        prune_sources();
    }
}

// ------------------------------------------------------------------ own streams + SAP announce

#[derive(Clone)]
struct OwnOutput {
    slot: usize,
    group: Ipv4Addr,
    port: u16,
    channels: usize,
    payload_type: u8,
    last_sent: Option<Instant>,
}

static OWN_OUTPUTS: OnceLock<Mutex<HashMap<usize, OwnOutput>>> = OnceLock::new();

fn own_outputs() -> &'static Mutex<HashMap<usize, OwnOutput>> {
    OWN_OUTPUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_own_stream(group: Ipv4Addr, port: u16) -> bool {
    own_outputs()
        .lock()
        .map(|map| {
            map.values()
                .any(|output| output.group == group && output.port == port)
        })
        .unwrap_or(false)
}

fn output_group(slot: usize) -> Ipv4Addr {
    if let Some(base) = config().output_base {
        let parts: Vec<u8> = base
            .trim()
            .split('.')
            .filter_map(|part| part.parse::<u8>().ok())
            .collect();
        if parts.len() >= 3 {
            let address = Ipv4Addr::new(parts[0], parts[1], parts[2], slot as u8);
            if address.is_multicast() {
                return address;
            }
        }
    }
    let third = (stable_hash(&hostname()) % 250) as u8 + 1;
    Ipv4Addr::new(239, 69, third, slot as u8)
}

fn output_stream_name(slot: usize) -> String {
    format!("LinkTalk Bridge {slot}")
}

fn build_sdp(output: &OwnOutput, iface: Ipv4Addr) -> String {
    let refclk = match ptp_shared().grandmaster.lock().ok().and_then(|gm| *gm) {
        Some(gm) if ptp_time_ns().is_some() => format!(
            "a=ts-refclk:ptp=IEEE1588-2008:{}:{}",
            fmt_clock_id(&gm),
            config().ptp_domain
        ),
        _ => "a=ts-refclk:ptp=traceable".to_string(),
    };
    let session = stable_hash(&format!("{}:{}", hostname(), output.slot));
    [
        "v=0".to_string(),
        format!("o=- {session} 1 IN IP4 {iface}"),
        format!("s={}", output_stream_name(output.slot)),
        format!("c=IN IP4 {}/32", output.group),
        "t=0 0".to_string(),
        format!("m=audio {} RTP/AVP {}", output.port, output.payload_type),
        format!(
            "a=rtpmap:{} L24/48000/{}",
            output.payload_type, output.channels
        ),
        "a=ptime:1".to_string(),
        refclk,
        "a=mediaclk:direct=0".to_string(),
        String::new(),
    ]
    .join("\r\n")
}

fn send_sap(sdp: &str, delete: bool, output: &OwnOutput) {
    let iface = local_interface();
    let Ok(socket) = new_udp_socket() else {
        return;
    };
    let _ = socket.set_multicast_ttl_v4(32);
    let _ = socket.set_multicast_loop_v4(false);
    if !iface.is_unspecified() {
        let _ = socket.set_multicast_if_v4(&iface);
    }
    let message_id = (stable_hash(&format!("{}:{}", output.group, output.port)) & 0xFFFF) as u16;
    let mut packet = Vec::with_capacity(32 + sdp.len());
    packet.push(if delete { 0x24 } else { 0x20 });
    packet.push(0);
    packet.extend_from_slice(&message_id.to_be_bytes());
    packet.extend_from_slice(&iface.octets());
    packet.extend_from_slice(b"application/sdp\0");
    packet.extend_from_slice(sdp.as_bytes());
    let _ = socket.send_to(
        &packet,
        &SockAddr::from(SocketAddrV4::new(SAP_GROUP, SAP_PORT)),
    );
}

fn sap_announcer() {
    loop {
        thread::sleep(Duration::from_secs(1));
        if !config().sap_announce {
            continue;
        }
        let due: Vec<OwnOutput> = match own_outputs().lock() {
            Ok(mut map) => map
                .values_mut()
                .filter(|output| {
                    output
                        .last_sent
                        .map(|sent| sent.elapsed() >= SAP_INTERVAL)
                        .unwrap_or(true)
                })
                .map(|output| {
                    output.last_sent = Some(Instant::now());
                    output.clone()
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        let iface = local_interface();
        for output in due {
            send_sap(&build_sdp(&output, iface), false, &output);
        }
    }
}

fn ensure_background() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let _ = ptp_shared();
        let _ = thread::Builder::new()
            .name("aes67-sap-rx".to_string())
            .spawn(sap_listener_supervisor);
        let _ = thread::Builder::new()
            .name("aes67-sap-tx".to_string())
            .spawn(sap_announcer);
    });
}

// ------------------------------------------------------------------ device list / status

pub fn is_input_device(device_id: &str) -> bool {
    device_id.trim().starts_with(AES67_INPUT_PREFIX)
}

pub fn is_output_device(device_id: &str) -> bool {
    device_id.trim().starts_with(AES67_OUTPUT_PREFIX)
}

fn output_slot(device_id: &str) -> Result<usize, String> {
    device_id
        .trim()
        .strip_prefix(AES67_OUTPUT_PREFIX)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|slot| (1..=AES67_OUTPUT_SLOTS).contains(slot))
        .ok_or_else(|| format!("invalid AES67 output device: {device_id}"))
}

fn channel_pairs(max_channels: u16) -> Vec<ChannelPair> {
    let mut pairs = (1..=max_channels)
        .map(|channel| ChannelPair {
            label: channel.to_string(),
            left_channel: channel,
            right_channel: channel,
        })
        .collect::<Vec<_>>();
    pairs.extend((0..max_channels / 2).map(|pair| {
        let left = pair * 2 + 1;
        ChannelPair {
            label: format!("{left}/{}", left + 1),
            left_channel: left,
            right_channel: left + 1,
        }
    }));
    pairs
}

fn virtual_device(
    id: String,
    name: String,
    direction: &str,
    max_channels: u16,
    bits: u8,
) -> AudioDeviceInfo {
    AudioDeviceInfo {
        id,
        name,
        direction: direction.to_string(),
        is_default: false,
        max_channels,
        supports_48k: true,
        supported_configs: vec![AudioConfigRange {
            channels: max_channels,
            min_sample_rate: 48_000,
            max_sample_rate: 48_000,
            sample_format: format!("L{bits} (AES67)"),
            min_buffer_size: None,
            max_buffer_size: None,
        }],
        channel_pairs: channel_pairs(max_channels),
    }
}

pub fn audio_devices(_wait: Duration) -> Vec<AudioDeviceInfo> {
    reload_config();
    ensure_background();
    refresh_manual_sources();
    prune_sources();
    let mut found: Vec<StreamDesc> = sources()
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default();
    found.sort_by(|a, b| a.name.cmp(&b.name).then(a.port.cmp(&b.port)));
    let mut devices = found
        .into_iter()
        .map(|desc| {
            virtual_device(
                desc.id.clone(),
                format!("AES67 network input · {} ({}ch)", desc.name, desc.channels),
                "input",
                desc.channels.min(64),
                desc.bits,
            )
        })
        .collect::<Vec<_>>();
    let channels = output_channels() as u16;
    devices.extend((1..=AES67_OUTPUT_SLOTS).map(|slot| {
        virtual_device(
            format!("{AES67_OUTPUT_PREFIX}{slot}"),
            format!("AES67 network output · LinkTalk Bridge {slot}"),
            "output",
            channels,
            24,
        )
    }));
    devices
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aes67Status {
    pub available: bool,
    pub ptp_synced: bool,
    pub grandmaster: Option<String>,
    pub ptp_offset_us: Option<i64>,
    pub interface: String,
    pub source_count: usize,
    pub source_names: Vec<String>,
    pub config_path: Option<String>,
    pub error: Option<String>,
}

pub fn status() -> Aes67Status {
    ensure_background();
    let shared = ptp_shared();
    let synced = ptp_time_ns().is_some();
    let grandmaster = if synced {
        shared
            .grandmaster
            .lock()
            .ok()
            .and_then(|gm| *gm)
            .map(|gm| fmt_clock_id(&gm))
    } else {
        None
    };
    let offset_us = if synced {
        Some(shared.offset_ns.load(Ordering::Relaxed) / 1_000)
    } else {
        None
    };
    let mut names: Vec<String> = sources()
        .lock()
        .map(|map| map.values().map(|desc| desc.name.clone()).collect())
        .unwrap_or_default();
    names.sort();
    let error = CONFIG_ERROR
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .or_else(|| shared.error.lock().ok().and_then(|slot| slot.clone()));
    Aes67Status {
        available: true,
        ptp_synced: synced,
        grandmaster,
        ptp_offset_us: offset_us,
        interface: local_interface().to_string(),
        source_count: names.len(),
        source_names: names,
        config_path: config_path().map(|path| path.display().to_string()),
        error,
    }
}

// ------------------------------------------------------------------ RTP helpers

/// Returns (payload type, sequence number, payload).
fn parse_rtp(packet: &[u8]) -> Option<(u8, u16, &[u8])> {
    if packet.len() < 12 || packet[0] >> 6 != 2 {
        return None;
    }
    let csrc = usize::from(packet[0] & 0x0F);
    let mut start = 12 + csrc * 4;
    if packet[0] & 0x10 != 0 {
        if packet.len() < start + 4 {
            return None;
        }
        let words = usize::from(u16::from_be_bytes([packet[start + 2], packet[start + 3]]));
        start += 4 + words * 4;
    }
    let mut end = packet.len();
    if packet[0] & 0x20 != 0 {
        let padding = usize::from(*packet.last()?);
        if padding == 0 || padding > end {
            return None;
        }
        end -= padding;
    }
    if start > end {
        return None;
    }
    Some((
        packet[1] & 0x7F,
        u16::from_be_bytes([packet[2], packet[3]]),
        &packet[start..end],
    ))
}

fn read_sample(bytes: &[u8], bits: u8) -> f32 {
    if bits == 16 {
        f32::from(i16::from_be_bytes([bytes[0], bytes[1]])) / 32_768.0
    } else {
        let value =
            (((bytes[0] as i32) << 24) | ((bytes[1] as i32) << 16) | ((bytes[2] as i32) << 8)) >> 8;
        value as f32 / 8_388_608.0
    }
}

fn write_l24(value: f32, out: &mut [u8]) {
    let scaled = (value.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
    out[0] = (scaled >> 16) as u8;
    out[1] = (scaled >> 8) as u8;
    out[2] = scaled as u8;
}

// ------------------------------------------------------------------ input (AES67 -> LinkTalk)

pub struct Aes67InputRuntime {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Aes67InputRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        device_id: String,
        left_channel: u16,
        right_channel: u16,
        sender: SyncSender<Vec<u8>>,
        last_error: Arc<Mutex<Option<String>>>,
        level_milli_db: Arc<AtomicI32>,
        captured_frames: Arc<AtomicU64>,
        dropped_chunks: Arc<AtomicU64>,
        dropped_frames: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        if left_channel == 0 || right_channel == 0 {
            return Err("AES67 channel numbers start at 1".to_string());
        }
        ensure_background();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = thread::Builder::new()
            .name("aes67-input".to_string())
            .spawn(move || {
                let result = run_input(
                    &device_id,
                    left_channel,
                    right_channel,
                    sender,
                    Arc::clone(&last_error),
                    level_milli_db,
                    captured_frames,
                    dropped_chunks,
                    dropped_frames,
                    thread_stop,
                );
                if let Err(error) = result {
                    if let Ok(mut current) = last_error.lock() {
                        *current = Some(error);
                    }
                }
            })
            .map_err(|error| format!("could not start AES67 receiver: {error}"))?;
        Ok(Self {
            stop,
            thread: Some(handle),
        })
    }
}

impl Drop for Aes67InputRuntime {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn set_error(last_error: &Arc<Mutex<Option<String>>>, text: Option<String>) {
    if let Ok(mut current) = last_error.lock() {
        *current = text;
    }
}

#[allow(clippy::too_many_arguments)]
fn run_input(
    device_id: &str,
    left_channel: u16,
    right_channel: u16,
    sender: SyncSender<Vec<u8>>,
    last_error: Arc<Mutex<Option<String>>>,
    level_milli_db: Arc<AtomicI32>,
    captured_frames: Arc<AtomicU64>,
    dropped_chunks: Arc<AtomicU64>,
    dropped_frames: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    // The source may not have been announced yet (SAP repeats every ~30 s): wait for it.
    let desc = loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(desc) = find_stream(device_id) {
            break desc;
        }
        set_error(
            &last_error,
            Some("Waiting for the SAP announcement of this AES67 source…".to_string()),
        );
        thread::sleep(Duration::from_millis(500));
    };
    let channels = usize::from(desc.channels);
    let left_index = usize::from(left_channel - 1);
    let right_index = usize::from(right_channel - 1);
    if left_index >= channels || right_index >= channels {
        return Err(format!(
            "AES67 source \"{}\" has {channels} channel(s), selected channel is unavailable",
            desc.name
        ));
    }
    let bytes_per_sample = if desc.bits == 16 { 2 } else { 3 };
    let frame_bytes = channels * bytes_per_sample;
    let socket = multicast_receiver(desc.group, desc.port, local_interface())
        .map_err(|error| format!("AES67 receive {}:{}: {error}", desc.group, desc.port))?;
    set_error(
        &last_error,
        Some(format!(
            "No AES67 packets yet from {}:{}",
            desc.group, desc.port
        )),
    );

    let chunk_bytes = INPUT_CHUNK_FRAMES * 8;
    let mut chunk: Vec<u8> = Vec::with_capacity(chunk_bytes * 2);
    let mut buffer = vec![0u8; 4096];
    let mut expected: Option<u16> = None;
    let mut last_frames_per_packet = FRAMES_PER_PACKET;
    let mut last_packet = Instant::now();
    let mut chunk_squares = 0.0_f64;
    let mut chunk_samples = 0_usize;

    while !stop.load(Ordering::SeqCst) {
        let length = match socket.recv(&mut buffer) {
            Ok(length) => length,
            Err(error) if is_timeout(&error) => {
                if last_packet.elapsed() > Duration::from_secs(2) {
                    level_milli_db.store(-120_000, Ordering::Relaxed);
                    set_error(
                        &last_error,
                        Some(format!(
                            "No AES67 packets from {}:{} (check interface, IGMP, firewall)",
                            desc.group, desc.port
                        )),
                    );
                }
                continue;
            }
            Err(error) => {
                set_error(&last_error, Some(format!("AES67 receive error: {error}")));
                thread::sleep(Duration::from_millis(500));
                continue;
            }
        };
        let Some((payload_type, sequence, payload)) = parse_rtp(&buffer[..length]) else {
            continue;
        };
        if payload_type != desc.payload_type || payload.len() < frame_bytes {
            continue;
        }
        let frames = payload.len() / frame_bytes;

        if let Some(next) = expected {
            let lost = sequence.wrapping_sub(next);
            if lost >= 0x8000 {
                continue; // duplicate or late packet
            }
            if lost > 0 && lost < 50 {
                // keep timing: fill the gap with silence
                chunk.resize(chunk.len() + usize::from(lost) * last_frames_per_packet * 8, 0);
            }
        }
        expected = Some(sequence.wrapping_add(1));
        last_frames_per_packet = frames;
        last_packet = Instant::now();
        set_error(&last_error, None);

        for frame in payload.chunks_exact(frame_bytes).take(frames) {
            let left = read_sample(&frame[left_index * bytes_per_sample..], desc.bits);
            let right = read_sample(&frame[right_index * bytes_per_sample..], desc.bits);
            chunk_squares += f64::from(left * left + right * right);
            chunk_samples += 2;
            chunk.extend_from_slice(&left.to_le_bytes());
            chunk.extend_from_slice(&right.to_le_bytes());
        }
        captured_frames.fetch_add(frames as u64, Ordering::Relaxed);

        while chunk.len() >= chunk_bytes {
            let out: Vec<u8> = chunk.drain(..chunk_bytes).collect();
            level_milli_db.store(rms_milli_db(chunk_squares, chunk_samples), Ordering::Relaxed);
            chunk_squares = 0.0;
            chunk_samples = 0;
            if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) = sender.try_send(out)
            {
                dropped_chunks.fetch_add(1, Ordering::Relaxed);
                dropped_frames.fetch_add(INPUT_CHUNK_FRAMES as u64, Ordering::Relaxed);
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ output (LinkTalk -> AES67)

pub struct Aes67OutputRuntime {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Aes67OutputRuntime {
    pub fn start(
        device_id: String,
        sources: Arc<Mutex<HashMap<String, BridgeOutputMixerSource>>>,
        last_error: Arc<Mutex<Option<String>>>,
    ) -> Result<Self, String> {
        let slot = output_slot(&device_id)?;
        ensure_background();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (startup_tx, startup_rx) = sync_channel(1);
        let startup_error_tx = startup_tx.clone();
        let handle = thread::Builder::new()
            .name(format!("aes67-output-{slot}"))
            .spawn(move || {
                let result = run_output(slot, sources, Arc::clone(&last_error), thread_stop, startup_tx);
                if let Err(error) = result {
                    let _ = startup_error_tx.try_send(Err(error.clone()));
                    set_error(&last_error, Some(error));
                }
            })
            .map_err(|error| format!("could not start AES67 sender: {error}"))?;
        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(handle),
            }),
            Ok(Err(error)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = handle.join();
                Err("AES67 sender startup timed out".to_string())
            }
        }
    }
}

impl Drop for Aes67OutputRuntime {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

struct OutputRegistration {
    output: OwnOutput,
}

impl Drop for OutputRegistration {
    fn drop(&mut self) {
        if let Ok(mut map) = own_outputs().lock() {
            map.remove(&self.output.slot);
        }
        let sdp = build_sdp(&self.output, local_interface());
        send_sap(&sdp, true, &self.output);
    }
}

fn mix_packet(
    sources: &Arc<Mutex<HashMap<String, BridgeOutputMixerSource>>>,
    channels: usize,
    out: &mut [u8],
) {
    let active: Vec<BridgeOutputMixerSource> = sources
        .lock()
        .map(|sources| sources.values().cloned().collect())
        .unwrap_or_default();
    for frame in 0..FRAMES_PER_PACKET {
        let mut mixed = [0.0_f32; MAX_CHANNELS];
        for source in &active {
            let level = source
                .level
                .lock()
                .map(|level| *level)
                .unwrap_or(BridgeOutputLevel {
                    volume: 1.0,
                    muted: false,
                });
            if level.muted || level.volume <= 0.0 {
                continue;
            }
            let sample = source.queue.lock().ok().and_then(|mut queue| queue.pop_front());
            let Some(value) = sample else {
                continue;
            };
            let left_index = usize::from(source.left_channel.saturating_sub(1));
            let right_index = usize::from(source.right_channel.saturating_sub(1));
            if left_index == right_index {
                if left_index < channels {
                    mixed[left_index] += ((value.left + value.right) * 0.5) * level.volume;
                }
            } else {
                if left_index < channels {
                    mixed[left_index] += value.left * level.volume;
                }
                if right_index < channels {
                    mixed[right_index] += value.right * level.volume;
                }
            }
        }
        for channel in 0..channels {
            let offset = (frame * channels + channel) * 3;
            write_l24(mixed[channel], &mut out[offset..offset + 3]);
        }
    }
}

fn run_output(
    slot: usize,
    sources: Arc<Mutex<HashMap<String, BridgeOutputMixerSource>>>,
    last_error: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
    startup: SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let fail = |text: String| -> Result<(), String> {
        let _ = startup.send(Err(text.clone()));
        Err(text)
    };
    let config = config();
    let channels = usize::from(config.output_channels).clamp(1, MAX_CHANNELS);
    let iface = local_interface();
    let group = output_group(slot);
    let port = DEFAULT_RTP_PORT;
    let payload_type = config.payload_type & 0x7F;

    let socket = match new_udp_socket() {
        Ok(socket) => socket,
        Err(error) => return fail(format!("AES67 sender socket: {error}")),
    };
    if let Err(error) = socket.bind(&SockAddr::from(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))) {
        return fail(format!("AES67 sender bind: {error}"));
    }
    let _ = socket.set_multicast_ttl_v4(32);
    let _ = socket.set_multicast_loop_v4(false);
    if !iface.is_unspecified() {
        if let Err(error) = socket.set_multicast_if_v4(&iface) {
            return fail(format!("AES67 sender interface {iface}: {error}"));
        }
    }
    let target = SockAddr::from(SocketAddrV4::new(group, port));

    let output = OwnOutput {
        slot,
        group,
        port,
        channels,
        payload_type,
        last_sent: None,
    };
    if let Ok(mut map) = own_outputs().lock() {
        map.insert(slot, output.clone());
    }
    let _registration = OutputRegistration { output };
    eprintln!(
        "[aes67] sender slot {slot}: {group}:{port}, {channels} ch, interface {iface}"
    );
    let _ = startup.send(Ok(()));

    let hash = stable_hash(&format!("{}:{}", hostname(), slot));
    let ssrc = (hash & 0xFFFF_FFFF) as u32;
    let mut sequence = (hash >> 32) as u16;
    let mut packet = vec![0u8; 12 + channels * 3 * FRAMES_PER_PACKET];
    packet[0] = 0x80;
    packet[1] = payload_type;
    packet[8..12].copy_from_slice(&ssrc.to_be_bytes());

    let mut next_ms: Option<i64> = None;
    let mut unsynced_since: Option<Instant> = Some(Instant::now());
    let mut warned = false;

    while !stop.load(Ordering::SeqCst) {
        let ptp = ptp_time_ns();
        match (ptp, unsynced_since) {
            (Some(_), _) => {
                unsynced_since = None;
                if warned {
                    set_error(&last_error, None);
                    warned = false;
                }
            }
            (None, None) => unsynced_since = Some(Instant::now()),
            (None, Some(since)) => {
                if since.elapsed() > Duration::from_secs(10) && !warned {
                    warned = true;
                    set_error(
                        &last_error,
                        Some(
                            "AES67: no PTP master found, sending with free-running timestamps"
                                .to_string(),
                        ),
                    );
                }
            }
        }
        let now = ptp.unwrap_or_else(local_now_ns);
        let ready_ms = now.div_euclid(1_000_000) - 1; // last completed millisecond
        let mut current = match next_ms {
            Some(value) if (ready_ms - value).abs() <= 8 => value,
            _ => ready_ms, // first packet, fell behind, or the clock stepped
        };
        if current > ready_ms {
            let wait_ns = (current + 1) * 1_000_000 - now;
            thread::sleep(Duration::from_nanos(wait_ns.clamp(50_000, 2_000_000) as u64));
            next_ms = Some(current);
            continue;
        }
        // send every packet that is due (normally exactly one)
        while current <= ready_ms && !stop.load(Ordering::SeqCst) {
            let timestamp = ((current * FRAMES_PER_PACKET as i64) as u64 & 0xFFFF_FFFF) as u32;
            packet[2..4].copy_from_slice(&sequence.to_be_bytes());
            packet[4..8].copy_from_slice(&timestamp.to_be_bytes());
            mix_packet(&sources, channels, &mut packet[12..]);
            if let Err(error) = socket.send_to(&packet, &target) {
                set_error(&last_error, Some(format!("AES67 send error: {error}")));
                thread::sleep(Duration::from_millis(100));
            }
            sequence = sequence.wrapping_add(1);
            current += 1;
        }
        next_ms = Some(current);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SDP: &str = "v=0\r\no=- 1 1 IN IP4 192.168.1.20\r\ns=Console Out\r\nc=IN IP4 239.69.20.1/32\r\nt=0 0\r\nm=audio 5004 RTP/AVP 97\r\na=rtpmap:97 L24/48000/8\r\na=ptime:1\r\n";

    #[test]
    fn parses_sdp() {
        let desc = parse_sdp(SDP).expect("sdp");
        assert_eq!(desc.name, "Console Out");
        assert_eq!(desc.group, Ipv4Addr::new(239, 69, 20, 1));
        assert_eq!(desc.port, 5004);
        assert_eq!(desc.channels, 8);
        assert_eq!(desc.bits, 24);
        assert_eq!(desc.payload_type, 97);
    }

    #[test]
    fn rejects_unsupported_sdp() {
        let sdp = SDP.replace("L24/48000/8", "L24/96000/8");
        assert!(parse_sdp(&sdp).is_none());
        let unicast = SDP.replace("239.69.20.1", "192.168.1.5");
        assert!(parse_sdp(&unicast).is_none());
    }

    #[test]
    fn parses_sap_with_and_without_payload_type() {
        let mut with_type = vec![0x20, 0, 0x12, 0x34, 192, 168, 1, 20];
        with_type.extend_from_slice(b"application/sdp\0");
        with_type.extend_from_slice(SDP.as_bytes());
        let (delete, text) = parse_sap(&with_type).expect("sap");
        assert!(!delete);
        assert!(text.starts_with("v=0"));

        let mut bare = vec![0x24, 0, 0x12, 0x34, 192, 168, 1, 20];
        bare.extend_from_slice(SDP.as_bytes());
        let (delete, text) = parse_sap(&bare).expect("sap");
        assert!(delete);
        assert!(text.starts_with("v=0"));
    }

    #[test]
    fn l24_round_trip() {
        let mut bytes = [0u8; 3];
        for value in [-1.0_f32, -0.5, 0.0, 0.25, 0.999] {
            write_l24(value, &mut bytes);
            let back = read_sample(&bytes, 24);
            assert!((back - value).abs() < 1e-6, "{value} -> {back}");
        }
    }

    #[test]
    fn parses_rtp_header() {
        let mut packet = vec![0x80, 97, 0x00, 0x2A, 0, 0, 0, 1, 0, 0, 0, 2];
        packet.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
        let (pt, sequence, payload) = parse_rtp(&packet).expect("rtp");
        assert_eq!(pt, 97);
        assert_eq!(sequence, 42);
        assert_eq!(payload.len(), 6);
        assert!(parse_rtp(&packet[..8]).is_none());
    }

    #[test]
    fn ptp_timestamp_and_correction() {
        let bytes = [0, 0, 0, 0, 0, 2, 0, 0, 0, 5];
        assert_eq!(read_timestamp(&bytes), 2_000_000_005);
        let mut message = [0u8; 34];
        message[8..16].copy_from_slice(&((3_i64) << 16).to_be_bytes());
        assert_eq!(read_correction(&message), 3);
    }

    #[test]
    fn output_slots_are_validated() {
        assert_eq!(output_slot("aes67:send:3"), Ok(3));
        assert!(output_slot("aes67:send:0").is_err());
        assert!(output_slot("aes67:send:9").is_err());
        assert!(is_input_device("aes67:recv:0123456789abcdef"));
        assert!(!is_input_device("omt:recv:1"));
    }
}
