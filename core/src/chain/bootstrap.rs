#![forbid(unsafe_code)]
//! SDK 启动节点建议。HTTPS 清单不是链状态真源，不能提供 RPC 或替换随包信任资产。
use crate::types::ContractError;
use crate::types::ContractErrorCode;
use crate::types::ContractResult;
use crate::types::CITIZENCHAIN_GENESIS_HASH;
use http_body_util::BodyExt;
use http_body_util::Empty;
use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::Map;
use serde_json::Value;
use std::time::Duration;
use url::Url;

const DEFAULT_BASE_URL: &str = "https://www.crcfrcn.com/api";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(6);

fn invalid() -> ContractError {
    // 不记录远端响应原文；其中可能混入非 SDK 数据。
    ContractError::new(
        ContractErrorCode::Integrity,
        "CitizenSDK 启动节点建议不符合固定链合同",
    )
}

fn object<'a>(value: &'a Value, expected: &[&str]) -> ContractResult<&'a Map<String, Value>> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid());
    }
    Ok(object)
}

fn has_forbidden_key(value: &Value) -> bool {
    const FORBIDDEN: &[&str] = &[
        "rpc_url",
        "rpc_urls",
        "rpc_endpoint",
        "validator_rpc_url",
        "archive_rpc_url",
        "chain_rpc_url",
        "checkpoint",
        "checkpoint_url",
        "light_sync_state",
        "light_sync_state_url",
        "light_sync_state_sha256",
    ];
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            FORBIDDEN.contains(&key.to_ascii_lowercase().as_str()) || has_forbidden_key(value)
        }),
        Value::Array(array) => array.iter().any(has_forbidden_key),
        _ => false,
    }
}

/// 仅生成内存中的 bootNodes 投影，所有其他字段原值保留；不修改随包文件或数据库。
pub(crate) fn merge_bootnodes(chain_spec: &str, bytes: &[u8]) -> ContractResult<String> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(invalid());
    }
    let wire: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if has_forbidden_key(&wire) {
        return Err(invalid());
    }
    let root = object(
        &wire,
        &[
            "is_ok",
            "schema",
            "generated_at",
            "cache_ttl_seconds",
            "chain",
            "light_client",
            "p2p",
            "security",
        ],
    )?;
    if root["is_ok"] != true
        || root["schema"] != "citizensdk.chain.bootstrap"
        || root["generated_at"].as_u64().is_none()
        || root["cache_ttl_seconds"].as_u64().is_none()
    {
        return Err(invalid());
    }
    let chain = object(
        &root["chain"],
        &[
            "chain_id",
            "protocol_id",
            "genesis_hash",
            "state_root",
            "ss58_format",
            "token_symbol",
            "token_decimals",
        ],
    )?;
    let light = object(
        &root["light_client"],
        &[
            "mode",
            "truth_source",
            "api_is_truth",
            "bundled_assets_required",
        ],
    )?;
    let security = object(
        &root["security"],
        &[
            "exposes_rpc_url",
            "rpc_proxy",
            "exposes_private_key_material",
            "validator_rpc_public",
        ],
    )?;
    let p2p = object(&root["p2p"], &["bootnodes", "min_peer_count_hint"])?;
    // 这两个字符串是服务端现有 wire 的逻辑资产标识，不作本机文件路径使用。
    if light["mode"] != "smoldot"
        || light["truth_source"] != "p2p_finalized_storage"
        || light["api_is_truth"] != false
        || light["bundled_assets_required"]
            != serde_json::json!(["assets/chainspec.json", "assets/light_sync_state.json"])
        || security.values().any(|value| value != &Value::Bool(false))
        || p2p["min_peer_count_hint"].as_u64().is_none()
    {
        return Err(invalid());
    }
    let mut spec: Value = serde_json::from_str(chain_spec).map_err(|_| invalid())?;
    let genesis_hash = format!("0x{}", hex::encode(CITIZENCHAIN_GENESIS_HASH.as_bytes()));
    let remote_genesis = chain["genesis_hash"]
        .as_str()
        .ok_or_else(invalid)?
        .to_ascii_lowercase();
    let remote_state = chain["state_root"]
        .as_str()
        .ok_or_else(invalid)?
        .to_ascii_lowercase();
    if chain["chain_id"] != "citizenchain"
        || chain["protocol_id"] != "citizenchain"
        || spec["id"] != chain["chain_id"]
        || spec["protocolId"] != chain["protocol_id"]
        || remote_genesis != genesis_hash
        || spec["genesis"]["stateRootHash"] != remote_state
        || chain["ss58_format"] != 2027
        || spec["properties"]["ss58Format"] != chain["ss58_format"]
        || chain["token_symbol"] != "GMB"
        || chain["token_decimals"] != 2
    {
        return Err(invalid());
    }
    let raw = p2p["bootnodes"].as_array().ok_or_else(invalid)?;
    let mut nodes: Vec<Value> = Vec::new();
    for value in raw {
        // 建议只能包含DNS/WSS；真正multiaddr/peer-id解析及握手仍只由smoldot完成。
        if let Some(node) = value
            .as_str()
            .filter(|node| node.len() <= 256 && matches!(node.split('/').collect::<Vec<_>>().as_slice(), ["", "dns" | "dns4" | "dns6", host, "tcp", port, "wss", "p2p", peer] if !host.is_empty() && port.parse::<u16>().is_ok_and(|value| value != 0) && !peer.is_empty()))
        {
            let value = Value::String(node.to_owned());
            if !nodes.contains(&value) {
                nodes.push(value);
            }
        }
    }
    for value in spec["bootNodes"].as_array().ok_or_else(invalid)? {
        if !nodes.contains(value) {
            nodes.push(value.clone());
        }
    }
    spec["bootNodes"] = Value::Array(nodes);
    serde_json::to_string(&spec).map_err(|_| invalid())
}

fn endpoint(base: &str) -> ContractResult<Url> {
    let base = base.trim().trim_end_matches('/');
    let url = Url::parse(base).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Url::parse(&format!("{base}/chain/citizensdk/bootstrap")).map_err(|_| invalid())
}

fn accept_content_length(headers: &http::HeaderMap) -> ContractResult<()> {
    if let Some(value) = headers.get(http::header::CONTENT_LENGTH) {
        let declared = value
            .to_str()
            .ok()
            .and_then(|text| text.parse::<u64>().ok())
            .ok_or_else(invalid)?;
        if declared > MAX_RESPONSE_BYTES as u64 {
            return Err(invalid());
        }
    }
    Ok(())
}

fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8]) -> ContractResult<()> {
    if bytes
        .len()
        .checked_add(chunk.len())
        .is_none_or(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(invalid());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

/// 复用 provider 的 Tokio runtime；证书与主机名交给系统验证器，完整响应受
/// 同一六秒预算与实际字节数上限约束，不使用进程全局的 TLS 提供者。
pub(crate) async fn discover(chain_spec: &str) -> ContractResult<String> {
    let configured =
        option_env!("CITIZEN_SDK_BOOTSTRAP_URL").filter(|value| !value.trim().is_empty());
    let url = endpoint(configured.unwrap_or(DEFAULT_BASE_URL))?;
    tokio::time::timeout(TIMEOUT, async {
        let connector = HttpsConnectorBuilder::new()
            .with_provider_and_platform_verifier(rustls::crypto::ring::default_provider())
            .map_err(|_| invalid())?
            .https_only()
            .enable_http1()
            .build();
        let client =
            Client::builder(TokioExecutor::new()).build::<_, Empty<bytes::Bytes>>(connector);
        let request = http::Request::builder()
            .method(http::Method::GET)
            .uri(url.as_str())
            .header(http::header::ACCEPT, "application/json")
            .body(Empty::new())
            .map_err(|_| invalid())?;
        let mut response = client.request(request).await.map_err(|_| invalid())?;
        if response.status() != http::StatusCode::OK {
            return Err(invalid());
        }
        accept_content_length(response.headers())?;
        let mut bytes = Vec::new();
        while let Some(frame) = response.body_mut().frame().await {
            let chunk = frame
                .map_err(|_| invalid())?
                .into_data()
                .map_err(|_| invalid())?;
            append_bounded(&mut bytes, &chunk)?;
        }
        merge_bootnodes(chain_spec, &bytes)
    })
    .await
    .map_err(|_| {
        ContractError::new(
            ContractErrorCode::Timeout,
            "CitizenSDK 启动节点建议读取超时",
        )
    })?
}

#[cfg(test)]
#[path = "../../tests/abi/bootstrap.rs"]
mod tests;
