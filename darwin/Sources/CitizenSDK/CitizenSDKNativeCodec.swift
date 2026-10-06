import Foundation

/// Decodes retained Core result handles into secret-free Swift value types.
internal enum CitizenSDKNativeCodec {
    static func qr(_ result: UInt64, kind: UInt32) throws -> String {
        try inspect(result, kind: kind) {
            var required: UInt64 = 0
            try CitizenSDKChecks.requireOK(citizensdk_result_copy_qr(result, nil, 0, &required), "Core QR result length is invalid")
            guard required > 0, required <= 65_536 else { throw CitizenSDKError(.integrity, "Core QR result exceeds its limit") }
            var output = Data(count: Int(required))
            let capacity = required
            let status = output.withUnsafeMutableBytes {
                citizensdk_result_copy_qr(result, $0.bindMemory(to: UInt8.self).baseAddress, capacity, &required)
            }
            try CitizenSDKChecks.requireOK(status, "Core QR result copy failed")
            guard required == capacity, let json = String(data: output, encoding: .utf8) else {
                throw CitizenSDKError(.integrity, "Core QR result is not exact UTF-8")
            }
            return json
        }
    }

    static func empty(_ result: UInt64) throws {
        try inspect(result, kind: 0) { () }
    }

    static func block(_ result: UInt64) throws -> CitizenBlockRef {
        try inspect(result, kind: 1) {
            var value = citizensdk_block_ref_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_block_ref_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_block_ref(result, &value), "Core block result is invalid")
            return try block(value)
        }
    }

    static func syncStatus(_ result: UInt64) throws -> CitizenChainSyncStatus {
        try inspect(result, kind: 24) {
            var value = citizensdk_chain_sync_status_info_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_chain_sync_status_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_sync_status(result, &value),
                                           "Core sync status is invalid")
            let best = try block(value.best), finalized = try block(value.finalized)
            guard best.finality == .best, finalized.finality == .finalized,
                  finalized.number <= best.number else {
                throw CitizenSDKError(.integrity, "Core sync anchors are inconsistent")
            }
            return CitizenChainSyncStatus(peerCount: value.peer_count,
                                          isSyncing: try boolean(value.is_syncing),
                                          isUsable: try boolean(value.is_usable),
                                          best: best, finalized: finalized)
        }
    }

    static func storage(_ result: UInt64) throws -> Data? {
        try inspect(result, kind: 2) {
            var present: UInt8 = 0, required: UInt64 = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_result_copy_storage(result, &present, nil, 0, &required),
                "Core storage result size is invalid")
            guard required <= 64 * 1_024 * 1_024 else {
                throw CitizenSDKError(.integrity, "Core storage result exceeds 64 MiB")
            }
            let output = try copy(required) { pointer, capacity, confirmed in
                citizensdk_result_copy_storage(result, &present, pointer, capacity, confirmed)
            }
            return try boolean(present) ? output : nil
        }
    }

    static func storageBatch(_ result: UInt64) throws -> [Data?] {
        try inspect(result, kind: 3) {
            var count: UInt32 = 0
            try CitizenSDKChecks.requireOK(citizensdk_result_get_storage_batch_count(result, &count),
                                           "Core storage batch count is invalid")
            guard count <= 1_024 else { throw CitizenSDKError(.integrity, "Core storage batch is too large") }
            var total: UInt64 = 0
            return try (0..<count).map { index in
                var present: UInt8 = 0, required: UInt64 = 0
                try CitizenSDKChecks.requireOK(
                    citizensdk_result_copy_storage_batch_item(result, index, &present, nil, 0, &required),
                    "Core storage batch item size is invalid")
                guard required <= 64 * 1_024 * 1_024 - total else {
                    throw CitizenSDKError(.integrity, "Core storage batch exceeds 64 MiB")
                }
                total += required
                let output = try copy(required) { pointer, capacity, confirmed in
                    citizensdk_result_copy_storage_batch_item(
                        result, index, &present, pointer, capacity, confirmed)
                }
                return try boolean(present) ? output : nil
            }
        }
    }

    static func runtimeContext(_ result: UInt64) throws -> CitizenRuntimeContext {
        try inspect(result, kind: 4) {
            var value = citizensdk_runtime_context_info_t(), required: UInt64 = 0
            prepare(&value.struct_size, &value.abi_version, citizensdk_runtime_context_info_t.self)
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_runtime_context(result, &value, nil, 0, &required),
                "Core runtime context size is invalid")
            guard required > 0, required <= 64 * 1_024 * 1_024 else {
                throw CitizenSDKError(.integrity, "Core runtime metadata is invalid")
            }
            let metadata = try copy(required) { pointer, capacity, confirmed in
                citizensdk_result_get_runtime_context(result, &value, pointer, capacity, confirmed)
            }
            return CitizenRuntimeContext(block: try block(value.block), specVersion: value.spec_version,
                                         transactionVersion: value.transaction_version, metadata: metadata)
        }
    }

    static func chainState(_ result: UInt64) throws -> CitizenChainState {
        try inspect(result, kind: 8) {
            var value = citizensdk_exported_state_info_t(), required: UInt64 = 0
            prepare(&value.struct_size, &value.abi_version, citizensdk_exported_state_info_t.self)
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_exported_state(result, &value, nil, 0, &required),
                "Core chain state size is invalid")
            guard required > 0, required <= 256 * 1_024 else {
                throw CitizenSDKError(.integrity, "Core chain state database is invalid")
            }
            let database = try copy(required) { pointer, capacity, confirmed in
                citizensdk_result_get_exported_state(result, &value, pointer, capacity, confirmed)
            }
            return try CitizenChainState(formatVersion: value.format_version,
                                         finalized: block(value.finalized), database: database)
        }
    }

    static func blockHeader(_ result: UInt64) throws -> CitizenBlockHeader {
        try inspect(result, kind: 25) {
            var value = citizensdk_block_header_info_t(), required: UInt64 = 0
            prepare(&value.struct_size, &value.abi_version, citizensdk_block_header_info_t.self)
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_block_header(result, &value, nil, 0, &required),
                "Core block header size is invalid")
            guard required <= 1_024 * 1_024 else {
                throw CitizenSDKError(.integrity, "Core block digest exceeds 1 MiB")
            }
            let digest = try copy(required) { pointer, capacity, confirmed in
                citizensdk_result_get_block_header(result, &value, pointer, capacity, confirmed)
            }
            return CitizenBlockHeader(block: try block(value.block), parentHash: fixed(value.parent_hash, 32),
                                      stateRoot: fixed(value.state_root, 32),
                                      extrinsicsRoot: fixed(value.extrinsics_root, 32), digest: digest)
        }
    }

    static func blockBody(_ result: UInt64) throws -> CitizenBlockBody {
        try inspect(result, kind: 26) {
            var value = citizensdk_block_body_info_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_block_body_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_block_body_info(result, &value),
                                           "Core block body info is invalid")
            guard value.extrinsic_count <= 16_384, value.total_bytes <= 64 * 1_024 * 1_024 else {
                throw CitizenSDKError(.integrity, "Core block body exceeds its limit")
            }
            var total: UInt64 = 0
            let extrinsics = try (0..<value.extrinsic_count).map { index -> Data in
                var required: UInt64 = 0
                try CitizenSDKChecks.requireOK(
                    citizensdk_result_copy_block_body_extrinsic(result, index, nil, 0, &required),
                    "Core block extrinsic size is invalid")
                guard required > 0, required <= value.total_bytes - total else {
                    throw CitizenSDKError(.integrity, "Core block extrinsic length is invalid")
                }
                total += required
                return try copy(required) { pointer, capacity, confirmed in
                    citizensdk_result_copy_block_body_extrinsic(result, index, pointer, capacity, confirmed)
                }
            }
            guard total == value.total_bytes else {
                throw CitizenSDKError(.integrity, "Core block body length is inconsistent")
            }
            return CitizenBlockBody(block: try block(value.block), extrinsics: extrinsics)
        }
    }

    static func balance(_ result: UInt64) throws -> CitizenAccountBalance {
        try inspect(result, kind: 9) {
            var value = citizensdk_account_balance_info_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_account_balance_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_account_balance(result, &value), "Core balance result is invalid")
            return try balance(value)
        }
    }

    static func balances(_ result: UInt64, accountIDs: [Data]) throws -> [CitizenAccountBalance] {
        try inspect(result, kind: 18) {
            var count: UInt32 = 0
            try CitizenSDKChecks.requireOK(citizensdk_result_get_account_balance_count(result, &count),
                                           "Core balance count is invalid")
            guard count <= 1_990, Int(count) == accountIDs.count else {
                throw CitizenSDKError(.integrity, "Core balance result count differs from the request")
            }
            let values = try (0..<count).map { index in
                var value = citizensdk_account_balance_info_t()
                prepare(&value.struct_size, &value.abi_version, citizensdk_account_balance_info_t.self)
                try CitizenSDKChecks.requireOK(citizensdk_result_get_account_balance_at(result, index, &value),
                                               "Core balance result is invalid")
                return try balance(value)
            }
            return try validateBalances(values, accountIDs: accountIDs)
        }
    }

    /// 只校验跨边界的结果完整性；账户解码、同块查询与余额计算仍唯一归 Rust。
    static func validateBalances(_ values: [CitizenAccountBalance], accountIDs: [Data]) throws -> [CitizenAccountBalance] {
        guard values.count == accountIDs.count, values.count <= 1_990,
              zip(values, accountIDs).allSatisfy({ $0.0.accountID == $0.1 }),
              values.allSatisfy({ $0.block.finality == .finalized && $0.block == values.first?.block }) else {
            throw CitizenSDKError(.integrity, "Core balance results do not match one finalized request")
        }
        return values
    }

    private static func balance(_ value: citizensdk_account_balance_info_t) throws -> CitizenAccountBalance {
        CitizenAccountBalance(block: try block(value.block), accountID: fixed(value.account_id.bytes, 32),
                              freeFen: u128(value.free_fen), reservedFen: u128(value.reserved_fen),
                              totalFen: u128(value.total_fen))
    }

    static func nonce(_ result: UInt64) throws -> CitizenAccountNonce {
        try inspect(result, kind: 10) {
            var value = citizensdk_account_nonce_info_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_account_nonce_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_account_nonce(result, &value), "Core nonce result is invalid")
            return CitizenAccountNonce(bestBlock: try block(value.best_block),
                                       accountID: fixed(value.account_id.bytes, 32), nonce: value.nonce)
        }
    }

    static func fee(_ result: UInt64) throws -> CitizenFeeSnapshot {
        try inspect(result, kind: 11) {
            var value = citizensdk_fee_snapshot_info_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_fee_snapshot_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_fee_snapshot(result, &value), "Core fee result is invalid")
            return CitizenFeeSnapshot(bestBlock: try block(value.best_block), feeRateParts: value.fee_rate_parts,
                                      minimumFeeFen: u128(value.minimum_fee_fen),
                                      existentialDepositFen: u128(value.existential_deposit_fen))
        }
    }

    static func profile(_ result: UInt64) throws -> CitizenWalletProfile? {
        try inspect(result, kind: 12) { try walletProfile(result) }
    }

    static func walletState(_ result: UInt64) throws -> CitizenWalletState {
        try inspect(result, kind: 21) {
            var stateInfo = citizensdk_wallet_state_info_t()
            prepare(&stateInfo.struct_size, &stateInfo.abi_version, citizensdk_wallet_state_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_wallet_state(result, &stateInfo),
                                           "Core wallet state is invalid")
            guard stateInfo.account_count <= UInt32(CitizenSDKInputLimits.maximumCatalogAccounts),
                  stateInfo.has_default_account == 0 || stateInfo.has_default_account == 1,
                  (stateInfo.account_count == 0) == (stateInfo.has_default_account == 0) else {
                throw CitizenSDKError(.integrity, "Core wallet state descriptor is inconsistent")
            }
            let accounts = try (0..<stateInfo.account_count).map { index -> CitizenWalletStateAccount in
                var info = citizensdk_wallet_state_account_info_t()
                prepare(&info.struct_size, &info.abi_version, citizensdk_wallet_state_account_info_t.self)
                var ss58Required: UInt64 = 0, nameRequired: UInt64 = 0
                try CitizenSDKChecks.requireOK(
                    citizensdk_result_get_wallet_state_account(result, index, &info, nil, 0,
                                                               &ss58Required, nil, 0, &nameRequired),
                    "Core wallet state account size query failed"
                )
                let pair = try copyPair(ss58Required, nameRequired) { ss58, ss58Capacity, ss58Out,
                                                                       name, nameCapacity, nameOut in
                    citizensdk_result_get_wallet_state_account(result, index, &info, ss58, ss58Capacity,
                                                               ss58Out, name, nameCapacity, nameOut)
                }
                guard let mode = CitizenWalletSignMode(rawValue: info.sign_mode),
                      info.has_account_index == 0 || info.has_account_index == 1,
                      info.is_default == (index == 0 ? 1 : 0),
                      (mode == .hot) == (info.wallet_index == 0 && info.has_account_index == 1),
                      (mode == .cold) == (info.wallet_index != 0 && info.has_account_index == 0) else {
                    throw CitizenSDKError(.integrity, "Core wallet state account is inconsistent")
                }
                return CitizenWalletStateAccount(
                    signMode: mode, walletIndex: info.wallet_index,
                    accountIndex: info.has_account_index == 1 ? info.account_index : nil,
                    accountID: fixed(info.account_id.bytes, 32), ss58Address: try text(pair.0),
                    name: try text(pair.1), createdAtMillis: info.created_at_millis,
                    isDefault: info.is_default == 1
                )
            }
            let coldWalletIndices = accounts.filter { $0.signMode == .cold }.map(\.walletIndex)
            let hotAccountIndices = accounts.filter { $0.signMode == .hot }.compactMap(\.accountIndex)
            guard accounts.allSatisfy({ $0.signMode == .cold || ($0.accountIndex ?? UInt32.max) <= CitizenSDKInputLimits.maximumAccountIndex }),
                  Set(accounts.map(\.accountID)).count == accounts.count,
                  Set(coldWalletIndices).count == coldWalletIndices.count,
                  Set(hotAccountIndices).count == hotAccountIndices.count,
                  stateInfo.has_default_account == 0 || accounts.first?.accountID == fixed(stateInfo.default_account_id.bytes, 32) else {
                throw CitizenSDKError(.integrity, "Core wallet state order or default is inconsistent")
            }
            var profileInfo = citizensdk_wallet_profile_info_t()
            prepare(&profileInfo.struct_size, &profileInfo.abi_version, citizensdk_wallet_profile_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_wallet_profile(result, &profileInfo),
                                           "Core wallet state hot profile is invalid")
            let hotProfile: CitizenWalletProfile?
            if profileInfo.present == 0 {
                hotProfile = nil
            } else {
                guard profileInfo.present == 1,
                      let origin = CitizenWalletOrigin(rawValue: profileInfo.origin) else {
                    throw CitizenSDKError(.integrity, "Core wallet state profile descriptor is invalid")
                }
                let hotAccounts = accounts.filter { $0.signMode == .hot }.map {
                    CitizenWalletAccount(index: $0.accountIndex!, accountID: $0.accountID,
                                         ss58Address: $0.ss58Address, name: $0.name,
                                         createdAtMillis: $0.createdAtMillis,
                                         active: $0.accountID == fixed(profileInfo.active_account_id.bytes, 32))
                }
                let master = fixed(profileInfo.master_account_id.bytes, 32)
                let active = fixed(profileInfo.active_account_id.bytes, 32)
                guard profileInfo.wallet_index == 0,
                      !hotAccounts.isEmpty,
                      hotAccounts.count == Int(profileInfo.account_count),
                      hotAccounts.filter(\.active).count == 1,
                      hotAccounts.contains(where: { $0.active && $0.accountID == active }),
                      hotAccounts.contains(where: { $0.index == 0 && $0.accountID == master }) else {
                    throw CitizenSDKError(.integrity, "Core wallet state hot profile closure drifted")
                }
                hotProfile = CitizenWalletProfile(walletName: try walletName(result), origin: origin, walletIndex: profileInfo.wallet_index,
                                                  createdAtMillis: profileInfo.created_at_millis,
                                                  masterAccountID: master,
                                                  activeAccountID: active,
                                                  accounts: hotAccounts)
            }
            guard hotProfile != nil || accounts.allSatisfy({ $0.signMode == .cold }) else {
                throw CitizenSDKError(.integrity, "Core exposes hot wallet accounts without a profile")
            }
            var diagnosticCount: UInt32 = 0
            try CitizenSDKChecks.requireOK(citizensdk_wallet_state_get_diagnostic_count(result, &diagnosticCount), "诊断数量读取失败")
            guard diagnosticCount <= 1991 else { throw CitizenSDKError(.integrity, "诊断数量越界") }
            var walletIndices = Set(accounts.map(\.walletIndex))
            var accountIDs = Set(accounts.map(\.accountID))
            let diagnostics = try (0..<diagnosticCount).map { index -> CitizenWalletDiagnostic in
                var info = citizensdk_wallet_diagnostic_info_v1_t()
                prepare(&info.struct_size, &info.abi_version, citizensdk_wallet_diagnostic_info_v1_t.self)
                try CitizenSDKChecks.requireOK(citizensdk_wallet_state_get_diagnostic_at(result, index, &info), "诊断读取失败")
                let id = fixed(info.account_id.bytes, 32)
                guard info.has_ss58_address <= 1, info.sign_mode <= 2, (1...3).contains(info.diagnostic_reason),
                      info.cleanup_account_count <= UInt32(CitizenSDKInputLimits.maximumWalletAccounts), info.delete_wallet_wide_key <= 1,
                      info.cleanup_account_count > 0 || info.delete_wallet_wide_key == 0,
                      (1...120).contains(info.wallet_name_len), info.ss58_address_len <= 128,
                      info.has_ss58_address != 0 || info.ss58_address_len == 0,
                      walletIndices.insert(info.wallet_index).inserted, accountIDs.insert(id).inserted else {
                    throw CitizenSDKError(.integrity, "诊断事实不一致")
                }
                let name = try text(copy(info.wallet_name_len) {
                    citizensdk_wallet_state_copy_diagnostic_text(result, index, 1, $0, $1, $2)
                })
                guard try CitizenSDKInputLimits.accountName(name) == name else { throw CitizenSDKError(.integrity, "诊断名称无效") }
                let address: String? = info.has_ss58_address == 0 ? nil : try text(copy(info.ss58_address_len) {
                    citizensdk_wallet_state_copy_diagnostic_text(result, index, 2, $0, $1, $2)
                })
                let cleanupIDs = try (0..<info.cleanup_account_count).map { accountIndex -> Data in
                    var account = citizensdk_account_id_t()
                    try CitizenSDKChecks.requireOK(citizensdk_wallet_state_get_diagnostic_cleanup_account(result, index, accountIndex, &account),
                                                   "清理账户目标复制失败")
                    return fixed(account.bytes, 32)
                }
                guard zip(cleanupIDs, cleanupIDs.dropFirst()).allSatisfy({ $0.0.lexicographicallyPrecedes($0.1) }) else {
                    throw CitizenSDKError(.integrity, "清理账户目标顺序或唯一性无效")
                }
                let targets = cleanupIDs.isEmpty ? nil : CitizenWalletCleanupTargets(accountIDs: cleanupIDs, deleteWalletWideKey: info.delete_wallet_wide_key == 1)
                return CitizenWalletDiagnostic(walletIndex: info.wallet_index, walletName: name, accountID: id,
                    ss58Address: address, diagnosticReason: info.diagnostic_reason,
                    signMode: info.sign_mode == 0 ? nil : CitizenWalletSignMode(rawValue: info.sign_mode), cleanupTargets: targets)
            }
            var initialization: UInt32 = 0
            var cleanup: UInt8 = 0
            try CitizenSDKChecks.requireOK(citizensdk_wallet_state_get_initialization(result, &initialization, &cleanup), "wallet state flags failed")
            guard initialization <= 2, cleanup <= 1,
                  (initialization == 1) == (!accounts.isEmpty || !diagnostics.isEmpty),
                  !(initialization == 0 && cleanup != 0) else {
                throw CitizenSDKError(.integrity, "wallet initialization facts disagree with the catalog")
            }
            var hasSelection: UInt8 = 0
            var selection: UInt32 = 0
            try CitizenSDKChecks.requireOK(citizensdk_wallet_state_get_active_wallet(result, &hasSelection, &selection), "wallet selection failed")
            guard hasSelection <= 1, hasSelection == 1 || selection == 0,
                  hasSelection == 0 || walletIndices.contains(selection) else {
                throw CitizenSDKError(.integrity, "wallet selection is outside the catalog")
            }
            return CitizenWalletState(revision: stateInfo.revision, hotProfile: hotProfile, accounts: accounts,
                                      initializationState: initialization, cleanupPending: cleanup != 0,
                                      activeWalletIndex: hasSelection == 1 ? selection : nil, diagnostics: diagnostics)
        }
    }

    static func accounts(_ result: UInt64) throws -> [CitizenWalletAccount] {
        try inspect(result, kind: 13) { try walletAccounts(result) }
    }

    static func signature(_ result: UInt64) throws -> CitizenSignature {
        try inspect(result, kind: 14) {
            var bytes = Data(count: 64)
            let code = bytes.withUnsafeMutableBytes {
                citizensdk_result_get_signature(result, $0.bindMemory(to: UInt8.self).baseAddress)
            }
            try CitizenSDKChecks.requireOK(code, "Core signature result is invalid")
            return try CitizenSignature(bytes)
        }
    }




    static func signingOutcome(_ result: UInt64) throws -> CitizenSigningOutcome {
        try inspect(result, kind: 22) {
            var info = citizensdk_signing_outcome_info_t()
            prepare(&info.struct_size, &info.abi_version, citizensdk_signing_outcome_info_t.self)
            var signatureRequired: UInt64 = 0
            var sessionRequired: UInt64 = 0
            var requestRequired: UInt64 = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_signing_outcome(
                    result, &info, nil, 0, &signatureRequired, nil, 0,
                    &sessionRequired, nil, 0, &requestRequired),
                "Core signing outcome size query failed"
            )
            guard signatureRequired <= 64, sessionRequired <= 128, requestRequired <= 2_331 else {
                throw CitizenSDKError(.integrity, "Core signing outcome exceeds its limits")
            }
            let values = try copyThree(signatureRequired, sessionRequired, requestRequired) {
                signature, signatureCapacity, signatureOut,
                session, sessionCapacity, sessionOut,
                request, requestCapacity, requestOut in
                citizensdk_result_get_signing_outcome(
                    result, &info, signature, signatureCapacity, signatureOut,
                    session, sessionCapacity, sessionOut,
                    request, requestCapacity, requestOut)
            }
            let accountID = fixed(info.account_id.bytes, 32)
            let payloadHash = fixed(info.payload_hash, 32)
            switch info.status {
            case CITIZENSDK_SIGNING_COMPLETED:
                guard values.0.count == 64, values.1.isEmpty, values.2.isEmpty else {
                    throw CitizenSDKError(.integrity, "Core completed signing outcome is inconsistent")
                }
                return .completed(accountID: accountID, payloadHash: payloadHash,
                                  signature: try CitizenSignature(values.0))
            case CITIZENSDK_SIGNING_EXTERNAL_PENDING:
                guard values.0.isEmpty, (16...128).contains(values.1.count), !values.2.isEmpty,
                      info.transport == CITIZENSDK_EXTERNAL_SIGNER_QR_V1 else {
                    throw CitizenSDKError(.integrity, "Core pending signing outcome is inconsistent")
                }
                return .externalPending(
                    accountID: accountID, payloadHash: payloadHash, transport: .qrV1,
                    expiresAt: info.expires_at, sessionID: try text(values.1),
                    transportRequest: try text(values.2))
            default:
                throw CitizenSDKError(.integrity, "Core returned an unknown signing outcome")
            }
        }
    }

    static func defaultAccountChange(_ result: UInt64) throws -> CitizenDefaultAccountChangeOutcome {
        try inspect(result, kind: 23) {
            var info = citizensdk_default_account_change_info_t()
            prepare(&info.struct_size, &info.abi_version, citizensdk_default_account_change_info_t.self)
            var sessionRequired: UInt64 = 0
            var requestRequired: UInt64 = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_default_account_change(
                    result, &info, nil, 0, &sessionRequired, nil, 0, &requestRequired),
                "Core default-account change size query failed"
            )
            guard sessionRequired <= 128, requestRequired <= 2_331 else {
                throw CitizenSDKError(.integrity, "Core default-account change exceeds its limits")
            }
            let values = try copyPair(sessionRequired, requestRequired) {
                session, sessionCapacity, sessionOut, request, requestCapacity, requestOut in
                citizensdk_result_get_default_account_change(
                    result, &info, session, sessionCapacity, sessionOut,
                    request, requestCapacity, requestOut)
            }
            let current = fixed(info.current_default_account_id.bytes, 32)
            let payloadHash = fixed(info.payload_hash, 32)
            switch info.status {
            case CITIZENSDK_SIGNING_COMPLETED:
                guard values.0.isEmpty, values.1.isEmpty else {
                    throw CitizenSDKError(.integrity, "Core completed default-account change is inconsistent")
                }
                return .completed(currentDefaultAccountID: current, payloadHash: payloadHash,
                                  committedRevision: info.committed_revision)
            case CITIZENSDK_SIGNING_EXTERNAL_PENDING:
                guard (16...128).contains(values.0.count), !values.1.isEmpty,
                      info.transport == CITIZENSDK_EXTERNAL_SIGNER_QR_V1 else {
                    throw CitizenSDKError(.integrity, "Core pending default-account change is inconsistent")
                }
                return .externalPending(
                    currentDefaultAccountID: current, payloadHash: payloadHash, transport: .qrV1,
                    expiresAt: info.expires_at, sessionID: try text(values.0),
                    transportRequest: try text(values.1))
            default:
                throw CitizenSDKError(.integrity, "Core returned an unknown default-account change outcome")
            }
        }
    }

    static func preparedWallet(_ result: UInt64) throws -> UInt64 {
        try inspect(result, kind: 15) {
            var value = citizensdk_prepared_wallet_info_t()
            prepare(&value.struct_size, &value.abi_version, citizensdk_prepared_wallet_info_t.self)
            try CitizenSDKChecks.requireOK(citizensdk_result_get_prepared_wallet(result, &value), "Core prepared wallet result is invalid")
            guard value.prepared_wallet != 0 else { throw CitizenSDKError(.integrity, "Core returned an empty prepared wallet") }
            return value.prepared_wallet
        }
    }

    static func preparedTransaction(_ result: UInt64) throws
        -> (UInt64, CitizenPreparedTransaction) {
        try inspect(result, kind: 27) {
            var value = citizensdk_prepared_transaction_info_t()
            prepare(
                &value.struct_size,
                &value.abi_version,
                citizensdk_prepared_transaction_info_t.self
            )
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_prepared_transaction(result, &value),
                "Core prepared transaction result is invalid"
            )
            let identifier = fixed(value.preparation_id, 16)
                .map { String(format: "%02x", $0) }.joined()
            let best = try block(value.best_block)
            guard value.prepared_transaction != 0, best.finality == .best else {
                throw CitizenSDKError(.integrity, "Core prepared transaction ownership is invalid")
            }
            return (
                value.prepared_transaction,
                CitizenPreparedTransaction(
                    preparationID: "0x" + identifier,
                    sourceAccountID: fixed(value.source_account_id.bytes, 32),
                    callDataHash: fixed(value.call_data_hash, 32),
                    bestBlock: best,
                    runtimeSpecNumber: value.runtime_spec_number,
                    transactionFormatNumber: value.transaction_format_number,
                    nonce: value.nonce
                )
            )
        }
    }

    static func transactionExecution(_ result: UInt64) throws -> CitizenTransactionExecution {
        try inspect(result, kind: 28) {
            var info = citizensdk_transaction_execution_info_t()
            prepare(&info.struct_size, &info.abi_version, citizensdk_transaction_execution_info_t.self)
            var sessionRequired: UInt64 = 0, requestRequired: UInt64 = 0, reasonRequired: UInt64 = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_transaction_execution(
                    result, &info, nil, 0, &sessionRequired, nil, 0, &requestRequired,
                    nil, 0, &reasonRequired),
                "Core transaction execution size query failed"
            )
            guard sessionRequired <= 128, requestRequired <= 2_331, reasonRequired <= 4_096 else {
                throw CitizenSDKError(.integrity, "Core transaction execution text exceeds limits")
            }
            let textValues = try copyThree(sessionRequired, requestRequired, reasonRequired) {
                session, sessionCapacity, sessionOut, request, requestCapacity, requestOut,
                reason, reasonCapacity, reasonOut in
                citizensdk_result_get_transaction_execution(
                    result, &info, session, sessionCapacity, sessionOut,
                    request, requestCapacity, requestOut, reason, reasonCapacity, reasonOut)
            }
            let id = "0x" + fixed(info.execution_id, 16).map { String(format: "%02x", $0) }.joined()
            let source = fixed(info.source_account_id.bytes, 32)
            let callHash = fixed(info.call_data_hash, 32)
            switch info.status {
            case CITIZENSDK_TRANSACTION_EXECUTION_EXTERNAL_PENDING:
                guard info.transport == CITIZENSDK_EXTERNAL_SIGNER_QR_V1,
                      info.expires_at > 0, !textValues.1.isEmpty else {
                    throw CitizenSDKError(.integrity, "Core external execution is invalid")
                }
                return .externalSigningPending(CitizenTransactionExternalSigningPending(
                    executionID: id, sourceAccountID: source, callDataHash: callHash,
                    expiresAt: info.expires_at, qrRequest: try text(textValues.1)))
            case CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS,
                 CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_FAILED:
                let status: CitizenExecutionStatus = info.status == CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS ? .success : .failed
                let execution = CitizenExecution(
                    status: status, reasonOrDispatchVariant: info.dispatch_variant,
                    block: info.has_block == 0 ? nil : try block(info.block),
                    extrinsicIndex: info.has_extrinsic_index == 0 ? nil : info.extrinsic_index,
                    palletIndex: info.has_module_failure == 0 ? nil : UInt8(info.pallet_index),
                    errorIndex: info.has_module_failure == 0 ? nil : UInt8(info.error_index))
                return .completed(CitizenTransactionExecutionCompleted(
                    executionID: id, sourceAccountID: source, callDataHash: callHash,
                    transactionHash: fixed(info.transaction_hash, 32),
                    resolution: status == .success ? .finalizedSuccess : .finalizedFailed,
                    execution: execution, poolRejectionReason: nil, replacementHash: nil))
            case CITIZENSDK_TRANSACTION_EXECUTION_POOL_REJECTED:
                guard !textValues.2.isEmpty else {
                    throw CitizenSDKError(.integrity, "Core pool rejection reason is empty")
                }
                return .completed(CitizenTransactionExecutionCompleted(
                    executionID: id, sourceAccountID: source, callDataHash: callHash,
                    transactionHash: fixed(info.transaction_hash, 32), resolution: .poolRejected,
                    execution: nil, poolRejectionReason: try text(textValues.2),
                    replacementHash: info.has_replacement_hash == 0 ? nil : fixed(info.replacement_hash, 32)))
            default:
                throw CitizenSDKError(.integrity, "Core transaction execution status is unknown")
            }
        }
    }

    static func transactionHistoryPage(_ result: UInt64) throws -> CitizenTransactionHistoryPage {
        try inspect(result, kind: 17) {
            var info = citizensdk_transaction_history_page_info_t()
            prepare(&info.struct_size, &info.abi_version,
                    citizensdk_transaction_history_page_info_t.self)
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_transaction_history_page(result, &info),
                "Core transaction history page is invalid")
            guard info.record_count <= 100,
                  info.has_next_before_execution_id == 0 || info.has_next_before_execution_id == 1 else {
                throw CitizenSDKError(.integrity, "Core transaction history page exceeds the public contract")
            }
            let records = try (0..<info.record_count).map { try transactionHistoryRecord(result, $0) }
            let next = info.has_next_before_execution_id == 0 ? nil
                : executionID(info.next_before_execution_id)
            return CitizenTransactionHistoryPage(
                revision: info.revision,
                records: records,
                nextBeforeExecutionID: next)
        }
    }

    static func capabilities(_ snapshot: citizensdk_capability_snapshot_t) throws -> CitizenSDKCapabilities {
        guard snapshot.struct_size >= UInt32(MemoryLayout<citizensdk_capability_snapshot_t>.size),
              snapshot.abi_version == 1, snapshot.count == 10 else {
            throw CitizenSDKError(.integrity, "Core capability snapshot ABI is invalid")
        }
        let statuses: [CitizenCapabilityStatus] = try withUnsafeBytes(of: snapshot.statuses) { bytes in
            let typed = bytes.bindMemory(to: citizensdk_capability_status_t.self)
            guard typed.count >= 10 else { throw CitizenSDKError(.integrity, "Core capability tuple is truncated") }
            return try (0..<10).map { index in
                let value = typed[index]
                guard let name = CitizenCapabilityName(rawValue: value.name),
                      let reason = CitizenCapabilityReason(rawValue: value.reason) else {
                    throw CitizenSDKError(.integrity, "Core returned an unknown capability value")
                }
                return CitizenCapabilityStatus(name: name, reason: reason, supported: try boolean(value.supported),
                                               available: try boolean(value.available), enabled: try boolean(value.enabled),
                                               ready: try boolean(value.ready))
            }
        }
        guard Set(statuses.map(\.name)).count == 10 else {
            throw CitizenSDKError(.integrity, "Core capability snapshot contains duplicate names")
        }
        return CitizenSDKCapabilities(revision: snapshot.revision, statuses: statuses)
    }

    private static func inspect<T>(_ result: UInt64, kind: UInt32, body: () throws -> T) throws -> T {
        var info = citizensdk_result_info_t()
        prepare(&info.struct_size, &info.abi_version, citizensdk_result_info_t.self)
        try CitizenSDKChecks.requireOK(citizensdk_result_get_info(result, &info), "Core result identity is invalid")
        if info.error_code != 0 {
            var rawStage: citizensdk_failure_stage_t = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_failure_stage(result, &rawStage),
                "Core failure stage is invalid"
            )
            guard let stage = CitizenSDKFailureStage(rawValue: rawStage) else {
                throw CitizenSDKError(.integrity, "Core returned an unknown failure stage")
            }
            let message = try resultErrorMessage(result)
            throw CitizenSDKError(
                .checked(info.error_code),
                message.isEmpty ? "CitizenSDK operation failed" : message,
                stage: stage
            )
        }
        guard info.kind == kind else {
            throw CitizenSDKError(.integrity, "Core returned result kind \(info.kind), expected \(kind)")
        }
        return try body()
    }

    private static func resultErrorMessage(_ result: UInt64) throws -> String {
        var required: UInt64 = 0
        try CitizenSDKChecks.requireOK(citizensdk_result_copy_error_message(result, nil, 0, &required), "Core error text query failed")
        return try text(copy(required) { citizensdk_result_copy_error_message(result, $0, $1, $2) })
    }

    /// 名称必须来自同一结果，复制前按公开名称容量限定，不能二次读取当前目录。
    private static func walletName(_ result: UInt64) throws -> String {
        var required: UInt64 = 0
        try CitizenSDKChecks.requireOK(citizensdk_wallet_profile_copy_name(result, nil, 0, &required), "wallet name size query failed")
        guard (1...120).contains(required) else { throw CitizenSDKError(.integrity, "wallet name size is invalid") }
        return try text(copy(required) { citizensdk_wallet_profile_copy_name(result, $0, $1, $2) })
    }

    private static func walletProfile(_ result: UInt64) throws -> CitizenWalletProfile? {
        var info = citizensdk_wallet_profile_info_t()
        prepare(&info.struct_size, &info.abi_version, citizensdk_wallet_profile_info_t.self)
        try CitizenSDKChecks.requireOK(citizensdk_result_get_wallet_profile(result, &info), "Core wallet profile is invalid")
        guard info.present == 0 || info.present == 1 else { throw CitizenSDKError(.integrity, "Core profile presence is invalid") }
        if info.present == 0 { return nil }
        guard info.account_count <= UInt32(CitizenSDKInputLimits.maximumWalletAccounts), let origin = CitizenWalletOrigin(rawValue: info.origin) else {
            throw CitizenSDKError(.integrity, "Core wallet profile descriptor is invalid")
        }
        let accounts = try walletAccounts(result)
        guard accounts.count == Int(info.account_count) else { throw CitizenSDKError(.integrity, "Core wallet account count drifted") }
        return CitizenWalletProfile(walletName: try walletName(result), origin: origin, walletIndex: info.wallet_index,
                                    createdAtMillis: info.created_at_millis,
                                    masterAccountID: fixed(info.master_account_id.bytes, 32),
                                    activeAccountID: fixed(info.active_account_id.bytes, 32), accounts: accounts)
    }

    private static func walletAccounts(_ result: UInt64) throws -> [CitizenWalletAccount] {
        var count: UInt32 = 0
        try CitizenSDKChecks.requireOK(citizensdk_result_get_wallet_account_count(result, &count), "Core wallet account count is invalid")
        guard count <= UInt32(CitizenSDKInputLimits.maximumWalletAccounts) else { throw CitizenSDKError(.integrity, "Core wallet account count exceeds the contract") }
        return try (0..<count).map { index in
            var info = citizensdk_wallet_account_info_t()
            prepare(&info.struct_size, &info.abi_version, citizensdk_wallet_account_info_t.self)
            var ss58Required: UInt64 = 0
            var nameRequired: UInt64 = 0
            try CitizenSDKChecks.requireOK(
                citizensdk_result_get_wallet_account(result, index, &info, nil, 0, &ss58Required, nil, 0, &nameRequired),
                "Core wallet account size query failed"
            )
            let pair = try copyPair(ss58Required, nameRequired) { ss58, ss58Capacity, ss58Out, name, nameCapacity, nameOut in
                citizensdk_result_get_wallet_account(result, index, &info, ss58, ss58Capacity, ss58Out,
                                                     name, nameCapacity, nameOut)
            }
            guard (info.is_active == 0 || info.is_active == 1), info.index <= CitizenSDKInputLimits.maximumAccountIndex else { throw CitizenSDKError(.integrity, "Core wallet active flag is invalid") }
            return CitizenWalletAccount(index: info.index, accountID: fixed(info.account_id.bytes, 32),
                                        ss58Address: try text(pair.0), name: pair.1.isEmpty ? nil : try text(pair.1),
                                        createdAtMillis: info.created_at_millis, active: info.is_active == 1)
        }
    }

    private static func transactionHistoryRecord(_ result: UInt64, _ index: UInt32) throws
        -> CitizenTransactionHistoryRecord {
        var info = citizensdk_transaction_history_record_info_t()
        prepare(&info.struct_size, &info.abi_version,
                citizensdk_transaction_history_record_info_t.self)
        var reasonRequired: UInt64 = 0
        try CitizenSDKChecks.requireOK(
            citizensdk_result_get_transaction_history_record(
                result, index, &info, nil, 0, &reasonRequired),
            "Core transaction history record size query failed"
        )
        guard reasonRequired <= 4_096 else {
            throw CitizenSDKError(.integrity, "Core transaction history reason exceeds the public contract")
        }
        let reason = try copy(reasonRequired) { pointer, capacity, outRequired in
            citizensdk_result_get_transaction_history_record(
                result, index, &info, pointer, capacity, outRequired)
        }
        guard let status = CitizenTransactionHistoryStatus(rawValue: info.status),
              info.has_block == 0 || info.has_block == 1,
              info.has_execution == 0 || info.has_execution == 1,
              info.has_replacement_hash == 0 || info.has_replacement_hash == 1 else {
            throw CitizenSDKError(.integrity, "Core history status is invalid")
        }
        return CitizenTransactionHistoryRecord(
            executionID: executionID(info.execution_id),
            sourceAccountID: fixed(info.source_account_id.bytes, 32),
            callDataHash: fixed(info.call_data_hash, 32),
            transactionHash: fixed(info.transaction_hash, 32), status: status,
            block: info.has_block == 0 ? nil : try block(info.block),
            execution: info.has_execution == 0 ? nil : try execution(info.execution),
            replacementHash: info.has_replacement_hash == 0 ? nil : fixed(info.replacement_hash, 32),
            createdAtMillis: info.created_at_millis, updatedAtMillis: info.updated_at_millis,
            poolRejectionReason: reason.isEmpty ? nil : try text(reason)
        )
    }

    private static func executionID(_ value: citizensdk_transaction_execution_id_t) -> String {
        "0x" + fixed(value.bytes, 16).map { String(format: "%02x", $0) }.joined()
    }

    private static func block(_ value: citizensdk_block_ref_t) throws -> CitizenBlockRef {
        guard value.struct_size >= UInt32(MemoryLayout<citizensdk_block_ref_t>.size), value.abi_version == 1,
              let finality = CitizenFinality(rawValue: value.finality) else {
            throw CitizenSDKError(.integrity, "Core block reference ABI is invalid")
        }
        return try CitizenBlockRef(hash: fixed(value.hash, 32), number: value.number, finality: finality)
    }

    private static func execution(_ value: citizensdk_execution_info_t) throws -> CitizenExecution {
        guard value.struct_size >= UInt32(MemoryLayout<citizensdk_execution_info_t>.size), value.abi_version == 1,
              let status = CitizenExecutionStatus(rawValue: value.status) else {
            throw CitizenSDKError(.integrity, "Core execution descriptor is invalid")
        }
        return CitizenExecution(status: status, reasonOrDispatchVariant: value.reason_or_dispatch_variant,
                                block: value.has_block == 0 ? nil : try block(value.block),
                                extrinsicIndex: value.has_extrinsic_index == 0 ? nil : value.extrinsic_index,
                                palletIndex: value.has_module == 0 ? nil : value.pallet_index,
                                errorIndex: value.has_module == 0 ? nil : value.error_index)
    }

    private static func u128(_ value: citizensdk_u128_t) -> CitizenU128 {
        CitizenU128(low: value.low, high: value.high)
    }

    private static func prepare<T>(_ size: inout UInt32, _ version: inout UInt32, _ type: T.Type) {
        size = UInt32(MemoryLayout<T>.size)
        version = 1
    }

    private static func fixed<T>(_ value: T, _ count: Int) -> Data {
        withUnsafeBytes(of: value) { Data($0.prefix(count)) }
    }

    private static func boolean(_ value: UInt8) throws -> Bool {
        guard value == 0 || value == 1 else { throw CitizenSDKError(.integrity, "Core boolean is invalid") }
        return value == 1
    }

    private static func text(_ data: Data) throws -> String {
        guard let value = String(data: data, encoding: .utf8) else { throw CitizenSDKError(.integrity, "Core UTF-8 text is invalid") }
        return value
    }

    private static func copy(_ required: UInt64,
                             call: (UnsafeMutablePointer<UInt8>?, UInt64, UnsafeMutablePointer<UInt64>) -> Int32) throws -> Data {
        guard required <= UInt64(Int.max) else { throw CitizenSDKError(.integrity, "Core byte result is too large") }
        var output = Data(count: Int(required))
        var confirmed = required
        let code = output.withUnsafeMutableBytes {
            call($0.bindMemory(to: UInt8.self).baseAddress, UInt64($0.count), &confirmed)
        }
        try CitizenSDKChecks.requireOK(code, "Core byte result copy failed")
        guard confirmed == required else { throw CitizenSDKError(.integrity, "Core byte result length changed") }
        return output
    }

    private static func copyPair(
        _ first: UInt64, _ second: UInt64,
        call: (UnsafeMutablePointer<UInt8>?, UInt64, UnsafeMutablePointer<UInt64>,
               UnsafeMutablePointer<UInt8>?, UInt64, UnsafeMutablePointer<UInt64>) -> Int32
    ) throws -> (Data, Data) {
        guard first <= UInt64(Int.max), second <= UInt64(Int.max) else { throw CitizenSDKError(.integrity, "Core pair result is too large") }
        var a = Data(count: Int(first)), b = Data(count: Int(second))
        var ac = first, bc = second
        let code = a.withUnsafeMutableBytes { ap in b.withUnsafeMutableBytes { bp in
            call(ap.bindMemory(to: UInt8.self).baseAddress, UInt64(ap.count), &ac,
                 bp.bindMemory(to: UInt8.self).baseAddress, UInt64(bp.count), &bc)
        } }
        try CitizenSDKChecks.requireOK(code, "Core pair result copy failed")
        guard ac == first, bc == second else { throw CitizenSDKError(.integrity, "Core pair result length changed") }
        return (a, b)
    }

    private static func copyThree(
        _ first: UInt64, _ second: UInt64, _ third: UInt64,
        call: (UnsafeMutablePointer<UInt8>?, UInt64, UnsafeMutablePointer<UInt64>,
               UnsafeMutablePointer<UInt8>?, UInt64, UnsafeMutablePointer<UInt64>,
               UnsafeMutablePointer<UInt8>?, UInt64, UnsafeMutablePointer<UInt64>) -> Int32
    ) throws -> (Data, Data, Data) {
        guard first <= UInt64(Int.max), second <= UInt64(Int.max), third <= UInt64(Int.max) else {
            throw CitizenSDKError(.integrity, "Core triple result is too large")
        }
        var a = Data(count: Int(first)), b = Data(count: Int(second)), c = Data(count: Int(third))
        var ac = first, bc = second, cc = third
        let code = a.withUnsafeMutableBytes { ap in b.withUnsafeMutableBytes { bp in c.withUnsafeMutableBytes { cp in
            call(ap.bindMemory(to: UInt8.self).baseAddress, UInt64(ap.count), &ac,
                 bp.bindMemory(to: UInt8.self).baseAddress, UInt64(bp.count), &bc,
                 cp.bindMemory(to: UInt8.self).baseAddress, UInt64(cp.count), &cc)
        } } }
        try CitizenSDKChecks.requireOK(code, "Core triple result copy failed")
        guard ac == first, bc == second, cc == third else { throw CitizenSDKError(.integrity, "Core triple result length changed") }
        return (a, b, c)
    }
}
