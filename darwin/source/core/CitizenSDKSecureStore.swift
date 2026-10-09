import Foundation
import SQLite3
import Darwin

/// Shares the in-process half of the vault lock between every store opened on
/// the same app-private directory. `flock` below supplies the process boundary.
private final class CitizenSDKVaultLockRegistry: @unchecked Sendable {
    private let guardLock = NSLock()
    private var locks: [String: NSLock] = [:]

    func lock(for path: String) -> NSLock {
        guardLock.lock()
        defer { guardLock.unlock() }
        if let existing = locks[path] { return existing }
        let created = NSLock()
        locks[path] = created
        return created
    }
}

/// Wallet profile, authenticated ciphertext and permanent vault tombstones.
internal final class CitizenSDKSecureStore: CitizenSDKSQLite, @unchecked Sendable {
    static let generationActive: Int64 = 1
    static let generationRetired: Int64 = 2
    private static let vaultLockRegistry = CitizenSDKVaultLockRegistry()
    private let vaultLockFile: URL
    private let vaultProcessLock: NSLock

    init(directory: URL) throws {
        vaultLockFile = directory.appendingPathComponent("vault.lock", isDirectory: false)
        vaultProcessLock = Self.vaultLockRegistry.lock(for: vaultLockFile.standardizedFileURL.path)
        try super.init(
            directory: directory,
            fileName: "secure-state-v1.sqlite3",
            schema: [
                "CREATE TABLE IF NOT EXISTS wallet_profile (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), revision INTEGER NOT NULL, record BLOB NOT NULL)",
                "CREATE TABLE IF NOT EXISTS encrypted_secret (record_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record BLOB NOT NULL)",
                "CREATE TABLE IF NOT EXISTS vault_generation (record_key TEXT PRIMARY KEY, wallet_index INTEGER NOT NULL, generation BLOB NOT NULL, state INTEGER NOT NULL, operation_id BLOB NOT NULL)",
            ],
            secure: true
        )
    }

    func walletProfileLoad() throws -> CitizenSDKHostRecord {
        try read { database in
            let statement = try Self.prepare(database, "SELECT revision, record FROM wallet_profile WHERE wallet_index = 0")
            defer { sqlite3_finalize(statement) }
            if try Self.stepRowOrDone(statement) {
                return .present(.walletProfile, revision: try Self.revision(statement, 0), record: Self.data(statement, 1))
            }
            return .absent(.walletProfile)
        }
    }

    func walletProfileCAS(expected: UInt64, candidate: Data) throws -> CitizenSDKHostRecord {
        guard expected < UInt64(Int64.max) else { return .failure(.walletProfile, .conflict) }
        return try transaction { database in
            let query = try Self.prepare(database, "SELECT revision FROM wallet_profile WHERE wallet_index = 0")
            defer { sqlite3_finalize(query) }
            let actual = try Self.stepRowOrDone(query) ? try Self.revision(query, 0) : 0
            guard actual == expected else { return .failure(.walletProfile, .conflict) }
            let next = expected + 1
            let write = try Self.prepare(database, "INSERT OR REPLACE INTO wallet_profile(wallet_index, revision, record) VALUES(0, ?, ?)")
            defer { sqlite3_finalize(write) }
            try Self.bind(write, 1, Int64(next))
            try Self.bind(write, 2, candidate)
            guard sqlite3_step(write) == SQLITE_DONE else { throw CitizenSDKError(.storage, "wallet profile CAS failed") }
            return .present(.walletProfile, revision: next, record: candidate)
        }
    }


    /// 有界只读遍历当前SDK密文仓储；解析与状态判断只调用同一Core，不在Swift复制信封规则。
    func hasAccountSecret(accountID: Data) throws -> Bool {
        try CitizenSDKChecks.require(accountID.count == 32, "accountId长度无效")
        return try read { database in
            let query = try Self.prepare(database, "SELECT revision, length(record), record FROM encrypted_secret LIMIT 65537")
            defer { sqlite3_finalize(query) }
            var count = 0
            while try Self.stepRowOrDone(query) {
                count += 1
                guard count <= 65536, sqlite3_column_type(query, 2) == SQLITE_BLOB,
                      (1...65536).contains(sqlite3_column_int64(query, 1)) else {
                    throw CitizenSDKError(.integrity, "密文查询边界无效")
                }
                let revision = try Self.revision(query, 0)
                if try CitizenSDKNative.encryptedSecretRecordHasSecret(accountID: accountID, revision: revision,
                                                                        record: Self.data(query, 2)) { return true }
            }
            return false
        }
    }

    /// 同一只读快照含active与retired全部代际；物理钥未删时不能因墓碑误判为不存在。
    func vaultGenerations() throws -> [(UInt32, Data)] {
        try read { database in
            let query = try Self.prepare(database, "SELECT record_key, wallet_index, generation, state FROM vault_generation LIMIT 65537")
            defer { sqlite3_finalize(query) }
            var values: [(UInt32, Data)] = []
            while try Self.stepRowOrDone(query) {
                let index = sqlite3_column_int64(query, 1)
                guard values.count < 65536, sqlite3_column_type(query, 1) == SQLITE_INTEGER,
                      index >= 0, index <= Int64(UInt32.max), sqlite3_column_type(query, 2) == SQLITE_BLOB,
                      sqlite3_column_bytes(query, 2) == 16, sqlite3_column_type(query, 3) == SQLITE_INTEGER,
                      [Self.generationActive, Self.generationRetired].contains(sqlite3_column_int64(query, 3)),
                      sqlite3_column_type(query, 0) == SQLITE_TEXT,
                      let key = sqlite3_column_text(query, 0), sqlite3_column_bytes(query, 0) <= 64 else {
                    throw CitizenSDKError(.integrity, "金库代际事实无效")
                }
                let generation = Self.data(query, 2)
                guard Data(bytes: key, count: Int(sqlite3_column_bytes(query, 0))) ==
                    Data((try CitizenSDKRecordKey.generation(walletIndex: UInt32(index), generation: generation)).utf8) else {
                    throw CitizenSDKError(.integrity, "金库代际主键不一致")
                }
                values.append((UInt32(index), generation))
            }
            return values
        }
    }

    func encryptedSecretLoad(walletIndex: UInt32, kind: UInt32, generation: Data,
                             owner: Data, accountID: Data) throws -> CitizenSDKHostRecord {
        let key = try CitizenSDKRecordKey.secret(walletIndex: walletIndex, kind: kind,
                                                 generation: generation, owner: owner, accountID: accountID)
        return try read { database in
            let statement = try Self.prepare(database, "SELECT revision, record FROM encrypted_secret WHERE record_key = ?")
            defer { sqlite3_finalize(statement) }
            try Self.bind(statement, 1, key)
            if try Self.stepRowOrDone(statement) {
                return .present(.encryptedSecretBlob, revision: try Self.revision(statement, 0), record: Self.data(statement, 1))
            }
            return .absent(.encryptedSecretBlob)
        }
    }

    func encryptedSecretCAS(walletIndex: UInt32, kind: UInt32, generation: Data,
                            owner: Data, accountID: Data, expected: UInt64,
                            candidate: Data) throws -> CitizenSDKHostRecord {
        guard expected < UInt64(Int64.max) else { return .failure(.encryptedSecretBlob, .conflict) }
        let key = try CitizenSDKRecordKey.secret(walletIndex: walletIndex, kind: kind,
                                                 generation: generation, owner: owner, accountID: accountID)
        return try transaction { database in
            let query = try Self.prepare(database, "SELECT revision FROM encrypted_secret WHERE record_key = ?")
            defer { sqlite3_finalize(query) }
            try Self.bind(query, 1, key)
            let actual = try Self.stepRowOrDone(query) ? try Self.revision(query, 0) : 0
            guard actual == expected else { return .failure(.encryptedSecretBlob, .conflict) }
            let next = expected + 1
            let write = try Self.prepare(database, "INSERT OR REPLACE INTO encrypted_secret(record_key, revision, record) VALUES(?, ?, ?)")
            defer { sqlite3_finalize(write) }
            try Self.bind(write, 1, key)
            try Self.bind(write, 2, Int64(next))
            try Self.bind(write, 3, candidate)
            guard sqlite3_step(write) == SQLITE_DONE else { throw CitizenSDKError(.storage, "encrypted secret CAS failed") }
            return .present(.encryptedSecretBlob, revision: next, record: candidate)
        }
    }

    /// A generation can be admitted by exactly one provisioning operation.
    func ensureGeneration(walletIndex: UInt32, generation: Data, operationID: Data) throws -> Bool {
        let key = try CitizenSDKRecordKey.generation(walletIndex: walletIndex, generation: generation)
        return try transaction { database in
            let query = try Self.prepare(database, "SELECT state, operation_id FROM vault_generation WHERE record_key = ?")
            defer { sqlite3_finalize(query) }
            try Self.bind(query, 1, key)
            if try Self.stepRowOrDone(query) {
                let state = sqlite3_column_int64(query, 0)
                if state == Self.generationRetired { return false }
                return state == Self.generationActive && Self.data(query, 1) == operationID
            }
            let write = try Self.prepare(database, "INSERT INTO vault_generation(record_key, wallet_index, generation, state, operation_id) VALUES(?, ?, ?, ?, ?)")
            defer { sqlite3_finalize(write) }
            try Self.bind(write, 1, key)
            try Self.bind(write, 2, Int64(walletIndex))
            try Self.bind(write, 3, generation)
            try Self.bind(write, 4, Self.generationActive)
            try Self.bind(write, 5, operationID)
            guard sqlite3_step(write) == SQLITE_DONE else { throw CitizenSDKError(.storage, "vault generation insert failed") }
            return true
        }
    }

    func isGenerationActive(walletIndex: UInt32, generation: Data) throws -> Bool {
        let key = try CitizenSDKRecordKey.generation(walletIndex: walletIndex, generation: generation)
        return try read { database in
            let query = try Self.prepare(database, "SELECT state FROM vault_generation WHERE record_key = ?")
            defer { sqlite3_finalize(query) }
            try Self.bind(query, 1, key)
            return try Self.stepRowOrDone(query) && sqlite3_column_int64(query, 0) == Self.generationActive
        }
    }

    /// Serializes the durable generation record and the corresponding physical
    /// Keychain mutation across store instances and app processes.
    func withVaultLock<T>(_ body: () throws -> T) throws -> T {
        vaultProcessLock.lock()
        defer { vaultProcessLock.unlock() }

        let descriptor = Darwin.open(vaultLockFile.path, O_CREAT | O_RDWR | O_NOFOLLOW,
                                     mode_t(S_IRUSR | S_IWUSR))
        guard descriptor >= 0 else {
            throw CitizenSDKError(.storage, "vault lock could not be opened")
        }
        defer { _ = Darwin.close(descriptor) }

        var status = stat()
        guard fstat(descriptor, &status) == 0,
              (status.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              status.st_nlink == 1 else {
            throw CitizenSDKError(.storage, "vault lock is not a private regular file")
        }
        while flock(descriptor, LOCK_EX) != 0 {
            if errno == EINTR { continue }
            throw CitizenSDKError(.storage, "vault lock could not be acquired")
        }
        defer { _ = flock(descriptor, LOCK_UN) }
        return try body()
    }

    /// Tombstone is committed before physical Keychain deletion.
    func retireGeneration(walletIndex: UInt32, generation: Data, operationID: Data) throws {
        let key = try CitizenSDKRecordKey.generation(walletIndex: walletIndex, generation: generation)
        try transaction { database in
            let write = try Self.prepare(database, "INSERT OR REPLACE INTO vault_generation(record_key, wallet_index, generation, state, operation_id) VALUES(?, ?, ?, ?, ?)")
            defer { sqlite3_finalize(write) }
            try Self.bind(write, 1, key)
            try Self.bind(write, 2, Int64(walletIndex))
            try Self.bind(write, 3, generation)
            try Self.bind(write, 4, Self.generationRetired)
            try Self.bind(write, 5, operationID)
            guard sqlite3_step(write) == SQLITE_DONE else { throw CitizenSDKError(.storage, "vault generation tombstone failed") }
        }
    }
}
