//! 验证metadata驱动的账户地址、存储、调用及常量编解码。

use super::*;
use crate::system_events::decode_metadata_strict;

const METADATA_HEX: &str = include_str!("citizenchain-runtime-v14-metadata.hex");

#[test]
fn account_evm_address_matches_runtime_vectors_and_rejects_wrong_lengths() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("citizenchain-evm-address-v1.json")).unwrap();
    for row in fixture["vectors"].as_array().unwrap() {
        let account =
            hex::decode(row["account_id"].as_str().unwrap().trim_start_matches("0x")).unwrap();
        let request = serde_json::json!({"op":"account_evm_address","account_id":account});
        let address = super::chain_codec(&[], &serde_json::to_vec(&request).unwrap()).unwrap();
        assert_eq!(
            format!("0x{}", hex::encode(address)),
            row["ethereum_address"].as_str().unwrap()
        );
    }
    for length in [0, 20, 31, 33, 64] {
        let request = serde_json::json!({"op":"account_evm_address","account_id":vec![0u8;length]});
        assert!(super::chain_codec(&[], &serde_json::to_vec(&request).unwrap()).is_err());
    }
}

fn metadata() -> Metadata {
    let text = METADATA_HEX
        .trim()
        .strip_prefix("0x")
        .expect("metadata 0x prefix");
    assert_eq!(text.len() % 2, 0, "metadata hex length");
    let bytes = (0..text.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&text[offset..offset + 2], 16).expect("metadata hex"))
        .collect::<Vec<_>>();
    decode_metadata_strict(&bytes).expect("production metadata")
}

#[test]
fn three_unrelated_calls_share_one_opaque_validation_path() {
    let metadata = metadata();
    let (system, remark) = call_indices(&metadata, "System", "remark");
    let (timestamp, set) = call_indices(&metadata, "Timestamp", "set");
    let (balances, upgrade) = call_indices(&metadata, "Balances", "upgrade_accounts");
    let calls = [
        vec![system, remark, 0],
        vec![timestamp, set, 0],
        vec![balances, upgrade, 0],
    ];
    for (index, bytes) in calls.into_iter().enumerate() {
        let opaque = OpaqueTransactionCall::try_new(bytes).expect("opaque call");
        validate_opaque_runtime_call(&metadata, &opaque)
            .unwrap_or_else(|error| panic!("generic validation {index}: {error:?}"));
    }
}

fn call_indices(metadata: &Metadata, pallet_name: &str, call_name: &str) -> (u8, u8) {
    let pallet = metadata
        .pallet_by_name(pallet_name)
        .expect("fixture pallet");
    let call = pallet
        .call_variant_by_name(call_name)
        .expect("fixture call");
    (pallet.index(), call.index)
}

#[test]
fn revive_metadata_preserves_native_calls_and_zero_byte_set_origin() {
    // 金标由当前Runtime源码公开metadata_at_version(15)导出；源码测试版本为0/0，正式升级版本由发布入口指定。
    let text = include_str!("citizenchain-revive-v15-metadata.hex").trim();
    let hex = text.strip_prefix("0x").expect("metadata prefix");
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("metadata hex"))
        .collect::<Vec<_>>();
    let current = decode_metadata_strict(&bytes).expect("current WASM metadata");
    use subxt_core::ext::codec::Decode;
    let mut version = current
        .pallet_by_name("System")
        .unwrap()
        .constant_by_name("Version")
        .unwrap()
        .value();
    let version_fields =
        <(String, String, u32, u32, u32, Vec<([u8; 8], u32)>, u32, u8)>::decode(&mut version)
            .unwrap();
    assert!(version.is_empty());
    assert_eq!(
        (
            version_fields.0.as_str(),
            version_fields.3,
            version_fields.6
        ),
        ("citizenchain", 0, 0)
    );
    assert_eq!(
        current.pallet_by_name("Revive").expect("Revive").index(),
        35
    );
    let identity = current
        .pallet_by_name("CitizenIdentity")
        .expect("identity pallet");
    let self_rebind = identity
        .call_variant_by_name("self_rebind_cid_account_id")
        .expect("call9");
    assert_eq!(self_rebind.index, 9);
    assert_eq!(
        self_rebind
            .fields
            .iter()
            .map(|field| field.name.as_deref())
            .collect::<Vec<_>>(),
        vec![
            Some("cid_number"),
            Some("expected_binding_revision"),
            Some("current_account_signature")
        ]
    );
    let admin_rebind = identity
        .call_variant_by_name("admin_rebind_cid_account_id")
        .expect("registrar call7");
    assert!(admin_rebind
        .fields
        .iter()
        .any(|field| field.name.as_deref() == Some("expires_at")));

    let before = metadata();
    for name in [
        "System",
        "Balances",
        "OnchainTransaction",
        "CitizenIdentity",
    ] {
        assert_eq!(
            before.pallet_by_name(name).expect("before").index(),
            current.pallet_by_name(name).expect("current").index(),
            "{name}"
        );
    }
    let call = vec![4, 0]
        .into_iter()
        .chain([0x51; 32])
        .chain(100_u128.to_le_bytes())
        .chain([0])
        .collect::<Vec<_>>();
    let opaque = OpaqueTransactionCall::try_new(call).expect("native transfer");
    validate_opaque_runtime_call(&before, &opaque).expect("old native call");
    validate_opaque_runtime_call(&current, &opaque).expect("current native call");
    let extensions = current
        .extrinsic()
        .transaction_extensions_to_use_for_encoding()
        .collect::<Vec<_>>();
    let origin = extensions
        .iter()
        .find(|e| e.identifier() == "EthSetOrigin")
        .expect("actual metadata identifier EthSetOrigin");
    for type_id in [origin.extra_ty(), origin.additional_ty()] {
        let mut empty: &[u8] = &[];
        let value = scale_value::scale::decode_as_type(&mut empty, type_id, current.types())
            .expect("native SetOrigin adds no bytes");
        let mut encoded = Vec::new();
        value
            .encode_as_type_to(type_id, current.types(), &mut encoded)
            .expect("canonical empty");
        assert!(encoded.is_empty());
    }
}

#[test]
fn unknown_truncated_and_trailing_calls_fail_closed() {
    let metadata = metadata();
    let unknown_pallet = (0_u8..=u8::MAX)
        .find(|index| metadata.pallet_by_index(*index).is_none())
        .expect("metadata cannot occupy every pallet index");
    for bytes in [vec![unknown_pallet, 0], vec![0], vec![0, 0, 0xff]] {
        let opaque = OpaqueTransactionCall::try_new(bytes).expect("bounded opaque call");
        match validate_opaque_runtime_call(&metadata, &opaque).unwrap_err() {
            EngineError::Contract(error) => {
                assert_eq!(error.code(), ContractErrorCode::InvalidArgument)
            }
            other => panic!("expected invalid-argument contract error, got {other:?}"),
        }
    }
}

#[test]
fn chain_codec_uses_exact_metadata_for_storage_and_call() {
    use serde_json::json;
    let metadata = hex::decode(
        include_str!("citizenchain-revive-v15-metadata.hex")
            .trim()
            .trim_start_matches("0x"),
    )
    .unwrap();
    let codec = |operation: serde_json::Value| {
        super::chain_codec(&metadata, &serde_json::to_vec(&operation).unwrap())
    };
    let account = vec![0x31u8; 32];
    let args = json!({"kind":"sequence","value":[
        {"kind":"bytes","value":account},
        {"kind":"integer","value":"123"},
        {"kind":"bytes","value":[0x61, 0x62]}
    ]});
    let call = codec(json!({"op":"call","pallet":"OnchainTransaction","method":"transfer_with_remark","args":args})).unwrap();
    let verified = crate::types::OpaqueTransactionCall::try_new(call.clone()).unwrap();
    let parsed = crate::system_events::decode_metadata_strict(&metadata).unwrap();
    super::validate_opaque_runtime_call(&parsed, &verified).unwrap();
    let generated = codec(
        json!({"op":"storage","pallet":"System","entry":"Account","keys":[
            {"kind":"bytes","value":vec![0x31u8; 32]}
        ]}),
    )
    .unwrap();
    let expected = crate::account_state::system_account_storage_key(
        &parsed,
        crate::types::AccountId32::from_bytes([0x31; 32]),
    )
    .unwrap();
    assert_eq!(generated, expected);
    assert!(codec(
        json!({"op":"call","pallet":"OnchainTransaction","method":"not_a_call","args":args})
    )
    .is_err());
    assert!(codec(
        json!({"op":"decode_storage","pallet":"Timestamp","entry":"Now","value":vec![0u8;9]})
    )
    .is_err());
}

#[test]
fn chain_codec_reads_unsigned_constant_from_verified_metadata() {
    let metadata = hex::decode(
        include_str!("citizenchain-personal-metadata.hex")
            .trim()
            .trim_start_matches("0x"),
    )
    .unwrap();
    // 链上转账历史合同只在其v15金标中验证，不把历史pallet名带入当前个人金标。
    let historical = hex::decode(
        include_str!("citizenchain-revive-v15-metadata.hex")
            .trim()
            .trim_start_matches("0x"),
    )
    .unwrap();
    let read = |metadata: &[u8], pallet, name| {
        let request = serde_json::json!({
            "op": "unsigned_constant",
            "pallet": pallet,
            "name": name,
        });
        super::chain_codec(metadata, &serde_json::to_vec(&request).unwrap())
    };
    assert_eq!(
        read(&metadata, "Personal", "MinCreateAmount").unwrap(),
        b"111"
    );
    assert_eq!(
        read(&historical, "OnchainTransaction", "MaxTransferRemarkLen").unwrap(),
        b"99"
    );
    assert!(read(&metadata, "Personal", "MissingConstant").is_err());
    assert!(read(&metadata, "System", "Version").is_err());
}

/// 当前个人模块的公开metadata来自实际编译Runtime，历史夹具及原断言保持。
#[test]
fn personal_metadata_keeps_pallet_and_call_contract() {
    let bytes = hex::decode(
        include_str!("citizenchain-personal-metadata.hex")
            .trim()
            .trim_start_matches("0x"),
    )
    .expect("compiled personal runtime metadata");
    let current = decode_metadata_strict(&bytes).expect("actual Runtime metadata");
    assert_eq!(call_indices(&current, "Personal", "propose_create"), (7, 0));
    assert_eq!(call_indices(&current, "Personal", "propose_close"), (7, 1));
    assert_eq!(
        call_indices(&current, "Personal", "propose_admin_set_change"),
        (7, 3)
    );
    assert!(current.pallet_by_index(29).is_none());
    let pallet = current
        .pallet_by_name("Personal")
        .expect("single personal pallet");
    let storage = pallet.storage().expect("personal storage");
    for name in [
        "PersonalAccounts",
        "AdminAccounts",
        "PendingPersonalCreate",
        "PendingCloseProposal",
    ] {
        assert!(
            storage.entry_by_name(name).is_some(),
            "missing personal storage: {name}"
        );
    }
    // 以真实metadata验证三字段成员，旧CID槽不得混入当前调用。
    let create_call = |cid_slot: bool| {
        let mut call = vec![7, 0, 4, b'x', 8];
        for wallet in [1u8, 2] {
            call.extend_from_slice(&[wallet; 32]);
            if cid_slot {
                call.push(0);
            }
            call.extend_from_slice(&[4, b'f', 4, b'g']);
        }
        call.extend_from_slice(&2u32.to_le_bytes());
        call.extend_from_slice(&111u128.to_le_bytes());
        OpaqueTransactionCall::try_new(call).unwrap()
    };
    validate_opaque_runtime_call(&current, &create_call(false))
        .expect("wallet and name notes only");
    assert!(
        validate_opaque_runtime_call(&current, &create_call(true)).is_err(),
        "CID-bearing member layout must not be accepted"
    );
    let request = serde_json::json!({
        "op": "unsigned_constant",
        "pallet": "Personal",
        "name": "MinCreateAmount",
    });
    assert_eq!(
        super::chain_codec(&bytes, &serde_json::to_vec(&request).unwrap()).unwrap(),
        b"111",
    );
}

/// 真实Runtime导出的当前机构协议：两个结构没有旧枚举或钱包字段。
#[test]
fn institution_metadata_encodes_person_cids_seats_and_separate_registration() {
    use scale_value::Value;
    use subxt_core::ext::codec::Encode;
    let bytes = hex::decode(include_str!("citizenchain-personal-metadata.hex").trim().trim_start_matches("0x")).unwrap();
    let current = decode_metadata_strict(&bytes).unwrap();
    for removed in ["PublicAdmins", "PrivateAdmins", "PersonalAdmins", "PublicManage", "PrivateManage"] {
        assert!(current.pallet_by_name(removed).is_none(), "removed pallet {removed}");
    }
    assert_eq!(call_indices(&current, "Multisig", "propose_transfer"), (17, 0));
    assert_eq!(call_indices(&current, "InternalVote", "cast"), (20, 0));
    let personal = current.pallet_by_name("Personal").unwrap();
    assert_eq!(personal.constant_by_name("MaxPersonalAccountAdmins").unwrap().value(), &64u32.to_le_bytes());
    let cid = b"LN001-NRC0G-944805165-2026";
    let actor = b"ZS001-FRG07-249474503-2026";
    let role = b"RCHAIR";
    let persons = ["CN220-CTZN2-198805200-2026", "CN951-CTZN1-539598435-2026"];
    for (pallet_name, index, governance_hex, registration_hex) in [
        ("PublicEntity", 30, "0x1e08684c4e3030312d4e524330472d3934343830353136352d32303236040024e8b4a2e58aa1e5b2970002000000041c7265732d69737300000000000868434e3232302d43545a4e322d3139383830353230302d32303236000000000000000005000068434e3935312d43545a4e312d3533393539383433352d3230323600000000000000000500000000684c4e3030312d4e524330472d3934343830353136352d3230323618524348414952", "0x1e09684c4e3030312d4e524330472d3934343830353136352d32303236040024e8b4a2e58aa1e5b2970002000000041c7265732d69737300000000000868434e3232302d43545a4e322d3139383830353230302d32303236000000000000000001000068434e3935312d43545a4e312d3533393539383433352d32303236000000000000000001000000685a533030312d46524730372d3234393437343530332d3230323618524348414952abababababababababababababababababababababababababababababababab0102000000"),
        ("PrivateEntity", 31, "0x1f08684c4e3030312d4e524330472d3934343830353136352d32303236040024e8b4a2e58aa1e5b2970002000000041c7265732d69737300000000000868434e3232302d43545a4e322d3139383830353230302d32303236000000000000000005000068434e3935312d43545a4e312d3533393539383433352d3230323600000000000000000500000000684c4e3030312d4e524330472d3934343830353136352d3230323618524348414952", "0x1f09684c4e3030312d4e524330472d3934343830353136352d32303236040024e8b4a2e58aa1e5b2970002000000041c7265732d69737300000000000868434e3232302d43545a4e322d3139383830353230302d32303236000000000000000001000068434e3935312d43545a4e312d3533393539383433352d32303236000000000000000001000000685a533030312d46524730372d3234393437343530332d3230323618524348414952abababababababababababababababababababababababababababababababab0102000000"),
    ] {
        let pallet = current.pallet_by_name(pallet_name).unwrap();
        assert_eq!(pallet.index(), index);
        assert!(pallet.call_variant_by_index(10).is_none());
        for (method, call_index, registration, expected_hex, type_name, names) in [
            ("propose_institution_governance", 8, false, governance_hex, "InstitutionGovernanceAction", vec!["cid_number", "action", "actor_cid_number", "proposer_role_code"]),
            ("register_institution_roles", 9, true, registration_hex, "InstitutionRoleRegistration", vec!["cid_number", "action", "actor_cid_number", "actor_role_code", "expected_state_hash", "initial_threshold"]),
        ] {
            let call = pallet.call_variant_by_name(method).unwrap();
            assert_eq!(call.index, call_index);
            assert_eq!(call.fields.iter().map(|field| field.name.as_deref().unwrap()).collect::<Vec<_>>(), names);
            let action_type = call.fields[1].ty.id;
            assert_eq!(current.types().resolve(action_type).unwrap().path.segments.last().unwrap(), type_name);
            let assignments = persons.iter().map(|person| Value::named_composite([
                ("person_cid", Value::from_bytes(person.as_bytes())),
                ("term_start", Value::u128(0)),
                ("term_end", Value::u128(0)),
                ("assignment_source", Value::unnamed_variant(if registration { "Registry" } else { "InstitutionGovernance" }, [])),
                ("assignment_source_ref", Value::from_bytes([])),
                ("assignment_status", Value::unnamed_variant("Active", [])),
            ])).collect::<Vec<_>>();
            let mutation = Value::named_variant("Create", [
                ("role_name", Value::from_bytes("财务岗".as_bytes())),
                ("term_required", Value::bool(false)),
                ("seats", Value::u128(2)),
                ("permissions", Value::unnamed_composite([Value::named_composite([
                    ("business_action_id", Value::named_composite([
                        ("module_tag", Value::from_bytes(b"res-iss")),
                        ("action_code", Value::u128(0)),
                    ])),
                    ("operation", Value::unnamed_variant("Propose", [])),
                ])])),
                ("assignments", Value::unnamed_composite(assignments)),
            ]);
            let mut fields = vec![
                ("role_mutations", Value::unnamed_composite([mutation])),
                ("assignment_changes", Value::unnamed_composite([])),
            ];
            if !registration {
                fields.push(("legal_representative_change", Value::unnamed_variant("None", [])));
            }
            let mut action = Vec::new();
            Value::named_composite(fields).encode_as_type_to(action_type, current.types(), &mut action).unwrap();
            let mut encoded = vec![index, call_index];
            encoded.extend(cid.to_vec().encode());
            encoded.extend_from_slice(&action);
            encoded.extend(if registration { actor.to_vec() } else { cid.to_vec() }.encode());
            encoded.extend(role.to_vec().encode());
            if registration {
                encoded.extend([0xab; 32]);
                encoded.extend(Some(2u32).encode());
            }
            assert_eq!(format!("0x{}", hex::encode(&encoded)), expected_hex);
            validate_opaque_runtime_call(&current, &OpaqueTransactionCall::try_new(encoded.clone()).unwrap()).unwrap();
            for cut in 0..encoded.len() {
                if cut == 0 { continue; }
                assert!(validate_opaque_runtime_call(&current, &OpaqueTransactionCall::try_new(encoded[..cut].to_vec()).unwrap()).is_err());
            }
            let mut trailing = encoded.clone(); trailing.push(0);
            assert!(validate_opaque_runtime_call(&current, &OpaqueTransactionCall::try_new(trailing).unwrap()).is_err());
            // 旧治理enum前缀、登记法代槽和call10不能被新metadata解释为有效调用。
            let mut legacy = vec![index, call_index];
            legacy.extend(cid.to_vec().encode()); legacy.push(1);
            legacy.extend_from_slice(&encoded[2 + cid.to_vec().encode().len()..]);
            assert!(validate_opaque_runtime_call(&current, &OpaqueTransactionCall::try_new(legacy).unwrap()).is_err());
            if registration {
                let mut legal_slot = encoded.clone();
                legal_slot.insert(2 + cid.to_vec().encode().len() + action.len(), 0);
                assert!(validate_opaque_runtime_call(&current, &OpaqueTransactionCall::try_new(legal_slot).unwrap()).is_err());
            }
        }
        let mut legal = Vec::new();
        let action_type = pallet.call_variant_by_index(8).unwrap().fields[1].ty.id;
        Value::named_composite([
            ("role_mutations", Value::unnamed_composite([])),
            ("assignment_changes", Value::unnamed_composite([])),
            ("legal_representative_change", Value::unnamed_variant("Some", [Value::named_variant("Set", [
                ("family_name", Value::from_bytes("张".as_bytes())),
                ("given_name", Value::from_bytes("三".as_bytes())),
                ("person_cid", Value::from_bytes(persons[0].as_bytes())),
            ])])),
        ]).encode_as_type_to(action_type, current.types(), &mut legal).unwrap();
        let mut expected = vec![0, 0, 1, 0];
        expected.extend("张".as_bytes().to_vec().encode());
        expected.extend("三".as_bytes().to_vec().encode());
        expected.extend(persons[0].as_bytes().to_vec().encode());
        assert_eq!(legal, expected);
    }
    // RoleVoters的第二个键直接是RoleSubject，不套AuthorizationSubject::Institution枚举。
    let key = super::chain_codec(&bytes, &serde_json::to_vec(&serde_json::json!({
        "op":"storage", "pallet":"VotingEngine", "entry":"RoleVoters", "keys":[
            {"kind":"integer","value":"42"},
            {"kind":"sequence","value":[{"kind":"bytes","value":cid},{"kind":"bytes","value":b"COMMITTEE_MEMBER"}]}
        ]
    })).unwrap()).unwrap();
    let subject = (cid.to_vec(), b"COMMITTEE_MEMBER".to_vec()).encode();
    assert!(key.ends_with(&subject));
    let call10 = OpaqueTransactionCall::try_new(vec![30, 10, 0]).unwrap();
    assert!(validate_opaque_runtime_call(&current, &call10).is_err());
}

#[test]
fn chain_codec_preserves_runtime_keys_and_u128_clearing_calls() {
    use serde_json::json;
    use subxt_core::ext::codec::Encode;
    use subxt_core::storage::{address::dynamic, get_address_root_bytes};
    let metadata = hex::decode(
        include_str!("citizenchain-revive-v15-metadata.hex")
            .trim()
            .trim_start_matches("0x"),
    )
    .unwrap();
    let codec = |request: serde_json::Value| {
        super::chain_codec(&metadata, &serde_json::to_vec(&request).unwrap())
    };

    let cid = b"CN001-TEST-2026".to_vec();
    let cid_bytes = cid.encode();
    let mut expected = get_address_root_bytes(&dynamic("CitizenIdentity", "AccountIdByCid", ()));
    expected.extend_from_slice(&crate::types::blake2b::<16>(&cid_bytes));
    expected.extend_from_slice(&cid_bytes);
    assert_eq!(
        codec(json!({
            "op":"storage","pallet":"CitizenIdentity","entry":"AccountIdByCid",
            "keys":[{"kind":"bytes","value":cid}],
        }))
        .unwrap(),
        expected
    );

    let id = 42_u128;
    let mut prefix = get_address_root_bytes(&dynamic("InternalVote", "InternalVotesByTicket", ()));
    let id_bytes = id.to_le_bytes();
    prefix.extend_from_slice(&crate::types::blake2b::<16>(&id_bytes));
    prefix.extend_from_slice(&id_bytes);
    assert_eq!(
        codec(json!({
            "op":"storage","pallet":"InternalVote","entry":"InternalVotesByTicket",
            "keys":[{"kind":"integer","value":id.to_string()}],
        }))
        .unwrap(),
        prefix
    );

    for (name, discriminant) in [("Freedom", 0), ("Spark", 2)] {
        let key = codec(json!({
            "op":"storage","pallet":"SquarePost","entry":"PlatformPrice",
            "keys":[{"kind":"variant","value":[name, []]}],
        }))
        .unwrap();
        assert_eq!(key.len(), 41);
        assert_eq!(key.last(), Some(&discriminant));
    }

    for (method, index) in [("deposit", 31), ("withdraw", 32)] {
        let call = codec(json!({
            "op":"call","pallet":"OffchainTransaction","method":method,
            "args":{"kind":"sequence","value":[{"kind":"integer","value":"4660"}]},
        }))
        .unwrap();
        assert_eq!(call[..2], [19, index]);
        assert_eq!(call[2..], 4660_u128.to_le_bytes());
    }
}

#[test]
fn voting_calls_preserve_fixed_u128_ids_and_reject_invalid_boundaries() {
    use serde_json::json;
    use subxt_core::ext::codec::Encode;
    let metadata = hex::decode(
        include_str!("citizenchain-revive-v15-metadata.hex")
            .trim()
            .trim_start_matches("0x"),
    )
    .unwrap();
    let parsed = decode_metadata_strict(&metadata).unwrap();
    let cid = b"LN001-NRC0G-944805165-2026".to_vec();
    let role = b"COMMITTEE_MEMBER".to_vec();
    let cases = [
        (
            "InternalVote",
            "cast",
            vec![
                json!({"kind":"variant","value":["Personal",[]]}),
                json!({"kind":"bool","value":true}),
            ],
            (0u8, true).encode(),
        ),
        (
            "JointVote",
            "cast_admin",
            vec![
                json!({"kind":"bytes","value":cid}),
                json!({"kind":"bytes","value":role}),
                json!({"kind":"bool","value":true}),
            ],
            (cid.clone(), role.clone(), true).encode(),
        ),
        (
            "JointVote",
            "cast_referendum",
            vec![json!({"kind":"bool","value":true})],
            true.encode(),
        ),
        (
            "LegislationVote",
            "cast_representative_vote",
            vec![
                json!({"kind":"bytes","value":role}),
                json!({"kind":"bool","value":true}),
            ],
            (role.clone(), true).encode(),
        ),
        (
            "LegislationVote",
            "cast_referendum_vote",
            vec![json!({"kind":"bool","value":true})],
            true.encode(),
        ),
        (
            "LegislationVote",
            "executive_sign",
            vec![json!({"kind":"bool","value":true})],
            true.encode(),
        ),
        (
            "LegislationVote",
            "override_sign",
            vec![json!({"kind":"bool","value":true})],
            true.encode(),
        ),
        (
            "LegislationVote",
            "guard_vote",
            vec![json!({"kind":"bool","value":true})],
            true.encode(),
        ),
    ];
    for (pallet, method, fields, tail) in cases {
        let call = |id: String| {
            let mut args = vec![json!({"kind":"integer","value":id})];
            args.extend(fields.clone());
            super::chain_codec(
                &metadata,
                &serde_json::to_vec(&json!({
                    "op":"call", "pallet":pallet, "method":method,
                    "args":{"kind":"sequence","value":args},
                }))
                .unwrap(),
            )
        };
        let indices = call_indices(&parsed, pallet, method);
        for id in [
            0,
            63,
            64,
            16_383,
            16_384,
            9_007_199_254_740_993,
            u64::MAX as u128 + 1,
            u128::MAX,
        ] {
            let encoded = call(id.to_string()).unwrap();
            let mut expected = vec![indices.0, indices.1];
            expected.extend(id.to_le_bytes());
            expected.extend_from_slice(&tail);
            assert_eq!(encoded, expected, "{pallet}::{method} id={id}");
            validate_opaque_runtime_call(
                &parsed,
                &OpaqueTransactionCall::try_new(encoded.clone()).unwrap(),
            )
            .unwrap();
            let mut trailing = encoded.clone();
            trailing.push(0);
            for invalid in [encoded[..encoded.len() - 1].to_vec(), trailing] {
                assert!(validate_opaque_runtime_call(
                    &parsed,
                    &OpaqueTransactionCall::try_new(invalid).unwrap()
                )
                .is_err());
            }
        }
        for invalid in ["-1", "340282366920938463463374607431768211456"] {
            assert!(
                call(invalid.into()).is_err(),
                "{pallet}::{method} must reject {invalid}"
            );
        }
    }
}

#[test]
fn v5_native_contract_requires_real_account_authentication_metadata() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("mldsa-runtime-v16.json")).unwrap();
    let raw = hex::decode(fixture["metadata"].as_str().unwrap()).unwrap();
    let metadata = decode_metadata_strict(&raw).unwrap();
    let checks = native_extensions(&metadata).unwrap();
    assert!(checks.iter().any(|ext| ext.identifier() == "CheckNonce"));
    assert!(checks.iter().any(|ext| ext.identifier() == "CheckWeight"));
    assert!(native_extensions(&super::tests::metadata()).is_err());
}
