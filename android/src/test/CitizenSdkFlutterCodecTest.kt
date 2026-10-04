package org.citizen.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class CitizenSdkFlutterCodecTest {
    @Test
    fun inspectionFactsAndOwnedRequestsNeverConstructNormalAccounts() {
        val id = ByteArray(32) { 1 }
        val diagnostic = CitizenWalletDiagnostic(0, "异常", id, null, 3, CitizenWalletSignMode.HOT,
            CitizenWalletCleanupTargets(listOf(id, ByteArray(32) { 2 }), true))
        val state = CitizenWalletState("7", null, emptyList(), 1, false, 0, listOf(diagnostic))
        val tuple = CitizenSdkFlutterCodec.walletState(state)
        assertEquals(7, tuple.size)
        val record = (tuple[6] as List<*>).single() as List<*>
        assertEquals(7, record.size); assertEquals("hot", record[5]); assertNull(record[3])
        for (method in listOf("repairHotWallet", "deleteDiagnosticWallet", "renameDiagnosticWallet")) {
            val fields = listOf(2, "sdk", 1L, "inspection-owned", 0xffffffffL) +
                if (method == "renameDiagnosticWallet") listOf("名字") else emptyList()
            val request = CitizenSdkFlutterCodec.decode(method, fields) as CitizenSdkFlutterCodec.Request.WalletInspection
            assertEquals("inspection-owned", request.resourceId); assertEquals(0xffffffffL, request.walletIndex)
            assertEquals(method, CitizenSdkFlutterCodec.requestMethod(request))
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) { CitizenSdkFlutterCodec.decode(method, fields + true) }
        }
        val copy = diagnostic.cleanupTargets!!.accountIds()
        copy[0][0] = 99
        assertEquals(1.toByte(), diagnostic.cleanupTargets!!.accountIds()[0][0])
    }

    @Test
    fun `wallet metadata keeps revision wallet index and name independent`() {
        val select = CitizenSdkFlutterCodec.decode("setActiveWallet", listOf(2, "sdk", 1L, "18446744073709551615", 0xffffffffL))
            as CitizenSdkFlutterCodec.Request.WalletMetadata
        assertEquals("18446744073709551615", select.expectedRevision)
        assertEquals(0xffffffffL, select.walletIndex)
        assertNull(select.name)
        assertEquals("setActiveWallet", CitizenSdkFlutterCodec.requestMethod(select))
        val rename = CitizenSdkFlutterCodec.decode("renameWallet", listOf(2, "sdk", 2L, "7", 0, "钱包名"))
            as CitizenSdkFlutterCodec.Request.WalletMetadata
        assertEquals("钱包名", rename.name)
        for (tuple in listOf(listOf(2, "sdk", 3L, "01", 0), listOf(2, "sdk", 3L, "1", -1),
            listOf(2, "sdk", 3L, "1", 0x100000000L), listOf(2, "sdk", 3L, "1", 0, "extra"))) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) { CitizenSdkFlutterCodec.decode("setActiveWallet", tuple) }
        }
        for (name in listOf("", " bad", "名".repeat(31))) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("renameWallet", listOf(2, "sdk", 4L, "1", 0, name))
            }
        }
        val account = CitizenWalletAccount(0, ByteArray(32) { 1 }, "address", "账户名", "1", true)
        val profile = CitizenWalletProfile(CitizenWalletOrigin.CREATED, 0, "1", ByteArray(32) { 1 },
            ByteArray(32) { 1 }, listOf(account), "钱包名")
        val projected = CitizenSdkFlutterCodec.profile(profile)!!
        assertEquals(7, projected.size)
        assertEquals("钱包名", projected[6])
        val state = CitizenSdkFlutterCodec.walletState(CitizenWalletState("1", null, emptyList(), 0, false, null))
        assertEquals(7, state.size)
        assertNull(state[5])
    }

    @Test
    fun `non consuming response validation has exactly two owned fields`() {
        val request = CitizenSdkFlutterCodec.decode("qrValidateSignResponse",
            listOf(2, "sdk", 1L, "request", "{}")) as CitizenSdkFlutterCodec.Request.Qr
        assertEquals(listOf("request", "{}"), request.fields)
        for (fields in listOf(listOf(2, "sdk", 2L, "", "{}"),
                listOf(2, "sdk", 2L, "request", "{}", 100L),
                listOf(2, "sdk", 2L, "x".repeat(129), "{}"))) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("qrValidateSignResponse", fields)
            }
        }
    }

    @Test
    fun `encoding methods keep exact stateless and session tuple boundaries`() {
        val payload = CitizenSdkFlutterCodec.decode("encodeSigningPayload", listOf(2, 1, "{\"op_tag\":16}", byteArrayOf()))
            as CitizenSdkFlutterCodec.Request.EncodePayload
        assertNull(payload.sessionId)
        assertEquals(0L, payload.requestSequence)
        assertEquals(1, payload.kind)
        val document = CitizenSdkFlutterCodec.decode("qrEncodeDocument", listOf(2, "s", 1L, "{}")) as CitizenSdkFlutterCodec.Request.Qr
        assertEquals(listOf("{}"), document.fields)
        val authorization = CitizenSdkFlutterCodec.decode("qrPrepareAccountAuthorization", listOf(2, "s", 2L, 10, byteArrayOf(), "")) as CitizenSdkFlutterCodec.Request.Qr
        assertEquals(10, authorization.fields[0])
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("qrPrepareAccountAuthorization", listOf(2, "s", 3L, 10, ByteArray(1921), ""))
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("encodeSigningPayload", listOf(2, 7, "{}", byteArrayOf()))
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("encodeSigningPayload", listOf(1, 1, "{}", byteArrayOf()))
        }
    }
    @Test
    fun headlessQrRoutesRejectClocksSignaturesAndRetiredMethods() {
        CitizenSdkFlutterCodec.decode("openQrCapture", listOf(2, "session", 1L, 1))
        for (method in listOf("qrParse", "qrConsumeSignResponse", "reviewQrRequest")) {
            CitizenSdkFlutterCodec.decode(method, listOf(2, "session", 2L, "{}"))
            for (extra in listOf(123L, ByteArray(64))) assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(method, listOf(2, "session", 2L, "{}", extra))
            }
        }
        CitizenSdkFlutterCodec.decode("signQrRequest", listOf(2, "session", 2L, "owned"))
        for (method in listOf("qrScan", "viewAccountPrivateKey", "createWallet", "initializeWallet", "qrSigningInput", "qrCreateSignResponse", "qrEncodeImage")) {
            assertEquals(false, CitizenSdkFlutterCodec.methods.contains(method))
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(method, listOf(2, "session", 3L, "{}"))
            }
        }
    }

    @Test
    fun `private key view carries one public account and rejects any additional field`() {
        val account = "0x" + "11".repeat(32)
        val request = CitizenSdkFlutterCodec.decode("openPrivateKey", listOf(2, "session", 7L, account))
            as CitizenSdkFlutterCodec.Request.Account
        assertEquals("session", request.sessionId); assertEquals(7L, request.requestSequence)
        assertEquals(account, CitizenSdkFlutterCodec.encodeHash32(request.accountId))
        for (tuple in listOf(listOf(2, "session", 7L), listOf(2, "session", 7L, account, "extra"),
            listOf(2, "session", 7L, "0X" + "11".repeat(32)))) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("openPrivateKey", tuple)
            }
        }
    }

    @Test
    fun `chain queries retain session shape and batch order duplicates and empty input`() {
        val first = "0x" + "11".repeat(32)
        val second = "0x" + "22".repeat(32)
        val genesis = CitizenSdkFlutterCodec.decode("getGenesisHash", listOf(2, "session", 7L))
        assertEquals("session", genesis.sessionId)
        assertEquals(7L, genesis.requestSequence)
        for (accounts in listOf(emptyList(), listOf(second, first, second), List(1990) { first })) {
            val request = CitizenSdkFlutterCodec.decode("getAccountBalances", listOf(2, "session", 8L, accounts))
                as CitizenSdkFlutterCodec.Request.Balances
            assertEquals(accounts, request.accountIds.map(CitizenSdkFlutterCodec::encodeHash32))
            assertEquals("session", request.sessionId)
            assertEquals(8L, request.requestSequence)
        }
        for (tuple in listOf(
            listOf(2, "session", 8L, List(1991) { first }),
            listOf(2, "session", 8L, listOf("0x" + "AA".repeat(32))),
            listOf(2, "session", 8L, first), listOf(2, "session", 8L, emptyList<String>(), "extra"),
        )) {
            val failure = assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("getAccountBalances", tuple)
            }
            assertEquals("session", failure.sessionId)
            assertEquals(8L, failure.requestSequence)
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("getGenesisHash", listOf(2, "session", 7L, "extra"))
        }
    }

    @Test
    fun `open carries modules without replicating Core dependency rules`() {
        for (modules in listOf(1, 2, 4, 12, 20, 31, 32, 63)) {
            val request = CitizenSdkFlutterCodec.decode("open", listOf(2, modules, false)) as CitizenSdkFlutterCodec.Request.Open
            assertEquals(modules, request.modules)
        }
        for (tuple in listOf(listOf(1, 31, false), listOf(2), listOf(2, 31), listOf(2, true, false), listOf(2, 1.0, false), listOf(2, -1, false),
            listOf(2, 4294967296L, false), listOf(2, 31, 0))) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("open", tuple)
            }
        }
    }

    @Test
    fun `verify has a fixed public signature and permits an empty message`() {
        val prefix = listOf(2, "0x" + "11".repeat(32))
        for (length in listOf(0, 63, 65)) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("verifySignature", prefix + listOf(ByteArray(length), byteArrayOf()))
            }
        }
        val request = CitizenSdkFlutterCodec.decode("verifySignature",
            prefix + listOf(ByteArray(64), byteArrayOf())) as CitizenSdkFlutterCodec.Request.VerifySignature
        assertEquals(64, request.signature.size)
        assertEquals(0, request.payload.size)
        assertNull(request.sessionId)
        assertEquals(0L, request.requestSequence)
    }

    @Test
    fun `verify rejects session shape and invalid public values without session identity`() {
        val account = "0x" + "11".repeat(32)
        val signature = ByteArray(64)
        for (tuple in listOf(
            listOf(2, "session", 7L, account, signature, byteArrayOf()),
            listOf(true, account, signature, byteArrayOf()),
            listOf(2, "0X" + "11".repeat(32), signature, byteArrayOf()),
            listOf(2, account, List(64) { 0 }, byteArrayOf()),
            listOf(2, account, signature, listOf(1, 2)),
            listOf(2, account, signature, byteArrayOf(), "extra"),
        )) {
            val failure = assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode("verifySignature", tuple)
            }
            assertNull(failure.sessionId)
            assertNull(failure.requestSequence)
        }
    }

    @Test
    fun `history invalidation has no payload`() {
        assertEquals("walletChanged", CitizenSdkFlutterCodec.event("session", 7L, "walletChanged", emptyList())[3])
        assertThrows(IllegalArgumentException::class.java) {
            CitizenSdkFlutterCodec.event("session", 0L, "walletChanged", emptyList())
        }
        assertThrows(IllegalArgumentException::class.java) {
            CitizenSdkFlutterCodec.event("session", 7L, "walletChanged", listOf(1))
        }
        assertEquals("historyChanged", CitizenSdkFlutterCodec.event("session", 7L, "historyChanged", emptyList())[3])
        assertThrows(IllegalArgumentException::class.java) {
            CitizenSdkFlutterCodec.event("session", 0L, "historyChanged", emptyList())
        }
        assertThrows(IllegalArgumentException::class.java) {
            CitizenSdkFlutterCodec.event("session", 7L, "historyChanged", listOf(1))
        }
    }

    @Test
    fun `finalized event is a one-block public tuple`() {
        val payload = listOf(listOf("0x" + "11".repeat(32), "7", "finalized"))
        assertEquals(
            "finalizedBlockChanged",
            CitizenSdkFlutterCodec.event("session", 8L, "finalizedBlockChanged", payload)[3],
        )
        assertThrows(IllegalArgumentException::class.java) {
            CitizenSdkFlutterCodec.event("session", 8L, "finalizedBlockChanged", emptyList())
        }
    }
    @Test
    fun `wallet word count closure is exactly twelve eighteen twenty four`() {
        for (count in listOf(12, 18, 24)) {
            val request = CitizenSdkFlutterCodec.decode("prepareWalletCreation", listOf(2, "session", 1L, count, ""))
                as CitizenSdkFlutterCodec.Request.WalletInput
            assertEquals(count, request.wordCount)
        }
        for (count in listOf(0, 15, 21, 30)) assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("prepareWalletCreation", listOf(2, "session", 1L, count, ""))
        }
    }

    @Test
    fun `v2 method and channel closure is exact`() {
        assertEquals("citizen/sdk/core/v2", CitizenSdkFlutterCodec.METHOD_CHANNEL)
        assertEquals("citizen/sdk/events/v2", CitizenSdkFlutterCodec.EVENT_CHANNEL)
        assertEquals(2, CitizenSdkFlutterCodec.PROTOCOL_VERSION)
        assertEquals(
            linkedSetOf(
                "open",
                "start",
                "stop",
                "close",
                "getCapabilities",
                "getFinalizedHead",
                "getSyncStatus",
                "getBestHead",
                "getFinalizedBlockAt",
                "resolveFinalizedBlock",
                "getBlockHeader",
                "getBlockBody",
                "getRuntimeContext",
                "getStorage",
                "getStorageBatch",
                "getStorageKeysPaged",
                "callRuntimeApi",
                "getSystemEvents",
                "exportState",
                "importState",
                "getGenesisHash",
                "getAccountBalance",
                "getAccountBalances",
                "getAccountNonce",
                "getFeeSnapshot",
                "getWalletState",
                "inspectWallets",
                "releaseWalletInspection",
                "repairHotWallet",
                "renameDiagnosticWallet",
                "deleteDiagnosticWallet",
                "validateWalletPassword",
                "validateWalletMnemonic",
                "walletWordSuggestions",
                "prepareWalletCreation",
                "copyRecoveryPhrase",
                "commitWalletCreation",
                "releasePreparedWallet",
                "openPrivateKey",
                "revealPrivateKey",
                "closePrivateKey",
                "cancelOperation",
                "respondCredential",
                "cancelCredential",
                "addNextWalletAccount",
                "signAndDeleteWallet",
                "importColdAccountCode",
                "importColdAccountId",
                "importColdAccountSs58",
                "reorderWalletAccountsWithoutDefaultChange",
                "setActiveWallet",
                "renameWallet",
                "renameAccount",
                "deleteAccount",
                "importWallet",
                "addWalletAccounts",
                "setActiveWalletAccount",
                "deleteWallet",
                "reconcileWalletCleanup",
                "signWalletPayload",
                "deriveApplicationKey",
                "deriveApplicationKeys",
                "prepareApplicationKeys",
                "beginSigning",
                "consumeExternalSignature",
                "cancelSigning",
                "beginDefaultAccountChange",
                "consumeDefaultAccountChange",
                "verifySignature",
                "encodeSigningPayload",
                "qrEncodeDocument",
                "qrPrepareAccountAuthorization",
                "prepareTransaction",
                "cancelPreparedTransaction",
                "executePreparedTransaction",
                "consumePreparedTransactionQrResponse",
                "cancelPreparedTransactionExecution",
                "getTransactionHistory",
                "syncTransactionHistory",
                "qrParse",
                "qrCreateSignRequest",
                "qrValidateSignResponse",
                "qrConsumeSignResponse",
                "qrCancelSignRequest",
                "qrEncodeAccountId",
                "qrDecodeLuminance",
                "qrEncode",
                "reviewQrRequest",
                "releaseQrReview",
                "openQrCapture",
                "closeQrCapture",
                "pauseQrCapture",
                "resumeQrCapture",
                "setQrCaptureTorch",
                "qrDecodeImage",
                "signQrRequest",
            ),
            CitizenSdkFlutterCodec.methods,
        )
    }

    @Test
    fun `requests reject extra secret and native ownership fields`() {
        // Fixed-position tuples have no field in which any of these values can
        // be represented. Every appended value is rejected by exact length.
        for (forbidden in listOf("mnemonic", "password", "privateKey", "nativeHandle")) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(
                    "importWallet",
                    listOf(2, "session-1", 1L, forbidden),
                )
            }
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("open", mapOf("protocolVersion" to 1))
        }
    }

    @Test
    fun `every v2 method has one exact positional request shape`() {
        val account = "0x" + "11".repeat(32)
        val destination = "0x" + "22".repeat(32)
        val requests = linkedMapOf<String, List<Any?>>()
        requests["open"] = listOf(2, 63, false)
        for (method in listOf(
            "start", "stop", "close", "getCapabilities", "getFinalizedHead", "getSyncStatus",
            "getBestHead", "exportState", "getGenesisHash",
            "getFeeSnapshot", "getWalletState", "inspectWallets", "deleteWallet", "signAndDeleteWallet",
            "reconcileWalletCleanup",
        )) requests[method] = listOf(2, "session-1", 1L)
        val finalizedBlock = listOf(account, "1", "finalized")
        requests["getFinalizedBlockAt"] = listOf(2, "session-1", 1L, "1")
        requests["resolveFinalizedBlock"] = listOf(2, "session-1", 1L, account, "1")
        for (method in listOf("getBlockHeader", "getBlockBody", "getRuntimeContext", "getSystemEvents")) {
            requests[method] = listOf(2, "session-1", 1L, finalizedBlock)
        }
        requests["getStorage"] = listOf(2, "session-1", 1L, finalizedBlock, byteArrayOf(1))
        requests["getStorageBatch"] = listOf(
            2, "session-1", 1L, finalizedBlock, listOf(byteArrayOf(1), byteArrayOf(2)),
        )
        requests["getStorageKeysPaged"] = listOf(
            2, "session-1", 1L, finalizedBlock, byteArrayOf(1), null, 1000L,
        )
        requests["callRuntimeApi"] = listOf(
            2, "session-1", 1L, finalizedBlock, "CitizenApi_items", byteArrayOf(),
        )
        requests["importState"] = listOf(2, "session-1", 1L, 1, finalizedBlock, byteArrayOf(1))
        for (method in listOf(
            "getAccountBalance", "getAccountNonce", "openPrivateKey", "setActiveWalletAccount",
            "deleteAccount",
        )) requests[method] = listOf(2, "session-1", 1L, account)
        requests["getAccountBalances"] = listOf(2, "session-1", 1L, listOf(account, account))
        requests["prepareWalletCreation"] = listOf(2, "session-1", 1L, 24, "")
        requests["addWalletAccounts"] = listOf(2, "session-1", 1L, "synthetic", "", listOf(1, 7))
        requests["renameAccount"] = listOf(2, "session-1", 1L, account, "main")
        requests["importColdAccountId"] = listOf(2, "session-1", 1L, account, "cold")
        requests["importColdAccountSs58"] = listOf(
            2, "session-1", 1L, "w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2", "cold",
        )
        requests["reorderWalletAccountsWithoutDefaultChange"] =
            listOf(2, "session-1", 1L, "7", listOf(account, destination))
        requests["signWalletPayload"] = listOf(2, "session-1", 1L, account, byteArrayOf(1))
        requests["deriveApplicationKey"] = listOf(
            2, "session-1", 1L, account, ByteArray(32), byteArrayOf(1),
        )
        requests["deriveApplicationKeys"] = listOf(
            2, "session-1", 1L, account, ByteArray(32), listOf(byteArrayOf(1), byteArrayOf(2)),
        )
        requests["prepareApplicationKeys"] = listOf(2, "session-1", 1L, account, ByteArray(32),
            listOf(byteArrayOf(1), byteArrayOf(2)), ByteArray(32))
        requests["beginSigning"] = listOf(
            2, "session-1", 1L, account, byteArrayOf(1), "raw", byteArrayOf(), "none", 0, 120L,
        )
        requests["consumeExternalSignature"] = listOf(2, "session-1", 1L, "signing-session", "{}")
        requests["cancelSigning"] = listOf(2, "session-1", 1L, "signing-session")
        requests["beginDefaultAccountChange"] =
            listOf(2, "session-1", 1L, "7", listOf(destination, account), 120L)
        requests["consumeDefaultAccountChange"] = listOf(2, "session-1", 1L, "signing-session", "{}")
        requests["verifySignature"] = listOf(2, account, ByteArray(64), byteArrayOf())
        requests["prepareTransaction"] = listOf(2, "session-1", 1L, account, byteArrayOf(1, 2))
        requests["cancelPreparedTransaction"] =
            listOf(2, "session-1", 1L, "0x00112233445566778899aabbccddeeff")
        requests["executePreparedTransaction"] =
            listOf(2, "session-1", 1L, "0x00112233445566778899aabbccddeeff")
        requests["consumePreparedTransactionQrResponse"] =
            listOf(2, "session-1", 1L, "0x112233445566778899aabbccddeeff00", "QR_V1")
        requests["cancelPreparedTransactionExecution"] =
            listOf(2, "session-1", 1L, "0x112233445566778899aabbccddeeff00")
        requests["getTransactionHistory"] = listOf(2, "session-1", 1L, null, 100L)
        requests["syncTransactionHistory"] = listOf(2, "session-1", 1L)
        requests["qrParse"] = listOf(2, "session-1", 1L, "{}")
        requests["qrCreateSignRequest"] = listOf(2, "session-1", 1L, 0x0400, account, byteArrayOf(4, 0), 120L)
        requests["signQrRequest"] = listOf(2, "session-1", 1L, "owned")
        requests["qrConsumeSignResponse"] = listOf(2, "session-1", 1L, "{}")
        requests["qrCancelSignRequest"] = listOf(2, "session-1", 1L, "abcdefghijklmnop")
        requests["qrEncodeAccountId"] = listOf(2, "session-1", 1L, account)
        requests["qrDecodeLuminance"] = listOf(2, "session-1", 1L, byteArrayOf(0), 1, 1, 1)
        requests["qrEncode"] = listOf(2, "session-1", 1L, "{}", 4)

        requests["validateWalletPassword"] = listOf(2, "session-1", 1L, "")
        requests["validateWalletMnemonic"] = listOf(2, "session-1", 1L, "synthetic", 18)
        requests["walletWordSuggestions"] = listOf(2, "session-1", 1L, "ab")
        for (method in listOf("copyRecoveryPhrase", "commitWalletCreation", "releasePreparedWallet", "revealPrivateKey",
            "closePrivateKey", "releaseQrReview", "closeQrCapture", "pauseQrCapture", "resumeQrCapture", "releaseWalletInspection")) {
            requests[method] = listOf(2, "session-1", 1L, "owned")
        }
        requests["cancelOperation"] = listOf(2, "session-1", 1L, "1")
        requests["respondCredential"] = listOf(2, "session-1", 1L, "1", null)
        requests["cancelCredential"] = listOf(2, "session-1", 1L, "1")
        for (method in listOf("importWallet", "addNextWalletAccount")) requests[method] = listOf(2, "session-1", 1L, "synthetic", "")
        requests["importColdAccountCode"] = listOf(2, "session-1", 1L, "{}", "")
        requests["setActiveWallet"] = listOf(2, "session-1", 1L, "7", 0)
        requests["renameWallet"] = listOf(2, "session-1", 1L, "7", 0, "名字")
        for (method in listOf("repairHotWallet", "deleteDiagnosticWallet")) requests[method] = listOf(2, "session-1", 1L, "owned", 0)
        requests["renameDiagnosticWallet"] = listOf(2, "session-1", 1L, "owned", 0, "名字")
        requests["qrEncodeDocument"] = listOf(2, "session-1", 1L, "{}")
        requests["qrPrepareAccountAuthorization"] = listOf(2, "session-1", 1L, 10, byteArrayOf(), "")
        requests["encodeSigningPayload"] = listOf(2, 2, "{\"op_tag\":16}", byteArrayOf())
        requests["qrValidateSignResponse"] = listOf(2, "session-1", 1L, "request", "{}")
        requests["reviewQrRequest"] = listOf(2, "session-1", 1L, "{}")
        requests["openQrCapture"] = listOf(2, "session-1", 1L, 1)
        requests["setQrCaptureTorch"] = listOf(2, "session-1", 1L, "owned", true)
        requests["qrDecodeImage"] = listOf(2, "session-1", 1L, byteArrayOf(1), 1)

        assertEquals(CitizenSdkFlutterCodec.methods, requests.keys)
        requests.forEach { (method, tuple) ->
            CitizenSdkFlutterCodec.decode(method, tuple)
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(method, tuple + "forbidden-extra-position")
            }
        }
    }

    @Test
    fun `wallet state projection keeps global order cold mode and default first`() {
        val cold = CitizenWalletStateAccount(
            CitizenWalletSignMode.COLD,
            1,
            null,
            ByteArray(32) { 0x22.toByte() },
            "w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2",
            "cold",
            "2",
            true,
        )
        val tuple = CitizenSdkFlutterCodec.walletState(CitizenWalletState("7", null, listOf(cold), 1, false, 1))
        assertEquals("7", tuple[0])
        assertNull(tuple[1])
        val account = (tuple[2] as List<*>).single() as List<*>
        assertEquals("cold", account[0])
        assertEquals(1L, account[1])
        assertNull(account[2])
        assertEquals(true, account[7])
    }

    @Test
    fun `transaction history cursor and limit are canonical`() {
        val cursor = "0x00112233445566778899aabbccddeeff"
        val request = CitizenSdkFlutterCodec.decode(
            "getTransactionHistory",
            listOf(2, "session-1", 7L, cursor, 25L),
        ) as CitizenSdkFlutterCodec.Request.TransactionHistory
        assertEquals(cursor, request.beforeExecutionId)
        assertEquals(25, request.limit)

        for (limit in listOf(0L, 101L)) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(
                    "getTransactionHistory",
                    listOf(2, "session-1", 8L, null, limit),
                )
            }
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode(
                "getTransactionHistory",
                listOf(2, "session-1", 9L, "0X00112233445566778899aabbccddeeff", 1L),
            )
        }
    }

    @Test
    fun `empty signing payload and normalized account name match the Dart encoder`() {
        val account = "0x" + "11".repeat(32)
        val signing = CitizenSdkFlutterCodec.decode(
            "signWalletPayload",
            listOf(2, "session-1", 10L, account, byteArrayOf()),
        ) as CitizenSdkFlutterCodec.Request.SignWalletPayload
        assertEquals(0, signing.payload.size)

        val rename = CitizenSdkFlutterCodec.decode(
            "renameAccount",
            listOf(2, "session-1", 11L, account, "旅行钱包"),
        ) as CitizenSdkFlutterCodec.Request.RenameWalletAccount
        assertEquals("旅行钱包", rename.name)

        for (invalidName in listOf(" 旅行钱包", "旅行钱包 ", "钱包\u001c")) {
            assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
                CitizenSdkFlutterCodec.decode(
                    "renameAccount",
                    listOf(2, "session-1", 12L, account, invalidName),
                )
            }
        }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode(
                "addWalletAccounts",
                listOf(2, "session-1", 13L, "synthetic", "", listOf(0)),
            )
        }
    }

    @Test
    fun applicationPreparationMessageHasClosedBound() {
        val account = "0x" + "11".repeat(32)
        for (size in listOf(0, 32)) {
            val request = CitizenSdkFlutterCodec.decode("prepareApplicationKeys",
                listOf(2, "session-1", 1L, account, ByteArray(32), listOf(byteArrayOf(1)), ByteArray(size)))
            assertTrue(request is CitizenSdkFlutterCodec.Request.PrepareApplicationKeys)
        }
        for (size in listOf(1, 31, 33)) assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode("prepareApplicationKeys",
                listOf(2, "session-1", 1L, account, ByteArray(32), listOf(byteArrayOf(1)), ByteArray(size)))
        }
    }

    @Test
    fun `request resource limits are enforced before projection copies`() {
        val account = "0x" + "11".repeat(32)
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode(
                "signWalletPayload",
                listOf(
                    2,
                    "session-1",
                    14L,
                    account,
                    ByteArray(CitizenSdkFlutterCodec.MAXIMUM_SIGNING_PAYLOAD_BYTES + 1),
                ),
            )
        }

        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode(
                "getTransactionHistory",
                listOf(2, "session-1", 15L, null, 101L),
            )
        }

        val tooManyIndices = List(
            CitizenSdkFlutterCodec.MAXIMUM_ADDITIONAL_WALLET_ACCOUNTS + 1,
        ) { 1 }
        assertThrows(CitizenSdkFlutterCodec.ContractFailure::class.java) {
            CitizenSdkFlutterCodec.decode(
                "addWalletAccounts",
                listOf(2, "session-1", 16L, "synthetic", "", tooManyIndices),
            )
        }
    }

    @Test
    fun `response event and error envelopes expose only public v2 fields`() {
        val response = CitizenSdkFlutterCodec.response(
            "session-1",
            4,
            listOf(ByteArray(64)),
        )
        assertEquals(4, response.size)
        assertEquals(listOf(2, "session-1", 4L), response.take(3))

        val event = CitizenSdkFlutterCodec.event(
            "session-1",
            2,
            "lifecycleChanged",
            listOf("running"),
        )
        assertEquals(5, event.size)
        assertEquals(listOf(2, "session-1", 2L, "lifecycleChanged"), event.take(4))
        assertThrows(IllegalArgumentException::class.java) {
            CitizenSdkFlutterCodec.event("session-1", 3, "debug", emptyList())
        }

        val details = CitizenSdkFlutterCodec.errorDetails(
            CitizenSdkErrorCode.INVALID_ARGUMENT,
            "invalid",
            "session-1",
            4,
            "getStorage",
        )
        assertEquals(listOf(2, "session-1", 4L, 1, 2, "getStorage", "invalid"), details)
    }
}
