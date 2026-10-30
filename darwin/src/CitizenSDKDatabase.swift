import Foundation
import SQLite3
import Darwin
internal import CitizenSDKInternal

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



/// SQLite资源与系统文件锁；schema、SQL、记录解释和事务策略归Rust。
internal final class CitizenSDKDatabase: @unchecked Sendable {
    private static let vaultLockRegistry=CitizenSDKVaultLockRegistry()
    private let secure: Bool
    private let vaultLockFile: URL
    private let vaultProcessLock: NSLock
    private let directory: URL
    private let lock = NSLock()
    private var owner: CitizenSDKSQLite?
    private var failed = false
    fileprivate var active: OpaquePointer?
    init(directory: URL, secure: Bool = false) { self.directory=directory;self.secure=secure;vaultLockFile=directory.appendingPathComponent("vault.lock");vaultProcessLock=Self.vaultLockRegistry.lock(for:vaultLockFile.standardizedFileURL.path) }
    func config() -> citizensdk_store_v1_t {
        var value = citizensdk_store_v1_t()
        value.struct_size = UInt32(MemoryLayout<citizensdk_store_v1_t>.size)
        value.abi_version = CITIZENSDK_ABI_VERSION; value.context = Unmanaged.passUnretained(self).toOpaque()
        value.run = databaseRun; value.execute = databaseExecute; value.query = databaseQuery
        value.begin = databaseBegin; value.end = databaseEnd; value.wal = databaseWal
        return value
    }
    fileprivate func run(_ job: citizensdk_store_job_t?, _ context: UnsafeMutableRawPointer?) throws -> Int32 {
        lock.lock(); defer { lock.unlock() }
        guard !failed else { throw databaseError() }
        guard let job else { throw CitizenSDKError(.invalidArgument, "SQLite job is missing") }
        if owner == nil { owner = try CitizenSDKSQLite(directory: directory, fileName: secure ? "secure-state.sqlite3" : "public-state.sqlite3", secure: secure) }
        return try owner!.read { connection in
            active = connection; defer { active = nil }
            let code = job(context)
            if sqlite3_get_autocommit(connection) == 0 {
                failed = true; owner!.close()
                throw databaseError()
            }
            return code
        }
    }
    func withVaultLock<T>(_ body: () throws -> T) throws -> T {
        _ = try run({ _ in 0 },nil)
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

    func close() {lock.lock();defer{lock.unlock()};owner?.close();failed=true}
    private func key(_ index: UInt32,_ generation: Data) throws -> citizensdk_host_wallet_key_ref_v1_t {
        guard generation.count==16 else{throw CitizenSDKError(.invalidArgument,"vault generation length differs")}
        var value=citizensdk_host_wallet_key_ref_v1_t();value.struct_size=UInt32(MemoryLayout<citizensdk_host_wallet_key_ref_v1_t>.size);value.abi_version = CITIZENSDK_ABI_VERSION;value.wallet_index=index
        _ = withUnsafeMutableBytes(of:&value.generation.bytes){generation.copyBytes(to:$0)};return value
    }
    private func generation(_ action:UInt32,_ index:UInt32,_ generation:Data,_ operation:Data=Data(repeating:0,count:16)) throws -> Bool {
        guard operation.count==16 else{throw CitizenSDKError(.invalidArgument,"vault operation length differs")}
        var ref=try key(index,generation), op=citizensdk_host_id128_t(),resource=config();var result:UInt8=0
        _ = withUnsafeMutableBytes(of:&op.bytes){operation.copyBytes(to:$0)}
        try CitizenSDKChecks.requireOK(citizensdk_store_generation(&resource,action,&ref,&op,&result),"Rust vault state failed");return result != 0
    }
    func ensureGeneration(walletIndex:UInt32,generation:Data,operationID:Data)throws->Bool {try self.generation(1,walletIndex,generation,operationID)}
    func isGenerationActive(walletIndex:UInt32,generation:Data)throws->Bool {try self.generation(2,walletIndex,generation)}
    func retireGeneration(walletIndex:UInt32,generation:Data,operationID:Data)throws {_ = try self.generation(4,walletIndex,generation,operationID)}
    func vaultGenerations()throws->[(UInt32,Data)] {
        var resource=config(),values=[citizensdk_host_wallet_key_ref_v1_t](repeating:citizensdk_host_wallet_key_ref_v1_t(),count:65536);var count:UInt64=0
        let code=values.withUnsafeMutableBufferPointer{citizensdk_store_generations(&resource,$0.baseAddress,UInt64($0.count),&count)}
        try CitizenSDKChecks.requireOK(code,"Rust vault generation query failed");guard count<=65536 else{throw CitizenSDKError(.integrity,"vault generation count differs")}
        return values.prefix(Int(count)).map{value in let bytes=value.generation.bytes;return(value.wallet_index,withUnsafeBytes(of:bytes){Data($0)})}
    }

    fileprivate func prepare(_ sql: citizensdk_bytes_view_t, _ values: UnsafePointer<citizensdk_sql_value_t>?, _ count: UInt64) throws -> OpaquePointer {
        guard let active, let bytes=sql.data, sql.len > 0, sql.len <= 65536, count <= 16, count == 0 || values != nil else { throw databaseError() }
        let text=Data(bytes: bytes, count: Int(sql.len))
        guard !text.contains(0), let string=String(data: text, encoding: .utf8) else { throw databaseError() }
        var statement: OpaquePointer?
        let valid=string.withCString { pointer -> Bool in
            var tail: UnsafePointer<CChar>?
            return sqlite3_prepare_v2(active,pointer,-1,&statement,&tail) == SQLITE_OK && tail?.pointee == 0
        }
        guard valid, let statement else { if let statement { sqlite3_finalize(statement) }; throw databaseError() }
        do {
            guard sqlite3_bind_parameter_count(statement) == Int32(count) else { throw databaseError() }
            for i in 0..<Int(count) {
                let value=values![i]; guard value.reserved == 0 else { throw databaseError() }
                let index=Int32(i+1); let code: Int32
                switch value.kind {
                case 0: code=sqlite3_bind_null(statement,index)
                case 1: code=sqlite3_bind_int64(statement,index,value.integer)
                case 2,3:
                    guard value.bytes.len <= 33554432, value.bytes.len == 0 || value.bytes.data != nil else { throw databaseError() }
                    if value.kind == 2 {
                        if value.bytes.len == 0 { code="".withCString { sqlite3_bind_text(statement,index,$0,0,databaseTransient) } }
                        else { code=sqlite3_bind_text(statement,index,UnsafeRawPointer(value.bytes.data!).assumingMemoryBound(to: CChar.self),Int32(value.bytes.len),databaseTransient) }
                    } else if value.bytes.len == 0 { code=sqlite3_bind_zeroblob(statement,index,0) }
                    else { code=sqlite3_bind_blob(statement,index,value.bytes.data,Int32(value.bytes.len),databaseTransient) }
                default: throw databaseError()
                }
                guard code == SQLITE_OK else { throw databaseError() }
            }
            return statement
        } catch { sqlite3_finalize(statement); throw error }
    }
}
private let databaseTransient=unsafeBitCast(-1,to:sqlite3_destructor_type.self)
private func databaseError() -> CitizenSDKError { CitizenSDKError(.storage,"SQLite resource operation failed") }
private func database(_ context: UnsafeMutableRawPointer?) throws -> CitizenSDKDatabase {
    guard let context else { throw databaseError() }; return Unmanaged<CitizenSDKDatabase>.fromOpaque(context).takeUnretainedValue()
}
private func databaseProtect(_ body: () throws -> Int32) -> Int32 {
    do { return try body() } catch let error as CitizenSDKError { return error.code.rawValue } catch { return CitizenSDKErrorCode.internalFailure.rawValue }
}
private func databaseRun(_ context: UnsafeMutableRawPointer?, _ job: citizensdk_store_job_t?, _ jobContext: UnsafeMutableRawPointer?) -> Int32 {
    databaseProtect { try database(context).run(job,jobContext) }
}
private func databaseExecute(_ context: UnsafeMutableRawPointer?, _ sql: citizensdk_bytes_view_t, _ values: UnsafePointer<citizensdk_sql_value_t>?, _ count: UInt64, _ changes: UnsafeMutablePointer<UInt64>?) -> Int32 {
    databaseProtect {
        let db=try database(context); guard let changes else { throw databaseError() }
        let statement=try db.prepare(sql,values,count); defer { sqlite3_finalize(statement) }
        var code=sqlite3_step(statement); while code == SQLITE_ROW { code=sqlite3_step(statement) }
        guard code == SQLITE_DONE else { throw databaseError() }
        changes.pointee=UInt64(sqlite3_changes64(db.active)); return 0
    }
}
private func databaseQuery(_ context: UnsafeMutableRawPointer?, _ sql: citizensdk_bytes_view_t, _ values: UnsafePointer<citizensdk_sql_value_t>?, _ count: UInt64, _ maximum: UInt64, _ budget: UInt64, _ row: citizensdk_store_row_t?, _ rowContext: UnsafeMutableRawPointer?) -> Int32 {
    databaseProtect {
        let db=try database(context); guard let row, maximum <= 65537, budget <= 33554432 else { throw databaseError() }
        let statement=try db.prepare(sql,values,count); defer { sqlite3_finalize(statement) }
        var rows: UInt64=0
        while true {
            let code=sqlite3_step(statement); if try !CitizenSDKSQLite.classifyStepCode(code,statement:statement) { return 0 }
            guard rows < maximum else { throw databaseError() }; rows += 1
            var remaining=budget
            let columns=Int(sqlite3_column_count(statement)); guard columns <= 64 else { throw databaseError() }
            var cells=[citizensdk_sql_value_t](repeating: citizensdk_sql_value_t(), count: columns)
            for i in 0..<columns {
                let column=Int32(i)
                switch sqlite3_column_type(statement,column) {
                case SQLITE_NULL: cells[i].kind=0
                case SQLITE_INTEGER: cells[i].kind=1; cells[i].integer=sqlite3_column_int64(statement,column)
                case SQLITE_TEXT,SQLITE_BLOB:
                    cells[i].kind=sqlite3_column_type(statement,column) == SQLITE_TEXT ? 2 : 3
                    let size=sqlite3_column_bytes(statement,column); guard size >= 0, UInt64(size) <= remaining else { throw databaseError() }
                    remaining -= UInt64(size); cells[i].bytes.len=UInt64(size)
                    cells[i].bytes.data=sqlite3_column_blob(statement,column)?.assumingMemoryBound(to: UInt8.self)
                    guard size == 0 || cells[i].bytes.data != nil else { throw databaseError() }
                default: throw databaseError()
                }
            }
            let result=cells.withUnsafeBufferPointer { row(rowContext,$0.baseAddress,UInt64($0.count)) }
            if result != 0 { return result }
        }
    }
}
private func databaseCommand(_ context: UnsafeMutableRawPointer?, _ sql: String) -> Int32 {
    databaseProtect { let db=try database(context); guard let active=db.active else { throw databaseError() }; try CitizenSDKSQLite.execute(active,sql); return 0 }
}
private func databaseBegin(_ context: UnsafeMutableRawPointer?) -> Int32 { databaseCommand(context,"BEGIN IMMEDIATE") }
private func databaseEnd(_ context: UnsafeMutableRawPointer?, _ commit: UInt8) -> Int32 {
    guard commit <= 1 else { return CitizenSDKErrorCode.invalidArgument.rawValue }
    return databaseCommand(context,commit == 1 ? "COMMIT" : "ROLLBACK")
}
private func databaseWal(_ context: UnsafeMutableRawPointer?) -> Int32 {
    databaseProtect {
        let db=try database(context); guard let active=db.active else { throw databaseError() }
        let statement=try CitizenSDKSQLite.prepare(active,"PRAGMA journal_mode=WAL"); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, let text=sqlite3_column_text(statement,0), String(cString: text) == "wal", sqlite3_step(statement) == SQLITE_DONE else { throw databaseError() }; return 0
    }
}
