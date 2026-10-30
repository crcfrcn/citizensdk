use super::*;

const VALID_SPEC: &str = r#"{
        "name":"CitizenChain",
        "id":"citizenchain",
        "protocolId":"citizenchain",
        "genesis":{"stateRootHash":"0x00"}
    }"#;

#[test]
fn selected_bootnode_keeps_identity_and_cannot_reenable_bootstrap() {
    let mut spec: Value =
        serde_json::from_str(include_str!("../../../chain/chainspec.json")).expect("spec");
    spec["lightSyncState"] =
        serde_json::from_str(include_str!("../../../chain/light_sync_state.json"))
            .expect("checkpoint");
    let original = spec.clone();
    let node = spec["bootNodes"][0].as_str().expect("bootnode").to_owned();
    let selected = SmoldotProviderConfig::try_new(spec.to_string(), "test", "1")
        .expect("config")
        .with_bootstrap()
        .with_bootnode(&node)
        .expect("selected")
        .with_bootstrap();
    let projected: Value = serde_json::from_str(&selected.chain_spec).expect("projected");
    spec["bootNodes"] = serde_json::json!([node]);
    assert_eq!(projected, spec);
    assert_eq!(projected["genesis"], original["genesis"]);
    assert_eq!(projected["lightSyncState"], original["lightSyncState"]);
    assert_eq!(
        selected.endpoint,
        Some(("nrcgch.crcfrcn.com".to_owned(), 30333))
    );
    assert!(!selected.bootstrap);
    assert_eq!(
        selected.clone().with_bootnode(&node).expect("repeat"),
        selected
    );
}

#[test]
fn selected_bootnode_rejects_unlisted_and_non_wss_addresses() {
    let mut spec: Value = serde_json::from_str(VALID_SPEC).expect("spec");
    let config = SmoldotProviderConfig::try_new(spec.to_string(), "test", "1").expect("config");
    assert!(config.endpoint.is_none());
    assert!(config.clone().with_bootstrap().bootstrap);
    assert!(config
        .with_bootnode("/dns4/node.invalid/tcp/30333/wss/p2p/public")
        .is_err());
    for node in [
        "/dns4/node.invalid/tcp/30333/ws/p2p/public",
        "/dns4/node.invalid/tcp/0/wss/p2p/public",
        "/dns4/node.invalid/tcp/65536/wss/p2p/public",
        "/dns4/node.invalid/tcp/30333/wss/p2p/",
        "/ip4/127.0.0.1/tcp/30333/wss/p2p/public",
        "/dns4/node.invalid/tcp/30333/wss/p2p/public/extra",
        "/dns4/user@node.invalid/tcp/30333/wss/p2p/public",
        "/dns4/node.invalid?query/tcp/30333/wss/p2p/public",
        "/dns4/node.invalid#fragment/tcp/30333/wss/p2p/public",
    ] {
        spec["bootNodes"] = serde_json::json!([node]);
        let error = SmoldotProviderConfig::try_new(spec.to_string(), "test", "1")
            .expect("config")
            .with_bootnode(node)
            .expect_err("invalid endpoint");
        assert_eq!(error.code(), ContractErrorCode::InvalidArgument);
    }
}

#[test]
fn config_fixes_chain_and_protocol_identity() {
    assert!(SmoldotProviderConfig::try_new(VALID_SPEC, "test", "1").is_ok());
    let wrong = VALID_SPEC.replace(
        "\"protocolId\":\"citizenchain\"",
        "\"protocolId\":\"other\"",
    );
    let Err(error) = SmoldotProviderConfig::try_new(wrong, "test", "1") else {
        panic!("wrong protocol must fail");
    };
    assert_eq!(error.code(), ContractErrorCode::Integrity);
}

#[test]
fn owned_runtime_drives_future_from_plain_std_thread() {
    let Ok(config) = SmoldotProviderConfig::try_new(VALID_SPEC, "test", "1") else {
        panic!("valid provider config must parse");
    };
    let Ok(provider) = SmoldotVerifiedChainClient::new(config) else {
        panic!("provider runtime must start");
    };
    let worker = std::thread::spawn(move || provider.drive(async { 42_u64 }));
    let Ok(driven) = worker.join() else {
        panic!("worker must not panic");
    };
    let Ok(value) = driven else {
        panic!("provider runtime must drive the future");
    };
    assert_eq!(value, 42);
}

#[test]
fn start_future_panic_converges_once_without_changing_ordinary_results() {
    let state = Mutex::new(ProviderState {
        lifecycle: ProviderLifecycle::Starting,
        running: None,
        pending_import: None,
    });
    // 正常结果和普通失败均由调用方既有分支处理，不能被误判为 panic。
    assert_eq!(
        futures::executor::block_on(converge_start_unwind(&state, async { 7_u8 })),
        7
    );
    assert_eq!(
        state.lock().expect("state lock").lifecycle,
        ProviderLifecycle::Starting
    );
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        futures::executor::block_on(converge_start_unwind(&state, async {
            panic!("injected HTTPS verifier panic")
        }))
    }));
    assert!(panic.is_err());
    assert_eq!(
        state.lock().expect("state lock").lifecycle,
        ProviderLifecycle::StartFailed
    );
}

// 定向节点选择仅供本包回归，不进入正式接入实现。
impl super::SmoldotProviderConfig {
    /// 只连接随包清单中明确选择的WSS节点；保留其PeerID及所有链信任资产。
    /// 限制在创建连接前生效，动态发现不能把本实例引向其他地址。
    #[cfg(test)]
    pub fn with_bootnode(mut self, node: &str) -> ContractResult<Self> {
        let invalid = || {
            contract_error(
                ContractErrorCode::InvalidArgument,
                "定向节点必须是既有清单中的WSS地址",
            )
        };
        let mut spec: Value = serde_json::from_str(&self.chain_spec).map_err(|_| invalid())?;
        let listed = spec
            .get("bootNodes")
            .and_then(Value::as_array)
            .is_some_and(|nodes| nodes.iter().any(|value| value.as_str() == Some(node)));
        if !listed {
            return Err(invalid());
        }
        let parts: Vec<_> = node.split('/').collect();
        let ["", "dns4", hostname, "tcp", port, "wss", "p2p", peer] = parts.as_slice() else {
            return Err(invalid());
        };
        let port: u16 = port.parse().map_err(|_| invalid())?;
        if port == 0 || peer.is_empty() {
            return Err(invalid());
        }
        let url = url::Url::parse(&format!("wss://{hostname}:{port}/")).map_err(|_| invalid())?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || url.port_or_known_default() != Some(port)
            || !url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case(hostname))
        {
            return Err(invalid());
        }
        let Some(url::Host::Domain(hostname)) = url.host() else {
            return Err(invalid());
        };
        self.endpoint = Some((hostname.to_owned(), port));
        spec["bootNodes"] = serde_json::json!([node]);
        self.chain_spec = serde_json::to_string(&spec).map_err(|_| invalid())?;
        self.bootstrap = false;
        Ok(self)
    }
}

// 默认生产配置和定向测试均不能绕过SDK的WSS连接边界。
#[test]
fn sdk_platform_rejects_insecure_connections_before_upstream_io() {
    let platform = WssPlatform(DefaultPlatform::new("test".into(), "1".into()));
    for kind in [
        ConnectionType::TcpIpv4,
        ConnectionType::TcpIpv6,
        ConnectionType::TcpDns,
        ConnectionType::WebSocketIpv4 {
            remote_is_localhost: false,
        },
        ConnectionType::WebSocketIpv6 {
            remote_is_localhost: false,
        },
        ConnectionType::WebSocketDns {
            secure: false,
            remote_is_localhost: false,
        },
        ConnectionType::WebRtcIpv4,
        ConnectionType::WebRtcIpv6,
    ] {
        assert!(!platform.supports_connection_type(kind));
    }
    assert!(
        platform.supports_connection_type(ConnectionType::WebSocketDns {
            secure: true,
            remote_is_localhost: false
        })
    );
    for address in [
        Address::TcpDns {
            hostname: "fixture.invalid",
            port: 443,
        },
        Address::WebSocketDns {
            hostname: "fixture.invalid",
            port: 443,
            secure: false,
        },
    ] {
        let mut stream = futures::executor::block_on(platform.connect_stream(address));
        let error = platform
            .read_write_access(Pin::new(&mut stream))
            .err()
            .expect("rejected without DNS");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }
    // 构造连接句柄不执行网络；真正DNS/TLS握手仍由同一个smoldot实现完成。
    for hostname in ["first.invalid", "second.invalid"] {
        let stream = futures::executor::block_on(platform.connect_stream(Address::WebSocketDns {
            hostname,
            port: 443,
            secure: true,
        }));
        assert!(matches!(stream, WssStream::Connected(_)));
    }
}
