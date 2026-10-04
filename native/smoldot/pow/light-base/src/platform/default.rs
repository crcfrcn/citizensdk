// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

#![cfg(feature = "std")]

//! Implementation of the [`PlatformRef`] trait that leverages the operating system.
//!
//! This module contains the [`DefaultPlatform`] struct, which implements [`PlatformRef`].
//!
//! The [`DefaultPlatform`] delegates the logging to the `log` crate. In order to see log
//! messages, you should register as "logger" as documented by the `log` crate.
//! See <https://docs.rs/log>.
//!
//! # Example
//!
//! ```rust
//! use smoldot_light::{Client, platform::DefaultPlatform};
//! env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
//! let client = Client::new(DefaultPlatform::new(env!("CARGO_PKG_NAME").into(), env!("CARGO_PKG_VERSION").into()));
//! # let _: Client<_, ()> = client;  // Used in this example to infer the generic parameters of the Client
//! ```
//!

use super::{
    Address, ConnectionType, IpAddr, LogLevel, MultiStreamAddress, MultiStreamWebRtcConnection,
    PlatformRef, SubstreamDirection, with_buffers,
};

use alloc::{borrow::Cow, sync::Arc};
use core::{
    fmt::{self, Write as _},
    panic,
    pin::Pin,
    str,
    time::Duration,
};
use futures_util::{FutureExt as _, future};
use smoldot::libp2p::websocket;
use std::{
    io,
    net::SocketAddr,
    thread,
    time::{Instant, UNIX_EPOCH},
};

/// Implementation of the [`PlatformRef`] trait that leverages the operating system.
pub struct DefaultPlatform {
    client_name: String,
    client_version: String,
    tasks_executor: Arc<smol::Executor<'static>>,
    shutdown_notify: event_listener::Event,
}

impl DefaultPlatform {
    /// Creates a new [`DefaultPlatform`].
    ///
    /// This function spawns threads in order to execute the background tasks that will later be
    /// spawned.
    ///
    /// Must be passed as "client name" and "client version" that are used in various places
    /// such as to answer some JSON-RPC requests. Passing `env!("CARGO_PKG_NAME")` and
    /// `env!("CARGO_PKG_VERSION")` is typically very reasonable.
    ///
    /// # Panic
    ///
    /// Panics if it wasn't possible to spawn background threads.
    ///
    pub fn new(client_name: String, client_version: String) -> Arc<Self> {
        let tasks_executor = Arc::new(smol::Executor::new());
        let shutdown_notify = event_listener::Event::new();

        for n in 0..thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
        {
            // Note that `listen()` must be called here (and not in the thread being spawned), as
            // it might be notified as soon as `DefaultPlatform::new` returns.
            let on_shutdown = shutdown_notify.listen();
            let tasks_executor = tasks_executor.clone();

            let spawn_result = thread::Builder::new()
                .name(format!("smoldot-light-{}", n))
                .spawn(move || smol::block_on(tasks_executor.run(on_shutdown)));

            if let Err(err) = spawn_result {
                panic!("Failed to spawn execution thread: {err}");
            }
        }

        Arc::new(DefaultPlatform {
            client_name,
            client_version,
            tasks_executor,
            shutdown_notify,
        })
    }
}

impl PlatformRef for Arc<DefaultPlatform> {
    type Delay = futures_util::future::Map<smol::Timer, fn(Instant) -> ()>;
    type Instant = Instant;
    // 关联类型位置的 `!` 尚未稳定，使用同义的不可构造类型。
    type MultiStream = std::convert::Infallible;
    type Stream = Stream;
    type StreamConnectFuture = future::Ready<Self::Stream>;
    type MultiStreamConnectFuture = future::Pending<MultiStreamWebRtcConnection<Self::MultiStream>>;
    type ReadWriteAccess<'a> = with_buffers::ReadWriteAccess<'a, Instant>;
    type StreamUpdateFuture<'a> = future::BoxFuture<'a, ()>;
    type StreamErrorRef<'a> = &'a io::Error;
    type NextSubstreamFuture<'a> = future::Pending<Option<(Self::Stream, SubstreamDirection)>>;

    fn now_from_unix_epoch(&self) -> Duration {
        // Intentionally panic if the time is configured earlier than the UNIX EPOCH.
        UNIX_EPOCH.elapsed().unwrap()
    }

    fn now(&self) -> Self::Instant {
        Instant::now()
    }

    fn fill_random_bytes(&self, buffer: &mut [u8]) {
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), buffer);
    }

    fn sleep(&self, duration: Duration) -> Self::Delay {
        smol::Timer::after(duration).map(|_| ())
    }

    fn sleep_until(&self, when: Self::Instant) -> Self::Delay {
        smol::Timer::at(when).map(|_| ())
    }

    fn spawn_task(&self, _task_name: Cow<str>, task: impl Future<Output = ()> + Send + 'static) {
        // In order to make sure that the execution threads don't stop if there are still
        // tasks to execute, we hold a copy of the `Arc<DefaultPlatform>` inside of the task until
        // it is finished.
        let _dummy_keep_alive = self.clone();
        self.tasks_executor
            .spawn(
                panic::AssertUnwindSafe(async move {
                    task.await;
                    drop(_dummy_keep_alive);
                })
                .catch_unwind(),
            )
            .detach();
    }

    fn log<'a>(
        &self,
        log_level: LogLevel,
        log_target: &'a str,
        message: &'a str,
        key_values: impl Iterator<Item = (&'a str, &'a dyn fmt::Display)>,
    ) {
        // Note that this conversion is most likely completely optimized out by the compiler due
        // to log levels having the same numerical values.
        let log_level = match log_level {
            LogLevel::Error => log::Level::Error,
            LogLevel::Warn => log::Level::Warn,
            LogLevel::Info => log::Level::Info,
            LogLevel::Debug => log::Level::Debug,
            LogLevel::Trace => log::Level::Trace,
        };

        let mut message_build = String::with_capacity(128);
        message_build.push_str(message);
        let mut first = true;
        for (key, value) in key_values {
            if first {
                let _ = write!(message_build, "; ");
                first = false;
            } else {
                let _ = write!(message_build, ", ");
            }
            let _ = write!(message_build, "{}={}", key, value);
        }

        log::logger().log(
            &log::RecordBuilder::new()
                .level(log_level)
                .target(log_target)
                .args(format_args!("{}", message_build))
                .build(),
        )
    }

    fn client_name(&'_ self) -> Cow<'_, str> {
        Cow::Borrowed(&self.client_name)
    }

    fn client_version(&'_ self) -> Cow<'_, str> {
        Cow::Borrowed(&self.client_version)
    }

    fn supports_connection_type(&self, connection_type: ConnectionType) -> bool {
        // 支持所有 TCP 和 WebSocket（含 WSS）连接类型。
        matches!(
            connection_type,
            ConnectionType::TcpIpv4
                | ConnectionType::TcpIpv6
                | ConnectionType::TcpDns
                | ConnectionType::WebSocketIpv4 { .. }
                | ConnectionType::WebSocketIpv6 { .. }
                | ConnectionType::WebSocketDns { .. }
        )
    }

    fn connect_stream(&self, multiaddr: Address) -> Self::StreamConnectFuture {
        // 连接模式：TCP 直连 / WS（WebSocket 明文）/ WSS（WebSocket Secure）。
        enum ConnMode {
            Tcp,
            Ws(String),          // host:port
            Wss(String, String), // host:port, hostname（TLS SNI 用）
        }

        let (tcp_socket_addr, mode): (either::Either<SocketAddr, (String, u16)>, ConnMode) =
            match multiaddr {
                Address::TcpDns { hostname, port } => {
                    (either::Right((hostname.to_string(), port)), ConnMode::Tcp)
                }
                Address::TcpIp {
                    ip: IpAddr::V4(ip),
                    port,
                } => (either::Left(SocketAddr::from((ip, port))), ConnMode::Tcp),
                Address::TcpIp {
                    ip: IpAddr::V6(ip),
                    port,
                } => (either::Left(SocketAddr::from((ip, port))), ConnMode::Tcp),
                Address::WebSocketDns {
                    hostname,
                    port,
                    secure: false,
                } => (
                    either::Right((hostname.to_string(), port)),
                    ConnMode::Ws(format!("{}:{}", hostname, port)),
                ),
                Address::WebSocketDns {
                    hostname,
                    port,
                    secure: true,
                } => (
                    either::Right((hostname.to_string(), port)),
                    ConnMode::Wss(format!("{}:{}", hostname, port), hostname.to_string()),
                ),
                Address::WebSocketIp {
                    ip: IpAddr::V4(ip),
                    port,
                } => {
                    let addr = SocketAddr::from((ip, port));
                    (either::Left(addr), ConnMode::Ws(addr.to_string()))
                }
                Address::WebSocketIp {
                    ip: IpAddr::V6(ip),
                    port,
                } => {
                    let addr = SocketAddr::from((ip, port));
                    (either::Left(addr), ConnMode::Ws(addr.to_string()))
                }
            };

        let socket_future = async move {
            let tcp_socket = match tcp_socket_addr {
                either::Left(socket_addr) => smol::net::TcpStream::connect(socket_addr).await,
                either::Right((dns, port)) => smol::net::TcpStream::connect((&dns[..], port)).await,
            };

            if let Ok(tcp_socket) = &tcp_socket {
                let _ = tcp_socket.set_nodelay(true);
            }

            match (tcp_socket, mode) {
                (Ok(tcp_socket), ConnMode::Tcp) => Ok(TcpOrWs::Left(tcp_socket)),

                (Ok(tcp_socket), ConnMode::Ws(host)) => {
                    websocket::websocket_client_handshake(websocket::Config {
                        tcp_socket,
                        host: &host,
                        url: "/",
                    })
                    .await
                    .map(TcpOrWs::Right)
                }

                (Ok(tcp_socket), ConnMode::Wss(host, hostname)) => {
                    // WSS：TCP → TLS → WebSocket。
                    let connector = tls_connector()?;
                    let server_name = tls_server_name(hostname)?;
                    let tls_stream = connector
                        .connect(server_name, tcp_socket)
                        .await
                        .map_err(|e| io::Error::new(io::ErrorKind::ConnectionRefused, e))?;
                    websocket::websocket_client_handshake(websocket::Config {
                        tcp_socket: tls_stream,
                        host: &host,
                        url: "/",
                    })
                    .await
                    .map(TcpOrWs::Wss)
                }

                (Err(err), _) => Err(err),
            }
        };

        future::ready(Stream(with_buffers::WithBuffers::new(Box::pin(
            socket_future,
        ))))
    }

    fn connect_multistream(&self, _address: MultiStreamAddress) -> Self::MultiStreamConnectFuture {
        panic!()
    }

    fn open_out_substream(&self, c: &mut Self::MultiStream) {
        // This function can only be called with so-called "multi-stream" connections. We never
        // open such connection.
        match *c {}
    }

    fn next_substream(&self, c: &mut Self::MultiStream) -> Self::NextSubstreamFuture<'_> {
        // This function can only be called with so-called "multi-stream" connections. We never
        // open such connection.
        match *c {}
    }

    fn read_write_access<'a>(
        &self,
        stream: Pin<&'a mut Self::Stream>,
    ) -> Result<Self::ReadWriteAccess<'a>, &'a io::Error> {
        let stream = stream.project();
        stream.0.read_write_access(Instant::now())
    }

    fn wait_read_write_again<'a>(
        &self,
        stream: Pin<&'a mut Self::Stream>,
    ) -> Self::StreamUpdateFuture<'a> {
        let stream = stream.project();
        Box::pin(stream.0.wait_read_write_again(|when| async move {
            smol::Timer::at(when).await;
        }))
    }
}

impl Drop for DefaultPlatform {
    fn drop(&mut self) {
        self.shutdown_notify.notify(usize::MAX);
    }
}

/// Implementation detail of [`DefaultPlatform`].
#[pin_project::pin_project]
pub struct Stream(
    #[pin]
    with_buffers::WithBuffers<
        future::BoxFuture<'static, Result<TcpOrWs, io::Error>>,
        TcpOrWs,
        Instant,
    >,
);

/// P2P 连接流类型：纯 TCP / WS（WebSocket 明文）/ WSS（WebSocket Secure）。
enum TcpOrWs {
    /// 纯 TCP 连接。
    Left(smol::net::TcpStream),
    /// WS（WebSocket 明文）连接。
    Right(websocket::Connection<smol::net::TcpStream>),
    /// WSS（WebSocket Secure）连接：TCP → TLS → WebSocket。
    Wss(websocket::Connection<futures_rustls::client::TlsStream<smol::net::TcpStream>>),
}

impl futures_util::AsyncRead for TcpOrWs {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
        buf: &mut [u8],
    ) -> core::task::Poll<io::Result<usize>> {
        // SAFETY: 内部类型都是 Unpin 的。
        match self.get_mut() {
            TcpOrWs::Left(s) => Pin::new(s).poll_read(cx, buf),
            TcpOrWs::Right(s) => Pin::new(s).poll_read(cx, buf),
            TcpOrWs::Wss(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl futures_util::AsyncWrite for TcpOrWs {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
        buf: &[u8],
    ) -> core::task::Poll<io::Result<usize>> {
        match self.get_mut() {
            TcpOrWs::Left(s) => Pin::new(s).poll_write(cx, buf),
            TcpOrWs::Right(s) => Pin::new(s).poll_write(cx, buf),
            TcpOrWs::Wss(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
    ) -> core::task::Poll<io::Result<()>> {
        match self.get_mut() {
            TcpOrWs::Left(s) => Pin::new(s).poll_flush(cx),
            TcpOrWs::Right(s) => Pin::new(s).poll_flush(cx),
            TcpOrWs::Wss(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_close(
        self: Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
    ) -> core::task::Poll<io::Result<()>> {
        match self.get_mut() {
            TcpOrWs::Left(s) => Pin::new(s).poll_close(cx),
            TcpOrWs::Right(s) => Pin::new(s).poll_close(cx),
            TcpOrWs::Wss(s) => Pin::new(s).poll_close(cx),
        }
    }
}

/// 构造 WSS 唯一 TLS 客户端配置：TLS 验证握手签名，Noise 验证固定 peer ID。
fn tls_connector() -> io::Result<futures_rustls::TlsConnector> {
    // CitizenChain 节点使用持久化自签 WSS 证书，信任真源是 multiaddr 固定的 libp2p peer ID。
    // TLS 仍必须验证 CertificateVerify 签名，禁止恢复旧实现的无条件签名放行。
    let provider = rustls::crypto::ring::default_provider();
    let verifier = NoiseAuthenticatedCertVerifier {
        supported: provider.signature_verification_algorithms,
    };
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    // WSS 使用 HTTP/1.1 Upgrade，不协商其它 ALPN 协议。
    config.alpn_protocols.clear();
    Ok(futures_rustls::TlsConnector::from(Arc::new(config)))
}

/// 接受持久化自签证书本身，但使用 rustls provider 校验 TLS 1.2/1.3 握手签名。
#[derive(Debug)]
struct NoiseAuthenticatedCertVerifier {
    supported: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for NoiseAuthenticatedCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, signature, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, signature, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.supported.supported_schemes()
    }
}

/// 将拥有所有权的主机名转换为贯穿异步握手生命周期的 SNI 名称。
fn tls_server_name(hostname: String) -> io::Result<rustls::pki_types::ServerName<'static>> {
    rustls::pki_types::ServerName::try_from(hostname)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
}

#[cfg(test)]
mod tests {
    use super::{DefaultPlatform, PlatformRef as _, tls_connector, tls_server_name};
    use smoldot::libp2p::websocket;

    #[test]
    fn tasks_run_indefinitely() {
        let platform_destroyed = event_listener::Event::new();
        let (tx, mut rx) = futures_channel::oneshot::channel();

        {
            let platform = DefaultPlatform::new("".to_string(), "".to_string());
            let when_platform_destroyed = platform_destroyed.listen();
            platform.spawn_task("".into(), async move {
                when_platform_destroyed.await;
                tx.send(()).unwrap();
            })
        }

        // The platform is destroyed, but the task must still be running.
        assert!(matches!(rx.try_recv(), Ok(None)));
        platform_destroyed.notify(usize::MAX);
        assert!(matches!(smol::block_on(rx), Ok(())));
    }

    /// 只在人工验收时访问真实公网节点，普通 CI 不依赖外部网络可用性。
    #[test]
    #[ignore = "需要连接 CitizenChain 公网 WSS bootnode"]
    fn citizenchain_self_signed_wss_transport_connects() {
        smol::block_on(async {
            const HOST: &str = "nrcgch.crcfrcn.com";
            const PORT: u16 = 30333;

            let socket = smol::net::TcpStream::connect((HOST, PORT))
                .await
                .expect("CitizenChain WSS bootnode 应可建立 TCP 连接");
            let tls = tls_connector()
                .expect("TLS 配置应有效")
                .connect(
                    tls_server_name(HOST.to_owned()).expect("bootnode 域名应可作为 SNI"),
                    socket,
                )
                .await
                .expect("bootnode 的自签证书必须完成带签名校验的 TLS 握手");
            websocket::websocket_client_handshake(websocket::Config {
                tcp_socket: tls,
                host: HOST,
                url: "/",
            })
            .await
            .expect("真实 WSS Upgrade 应成功");
        });
    }
}
