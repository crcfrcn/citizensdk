// 来源：Linux SQLiteStore 的 Statement/schema/事务合同；文件 VFS 为 Windows HANDLE 适配。
#include "citizen_sdk_sqlite.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cstring>
#include <exception>
#include <limits>
#include <map>
#include <new>
#include <string_view>
#include <utility>

#ifndef SQLITE_OPEN_NOFOLLOW
#error "CitizenSDK requires SQLite SQLITE_OPEN_NOFOLLOW support"
#endif

namespace citizen_sdk::windows {
namespace {
HostError sqlite_error(sqlite3 *database, const char *message) {
  return HostError(CITIZENSDK_ERROR_STORAGE,
                   database == nullptr ? message : sqlite3_errmsg(database));
}

int lock_range(HANDLE handle, bool exclusive, DWORD start, DWORD count) noexcept {
  OVERLAPPED overlap{};
  overlap.Offset = start;
  if (::LockFileEx(handle, LOCKFILE_FAIL_IMMEDIATELY |
          (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0), 0, count, 0, &overlap)) return SQLITE_OK;
  const DWORD error = ::GetLastError();
  return error == ERROR_LOCK_VIOLATION || error == ERROR_IO_PENDING
      ? SQLITE_BUSY : SQLITE_IOERR_LOCK;
}

int unlock_range(HANDLE handle, DWORD start, DWORD count) noexcept {
  OVERLAPPED overlap{};
  overlap.Offset = start;
  return ::UnlockFileEx(handle, 0, count, 0, &overlap) ? SQLITE_OK : SQLITE_IOERR_UNLOCK;
}

std::string file_identity(const FILE_ID_INFO &identity) {
  std::string key(reinterpret_cast<const char *>(&identity.VolumeSerialNumber),
                  sizeof(identity.VolumeSerialNumber));
  key.append(reinterpret_cast<const char *>(identity.FileId.Identifier),
             sizeof(identity.FileId.Identifier));
  return key;
}
}  // namespace

// 不委托官方 VFS 的路径 I/O，也不使用只供 SQLite 测试的 SET_HANDLE 换柄指令。
class HandleSQLiteVfs final {
 public:
  HandleSQLiteVfs(std::shared_ptr<Directory> directory, std::string database_name)
      : directory_(std::move(directory)), database_name_(std::move(database_name)) {
    require(directory_ != nullptr && allowed_name(database_name_.c_str()),
            CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK SQLite VFS configuration is invalid");
    delegate_ = sqlite3_vfs_find(nullptr);
    require(delegate_ != nullptr, CITIZENSDK_ERROR_UNAVAILABLE,
            "CitizenSDK SQLite system services are unavailable");
    static std::atomic<uint64_t> next{1};
    uint64_t value = next.load();
    for (;;) {
      require(value != 0 && value != std::numeric_limits<uint64_t>::max(),
              CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK SQLite VFS identities exhausted");
      if (next.compare_exchange_weak(value, value + 1)) break;
    }
    name_ = "citizensdk-handle-" + std::to_string(value);
    vfs_.iVersion = 3;
    vfs_.szOsFile = static_cast<int>(sizeof(OpenFile));
    vfs_.mxPathname = 255;
    vfs_.zName = name_.c_str();
    vfs_.pAppData = this;
    vfs_.xOpen = open_callback;
    vfs_.xDelete = delete_callback;
    vfs_.xAccess = access_callback;
    vfs_.xFullPathname = full_path_callback;
    vfs_.xDlOpen = [](sqlite3_vfs *, const char *) -> void * { return nullptr; };
    vfs_.xDlError = [](sqlite3_vfs *, int size, char *out) {
      if (size > 0 && out != nullptr) out[0] = '\0';
    };
    vfs_.xDlSym = [](sqlite3_vfs *, void *, const char *) -> void (*)(void) { return nullptr; };
    vfs_.xDlClose = [](sqlite3_vfs *, void *) {};
    vfs_.xRandomness = [](sqlite3_vfs *v, int n, char *out) {
      auto *d = owner(v)->delegate_;
      return d->xRandomness == nullptr ? 0 : d->xRandomness(d, n, out);
    };
    vfs_.xSleep = [](sqlite3_vfs *v, int n) {
      auto *d = owner(v)->delegate_;
      return d->xSleep == nullptr ? 0 : d->xSleep(d, n);
    };
    vfs_.xCurrentTime = [](sqlite3_vfs *v, double *out) {
      auto *d = owner(v)->delegate_;
      return d->xCurrentTime == nullptr ? SQLITE_ERROR : d->xCurrentTime(d, out);
    };
    vfs_.xGetLastError = [](sqlite3_vfs *, int size, char *out) {
      if (size > 0 && out != nullptr) out[0] = '\0';
      return 0;
    };
    vfs_.xCurrentTimeInt64 = [](sqlite3_vfs *v, sqlite3_int64 *out) {
      auto *d = owner(v)->delegate_;
      if (d->iVersion >= 2 && d->xCurrentTimeInt64 != nullptr) return d->xCurrentTimeInt64(d, out);
      double time = 0;
      const int code = d->xCurrentTime == nullptr ? SQLITE_ERROR : d->xCurrentTime(d, &time);
      if (code == SQLITE_OK && out != nullptr) *out = static_cast<sqlite3_int64>(time * 86400000.0);
      return code;
    };
    vfs_.xSetSystemCall = [](sqlite3_vfs *, const char *, sqlite3_syscall_ptr) { return SQLITE_NOTFOUND; };
    vfs_.xGetSystemCall = [](sqlite3_vfs *, const char *) -> sqlite3_syscall_ptr { return nullptr; };
    vfs_.xNextSystemCall = [](sqlite3_vfs *, const char *) -> const char * { return nullptr; };
    require(sqlite3_vfs_register(&vfs_, 0) == SQLITE_OK, CITIZENSDK_ERROR_STORAGE,
            "CitizenSDK SQLite HANDLE VFS registration failed");
    registered_ = true;
  }
  ~HandleSQLiteVfs() { if (registered_) (void)sqlite3_vfs_unregister(&vfs_); }
  const char *name() const noexcept { return name_.c_str(); }

 private:
  static constexpr DWORD kPending = 0x40000000;
  static constexpr DWORD kReserved = kPending + 1;
  static constexpr DWORD kShared = kPending + 2;
  static constexpr DWORD kSharedCount = 510;
  static constexpr DWORD kShmBase = (22 + SQLITE_SHM_NLOCK) * 4;
  static constexpr DWORD kDeadman = kShmBase + SQLITE_SHM_NLOCK;

  struct Region final {
    UniqueHandle mapping;
    void *base{};
    std::size_t delta{};
    Region() = default;
    Region(const Region &) = delete;
    Region &operator=(const Region &) = delete;
    Region(Region &&other) noexcept : mapping(std::move(other.mapping)),
        base(std::exchange(other.base, nullptr)), delta(other.delta) {}
    Region &operator=(Region &&other) noexcept {
      if (this != &other) {
        if (base != nullptr) (void)::UnmapViewOfFile(base);
        mapping = std::move(other.mapping);
        base = std::exchange(other.base, nullptr);
        delta = other.delta;
      }
      return *this;
    }
    ~Region() { if (base != nullptr) (void)::UnmapViewOfFile(base); }
  };

  struct ShmConnection;
  struct ShmNode final {
    std::shared_ptr<Directory> directory;
    std::wstring name;
    std::string key;
    UniqueHandle handle;
    FILE_ID_INFO identity{};
    std::mutex mutex;
    bool poisoned{};
    int page_size{};
    std::vector<Region> regions;
    std::vector<ShmConnection *> connections;
  };
  struct ShmConnection final {
    std::shared_ptr<ShmNode> node;
    unsigned shared_mask{};
    unsigned exclusive_mask{};
  };
  struct FileState final {
    HandleSQLiteVfs *owner{};
    UniqueHandle handle;
    FILE_ID_INFO identity{};
    std::string name;
    std::mutex io_mutex;
    int level{SQLITE_LOCK_NONE};
    bool poisoned{};
    bool shared{}, reserved{}, pending{}, exclusive{};
    std::unique_ptr<ShmConnection> shm;
  };
  struct OpenFile final { sqlite3_file base; FileState *state; };
  inline static std::mutex shm_mutex_;
  inline static std::map<std::string, std::weak_ptr<ShmNode>> shm_nodes_;

  static HandleSQLiteVfs *owner(sqlite3_vfs *value) noexcept {
    return static_cast<HandleSQLiteVfs *>(value->pAppData);
  }
  static FileState *state(sqlite3_file *value) noexcept {
    return reinterpret_cast<OpenFile *>(value)->state;
  }
  bool allowed_name(const char *value) const noexcept {
    if (value == nullptr) return false;
    const std::string_view name(value);
    if (name.empty() || name.find_first_of("/\\:") != std::string_view::npos) return false;
    if (name == database_name_) return true;
    if (name.size() <= database_name_.size() || name.substr(0, database_name_.size()) != database_name_) return false;
    const auto suffix = name.substr(database_name_.size());
    return suffix == "-wal" || suffix == "-shm" || suffix == "-journal";
  }
  static bool valid(FileState *file) noexcept {
    try {
      if (file == nullptr || file->owner == nullptr || !file->handle || file->poisoned) return false;
      file->owner->directory_->verify_file(file->handle.get());
      return Directory::same_identity(file->identity, Directory::identity(file->handle.get()));
    } catch (...) { return false; }
  }
  static void valid_shm(const ShmNode &node) {
    require(static_cast<bool>(node.handle) && !node.poisoned, CITIZENSDK_ERROR_STORAGE,
            "CitizenSDK SHM is closed or its lock state is uncertain");
    node.directory->verify_file(node.handle.get());
    require(Directory::same_identity(node.identity, Directory::identity(node.handle.get())),
            CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK SHM identity changed");
  }

  static int open_callback(sqlite3_vfs *vfs, const char *name, sqlite3_file *out,
                           int flags, int *out_flags) noexcept {
    if (vfs == nullptr || out == nullptr || vfs->pAppData == nullptr) return SQLITE_CANTOPEN;
    std::memset(out, 0, sizeof(OpenFile));
    try {
      auto *self = owner(vfs);
      // temp_store=MEMORY；没有不受控临时路径或匿名磁盘文件旁路。
      if (!self->allowed_name(name) || (flags & SQLITE_OPEN_DELETEONCLOSE) != 0 ||
          ((flags & SQLITE_OPEN_MAIN_DB) != 0 && (flags & SQLITE_OPEN_NOFOLLOW) == 0)) return SQLITE_CANTOPEN;
      const bool readonly = (flags & SQLITE_OPEN_READONLY) != 0;
      const ULONG disposition = (flags & SQLITE_OPEN_CREATE) == 0 ? 1 :
          ((flags & SQLITE_OPEN_EXCLUSIVE) != 0 ? 2 : 3);
      auto value = std::make_unique<FileState>();
      value->owner = self;
      value->name = name;
      value->handle = self->directory_->open(Directory::utf16(value->name),
          GENERIC_READ | (readonly ? 0 : GENERIC_WRITE), disposition);
      value->identity = Directory::identity(value->handle.get());
      auto *file = reinterpret_cast<OpenFile *>(out);
      file->state = value.release();
      file->base.pMethods = &methods_;
      if (out_flags != nullptr) *out_flags = readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE;
      return SQLITE_OK;
    } catch (const std::bad_alloc &) { return SQLITE_NOMEM; }
    catch (...) { return SQLITE_CANTOPEN; }
  }
  static int delete_callback(sqlite3_vfs *vfs, const char *name, int) noexcept {
    try {
      auto *self = owner(vfs);
      if (!self->allowed_name(name)) return SQLITE_IOERR_DELETE;
      auto file = self->directory_->find(Directory::utf16(name), DELETE | GENERIC_READ | GENERIC_WRITE);
      if (!file) return SQLITE_IOERR_DELETE_NOENT;
      FILE_DISPOSITION_INFO deletion{TRUE};
      // Windows 官方 VFS 不提供目录 fsync；此处只报告真实句柄删除结果。
      return ::SetFileInformationByHandle(file->get(), FileDispositionInfo, &deletion, sizeof(deletion))
          ? SQLITE_OK : SQLITE_IOERR_DELETE;
    } catch (...) { return SQLITE_IOERR_DELETE; }
  }
  static int access_callback(sqlite3_vfs *vfs, const char *name, int flags, int *out) noexcept {
    if (out == nullptr) return SQLITE_IOERR_ACCESS;
    *out = 0;
    try {
      auto *self = owner(vfs);
      if (!self->allowed_name(name) || (flags != SQLITE_ACCESS_EXISTS &&
          flags != SQLITE_ACCESS_READ && flags != SQLITE_ACCESS_READWRITE)) return SQLITE_IOERR_ACCESS;
      auto file = self->directory_->find(Directory::utf16(name),
          GENERIC_READ | (flags == SQLITE_ACCESS_READWRITE ? GENERIC_WRITE : 0));
      *out = file.has_value() ? 1 : 0;
      return SQLITE_OK;
    } catch (...) { return SQLITE_IOERR_ACCESS; }
  }
  static int full_path_callback(sqlite3_vfs *vfs, const char *name, int size, char *out) noexcept {
    if (!owner(vfs)->allowed_name(name) || out == nullptr || size <= 0) return SQLITE_CANTOPEN;
    const std::size_t length = std::strlen(name);
    if (length >= static_cast<std::size_t>(size)) return SQLITE_CANTOPEN;
    std::memcpy(out, name, length + 1);
    return SQLITE_OK;
  }
  static int close_file(sqlite3_file *value) noexcept {
    auto *file = reinterpret_cast<OpenFile *>(value);
    int code = SQLITE_OK;
    if (file->state != nullptr && file->state->shm) code = shm_unmap(value, 0);
    delete file->state;
    file->state = nullptr;
    file->base.pMethods = nullptr;
    return code;
  }
  static bool range_ok(int count, sqlite3_int64 offset) noexcept {
    return count >= 0 && offset >= 0 && offset <= std::numeric_limits<sqlite3_int64>::max() - count;
  }
  static int read_file(sqlite3_file *value, void *out, int count, sqlite3_int64 offset) noexcept {
    auto *file = state(value);
    if (!range_ok(count, offset) || !valid(file) || (count > 0 && out == nullptr)) return SQLITE_IOERR_READ;
    std::lock_guard<std::mutex> guard(file->io_mutex);
    LARGE_INTEGER position{}; position.QuadPart = offset;
    if (!::SetFilePointerEx(file->handle.get(), position, nullptr, FILE_BEGIN)) return SQLITE_IOERR_READ;
    auto *cursor = static_cast<uint8_t *>(out);
    int remaining = count;
    while (remaining > 0) {
      DWORD actual = 0;
      if (!::ReadFile(file->handle.get(), cursor, static_cast<DWORD>(remaining), &actual, nullptr)) return SQLITE_IOERR_READ;
      if (actual == 0) { std::memset(cursor, 0, remaining); return SQLITE_IOERR_SHORT_READ; }
      cursor += actual; remaining -= static_cast<int>(actual);
    }
    return SQLITE_OK;
  }
  static int write_file(sqlite3_file *value, const void *input, int count, sqlite3_int64 offset) noexcept {
    auto *file = state(value);
    if (!range_ok(count, offset) || !valid(file) || (count > 0 && input == nullptr)) return SQLITE_IOERR_WRITE;
    std::lock_guard<std::mutex> guard(file->io_mutex);
    LARGE_INTEGER position{}; position.QuadPart = offset;
    if (!::SetFilePointerEx(file->handle.get(), position, nullptr, FILE_BEGIN)) return SQLITE_IOERR_WRITE;
    auto *cursor = static_cast<const uint8_t *>(input);
    int remaining = count;
    while (remaining > 0) {
      DWORD actual = 0;
      if (!::WriteFile(file->handle.get(), cursor, static_cast<DWORD>(remaining), &actual, nullptr) || actual == 0) return SQLITE_IOERR_WRITE;
      cursor += actual; remaining -= static_cast<int>(actual);
    }
    return SQLITE_OK;
  }
  static int truncate_file(sqlite3_file *value, sqlite3_int64 size) noexcept {
    auto *file = state(value);
    if (size < 0 || !valid(file)) return SQLITE_IOERR_TRUNCATE;
    std::lock_guard<std::mutex> guard(file->io_mutex);
    FILE_END_OF_FILE_INFO end{}; end.EndOfFile.QuadPart = size;
    return ::SetFileInformationByHandle(file->handle.get(), FileEndOfFileInfo, &end, sizeof(end))
        ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
  }
  static int sync_file(sqlite3_file *value, int) noexcept {
    auto *file = state(value);
    return valid(file) && ::FlushFileBuffers(file->handle.get()) ? SQLITE_OK : SQLITE_IOERR_FSYNC;
  }
  static int file_size(sqlite3_file *value, sqlite3_int64 *out) noexcept {
    auto *file = state(value);
    LARGE_INTEGER size{};
    if (out == nullptr || !valid(file) || !::GetFileSizeEx(file->handle.get(), &size) || size.QuadPart < 0) return SQLITE_IOERR_FSTAT;
    *out = size.QuadPart; return SQLITE_OK;
  }
  static int lock_file(sqlite3_file *value, int requested) noexcept {
    auto *file = state(value);
    if (!valid(file)) return SQLITE_IOERR_LOCK;
    if (requested <= file->level) return SQLITE_OK;
    const HANDLE handle = file->handle.get();
    if (requested == SQLITE_LOCK_SHARED) {
      int code = lock_range(handle, false, kPending, 1);
      if (code != SQLITE_OK) return code;
      code = lock_range(handle, false, kShared, kSharedCount);
      const int released = unlock_range(handle, kPending, 1);
      if (code == SQLITE_OK) { file->shared = true; file->level = SQLITE_LOCK_SHARED; }
      if (released != SQLITE_OK) file->poisoned = true;
      return released == SQLITE_OK ? code : released;
    }
    if (requested == SQLITE_LOCK_RESERVED) {
      const int code = lock_range(handle, true, kReserved, 1);
      if (code == SQLITE_OK) { file->reserved = true; file->level = SQLITE_LOCK_RESERVED; }
      return code;
    }
    if (requested != SQLITE_LOCK_PENDING && requested != SQLITE_LOCK_EXCLUSIVE) return SQLITE_IOERR_LOCK;
    if (!file->pending) {
      const int code = lock_range(handle, true, kPending, 1);
      if (code != SQLITE_OK) return code;
      file->pending = true;
    }
    file->level = SQLITE_LOCK_PENDING;
    if (requested == SQLITE_LOCK_PENDING) return SQLITE_OK;
    // Windows 不能用独占锁直接覆盖自己的共享锁；PENDING 保持期间先释放再升级。
    if (file->shared) {
      if (unlock_range(handle, kShared, kSharedCount) != SQLITE_OK) {
        file->poisoned = true;
        return SQLITE_IOERR_UNLOCK;
      }
      file->shared = false;
    }
    const int code = lock_range(handle, true, kShared, kSharedCount);
    if (code == SQLITE_OK) { file->exclusive = true; file->level = SQLITE_LOCK_EXCLUSIVE; return SQLITE_OK; }
    if (lock_range(handle, false, kShared, kSharedCount) != SQLITE_OK) {
      file->poisoned = true;
      return SQLITE_IOERR_LOCK;
    }
    file->shared = true;
    return code;
  }
  static int unlock_file(sqlite3_file *value, int requested) noexcept {
    auto *file = state(value);
    if (file == nullptr || !file->handle) return SQLITE_IOERR_UNLOCK;
    if (requested != SQLITE_LOCK_NONE && requested != SQLITE_LOCK_SHARED) return SQLITE_IOERR_UNLOCK;
    if (requested >= file->level) return SQLITE_OK;
    const HANDLE handle = file->handle.get();
    int result = SQLITE_OK;
    // 释放既有锁不是新 I/O 准入；ACL/线程身份变化和分配失败不能阻断清理。
    // 全程只使用仍存活的原句柄与持锁记账，不重读 SID/DACL、不分配内存。
    const auto release = [&](bool &held, DWORD start, DWORD count) noexcept {
      if (!held) return;
      if (unlock_range(handle, start, count) == SQLITE_OK) held = false;
      else { file->poisoned = true; result = SQLITE_IOERR_UNLOCK; }
    };
    release(file->exclusive, kShared, kSharedCount);
    if (requested == SQLITE_LOCK_SHARED && !file->shared && !file->exclusive) {
      if (lock_range(handle, false, kShared, kSharedCount) == SQLITE_OK) file->shared = true;
      else { file->poisoned = true; result = SQLITE_IOERR_UNLOCK; }
    }
    if (requested == SQLITE_LOCK_NONE) release(file->shared, kShared, kSharedCount);
    release(file->reserved, kReserved, 1);
    release(file->pending, kPending, 1);
    if (result == SQLITE_OK) file->level = requested;
    return result;
  }
  static int reserved_lock(sqlite3_file *value, int *out) noexcept {
    auto *file = state(value);
    if (out == nullptr || !valid(file)) return SQLITE_IOERR_CHECKRESERVEDLOCK;
    if (file->reserved || file->exclusive) { *out = 1; return SQLITE_OK; }
    const int code = lock_range(file->handle.get(), true, kReserved, 1);
    if (code == SQLITE_BUSY) { *out = 1; return SQLITE_OK; }
    if (code != SQLITE_OK) return SQLITE_IOERR_CHECKRESERVEDLOCK;
    *out = 0;
    if (unlock_range(file->handle.get(), kReserved, 1) == SQLITE_OK) return SQLITE_OK;
    file->poisoned = true;
    return SQLITE_IOERR_CHECKRESERVEDLOCK;
  }
  static int control(sqlite3_file *value, int operation, void *argument) noexcept {
    auto *file = state(value);
    if (file == nullptr) return SQLITE_IOERR;
    if (operation == SQLITE_FCNTL_LOCKSTATE && argument != nullptr) {
      *static_cast<int *>(argument) = file->level; return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_HAS_MOVED && argument != nullptr) {
      *static_cast<int *>(argument) = valid(file) ? 0 : 1; return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_VFSNAME && argument != nullptr) {
      *static_cast<char **>(argument) = sqlite3_mprintf("%s", file->owner->name_.c_str());
      return *static_cast<char **>(argument) == nullptr ? SQLITE_NOMEM : SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_SYNC) return sync_file(value, 0);
    return SQLITE_NOTFOUND;
  }

  static int open_shm(FileState &file) {
    if (file.shm) return SQLITE_OK;
    auto connection = std::make_unique<ShmConnection>();
    const auto key = file_identity(file.identity);
    std::lock_guard<std::mutex> registry(shm_mutex_);
    auto existing = shm_nodes_.find(key);
    auto node = existing == shm_nodes_.end() ? std::shared_ptr<ShmNode>() : existing->second.lock();
    if (!node) {
      node = std::make_shared<ShmNode>();
      node->directory = file.owner->directory_;
      node->name = Directory::utf16(file.name + "-shm");
      node->key = key;
      node->handle = node->directory->open(node->name, GENERIC_READ | GENERIC_WRITE, 3);
      node->identity = Directory::identity(node->handle.get());
      int code = lock_range(node->handle.get(), true, kDeadman, 1);
      if (code == SQLITE_OK) {
        FILE_END_OF_FILE_INFO end{};
        if (!::SetFileInformationByHandle(node->handle.get(), FileEndOfFileInfo, &end, sizeof(end))) return SQLITE_IOERR_SHMSIZE;
        // 同 HANDLE 允许共享锁覆盖独占锁；一次 unlock 先释放独占锁，不留 DMS 空窗。
        code = lock_range(node->handle.get(), false, kDeadman, 1);
        if (code != SQLITE_OK || unlock_range(node->handle.get(), kDeadman, 1) != SQLITE_OK) return SQLITE_IOERR_SHMLOCK;
      } else if (code == SQLITE_BUSY) {
        code = lock_range(node->handle.get(), false, kDeadman, 1);
        if (code != SQLITE_OK) return code;
      } else return SQLITE_IOERR_SHMLOCK;
      shm_nodes_[key] = node;
    }
    std::lock_guard<std::mutex> guard(node->mutex);
    valid_shm(*node);
    connection->node = node;
    node->connections.push_back(connection.get());
    file.shm = std::move(connection);
    return SQLITE_OK;
  }
  static int shm_map(sqlite3_file *value, int page, int size, int extend, void volatile **out) noexcept {
    if (out == nullptr) return SQLITE_IOERR_SHMMAP;
    *out = nullptr;
    auto *file = state(value);
    if (!valid(file) || page < 0 || size <= 0 ||
        (extend != 0 && extend != 1)) return SQLITE_IOERR_SHMMAP;
    try {
      const int code = open_shm(*file);
      if (code != SQLITE_OK) return code;
      auto node = file->shm->node;
      std::lock_guard<std::mutex> guard(node->mutex);
      valid_shm(*node);
      if (node->page_size != 0 && node->page_size != size) return SQLITE_IOERR_SHMSIZE;
      node->page_size = size;
      // WAL 可在长期读事务期间合法增长；不添加 64 页等产品合同之外的上限。
      const uint64_t pages = static_cast<uint64_t>(page) + 1;
      if (pages > std::numeric_limits<uint64_t>::max() / static_cast<uint64_t>(size) ||
          pages > node->regions.max_size()) return SQLITE_IOERR_SHMSIZE;
      const uint64_t required = pages * static_cast<uint64_t>(size);
      if (required > static_cast<uint64_t>(std::numeric_limits<LONGLONG>::max())) return SQLITE_IOERR_SHMSIZE;
      if constexpr (sizeof(std::size_t) < sizeof(uint64_t)) {
        if (required > std::numeric_limits<std::size_t>::max()) return SQLITE_IOERR_SHMSIZE;
      }
      LARGE_INTEGER current{};
      if (!::GetFileSizeEx(node->handle.get(), &current) || current.QuadPart < 0) return SQLITE_IOERR_SHMSIZE;
      if (static_cast<uint64_t>(current.QuadPart) < required && extend == 0) return SQLITE_OK;
      if (node->regions.size() < pages) node->regions.resize(static_cast<std::size_t>(pages));
      auto &region = node->regions[page];
      if (region.base == nullptr) {
        SYSTEM_INFO info{}; ::GetSystemInfo(&info);
        if (info.dwAllocationGranularity == 0) return SQLITE_IOERR_SHMMAP;
        const uint64_t offset = static_cast<uint64_t>(page) * static_cast<uint64_t>(size);
        const uint64_t aligned = offset - offset % info.dwAllocationGranularity;
        const auto delta = static_cast<std::size_t>(offset - aligned);
        // 映射大小可扩展同一 SHM 文件；偏移按 Windows allocation granularity 对齐。
        UniqueHandle mapping(::CreateFileMappingW(node->handle.get(), nullptr, PAGE_READWRITE,
            static_cast<DWORD>(required >> 32), static_cast<DWORD>(required), nullptr));
        if (!mapping) return SQLITE_IOERR_SHMMAP;
        void *base = ::MapViewOfFile(mapping.get(), FILE_MAP_READ | FILE_MAP_WRITE,
            static_cast<DWORD>(aligned >> 32), static_cast<DWORD>(aligned), delta + static_cast<std::size_t>(size));
        if (base == nullptr) return SQLITE_IOERR_SHMMAP;
        region.mapping = std::move(mapping); region.base = base; region.delta = delta;
      }
      *out = static_cast<uint8_t *>(region.base) + region.delta;
      return SQLITE_OK;
    } catch (const std::bad_alloc &) { return SQLITE_NOMEM; }
    catch (...) { return SQLITE_IOERR_SHMMAP; }
  }
  static int shm_lock(sqlite3_file *value, int offset, int count, int flags) noexcept {
    auto *file = state(value);
    if (file == nullptr || !file->handle || !file->shm || offset < 0 || count < 1 ||
        offset > SQLITE_SHM_NLOCK - count) return SQLITE_IOERR_SHMLOCK;
    const bool acquire = (flags & SQLITE_SHM_LOCK) != 0;
    const bool exclusive = (flags & SQLITE_SHM_EXCLUSIVE) != 0;
    if (flags != ((acquire ? SQLITE_SHM_LOCK : SQLITE_SHM_UNLOCK) |
        (exclusive ? SQLITE_SHM_EXCLUSIVE : SQLITE_SHM_SHARED)) || (!exclusive && count != 1)) return SQLITE_IOERR_SHMLOCK;
    if (acquire && !valid(file)) return SQLITE_IOERR_SHMLOCK;
    try {
      auto &connection = *file->shm;
      auto node = connection.node;
      std::lock_guard<std::mutex> guard(node->mutex);
      if (!node->handle) return SQLITE_IOERR_SHMLOCK;
      // SQLite 结束写事务可能忽略 UNLOCK 的返回值；释放不可依赖新的 ACL/SID 读取。
      if (acquire) valid_shm(*node);
      const unsigned mask = ((1u << count) - 1u) << offset;
      unsigned others_shared = 0, others_exclusive = 0;
      for (auto *other : node->connections) {
        if (other != &connection) { others_shared |= other->shared_mask; others_exclusive |= other->exclusive_mask; }
      }
      unsigned &held = exclusive ? connection.exclusive_mask : connection.shared_mask;
      if (acquire) {
        if ((held & mask) == mask) return SQLITE_OK;
        if (((connection.shared_mask | connection.exclusive_mask) & mask) != 0 ||
            (others_exclusive & mask) != 0 || (exclusive && (others_shared & mask) != 0)) return SQLITE_BUSY;
        if (exclusive || (others_shared & mask) == 0) {
          // Windows 解锁必须对应原加锁范围；逐字节获取，失败撤销本次全部锁。
          unsigned acquired = 0;
          for (int bit = offset; bit < offset + count; ++bit) {
            const int code = lock_range(node->handle.get(), exclusive, kShmBase + bit, 1);
            if (code != SQLITE_OK) {
              for (int undo = offset; undo < bit; ++undo) {
                if (unlock_range(node->handle.get(), kShmBase + undo, 1) != SQLITE_OK) {
                  node->poisoned = true;
                  held |= 1u << undo;
                }
              }
              return node->poisoned || code != SQLITE_BUSY ? SQLITE_IOERR_SHMLOCK : SQLITE_BUSY;
            }
            acquired |= 1u << bit;
          }
          held |= acquired;
        }
        held |= mask;
      } else {
        if ((held & mask) == 0) return SQLITE_OK;
        if ((held & mask) != mask) return SQLITE_IOERR_SHMLOCK;
        if (exclusive || (others_shared & mask) == 0) {
          int result = SQLITE_OK;
          for (int bit = offset; bit < offset + count; ++bit) {
            if (unlock_range(node->handle.get(), kShmBase + bit, 1) != SQLITE_OK) {
              node->poisoned = true;
              result = SQLITE_IOERR_SHMLOCK;
            } else held &= ~(1u << bit);
          }
          if (result != SQLITE_OK) return result;
        }
        held &= ~mask;
      }
      return SQLITE_OK;
    } catch (...) { return SQLITE_IOERR_SHMLOCK; }
  }
  static int shm_unmap(sqlite3_file *value, int delete_file) noexcept {
    auto *file = state(value);
    if (file == nullptr || !file->shm) return SQLITE_OK;
    auto *connection = file->shm.get();
    auto node = connection->node;
    std::lock_guard<std::mutex> registry(shm_mutex_);
    std::lock_guard<std::mutex> guard(node->mutex);
    int result = SQLITE_OK;
    // 清理不做新的 SID/DACL 准入；真实解锁失败也必须摘除连接，不能留下悬空指针。
    // 锁状态不确定时毒化同 FileId 节点，直到最后一个连接关闭才释放句柄。
    unsigned others_shared = 0;
    for (auto *other : node->connections) if (other != connection) others_shared |= other->shared_mask;
    for (int bit = 0; bit < SQLITE_SHM_NLOCK; ++bit) {
      const unsigned mask = 1u << bit;
      if ((connection->exclusive_mask & mask) || ((connection->shared_mask & mask) && !(others_shared & mask))) {
        if (unlock_range(node->handle.get(), kShmBase + bit, 1) != SQLITE_OK) {
          node->poisoned = true;
          result = SQLITE_IOERR_SHMLOCK;
        }
      }
    }
    node->connections.erase(std::remove(node->connections.begin(), node->connections.end(), connection), node->connections.end());
    file->shm.reset();
    if (node->connections.empty()) {
      shm_nodes_.erase(node->key);
      node->regions.clear();
      node->handle.reset();
      if (delete_file != 0 && result == SQLITE_OK) {
        try {
          auto target = node->directory->find(node->name, DELETE | GENERIC_READ | GENERIC_WRITE);
          if (target) {
            if (!Directory::same_identity(node->identity, Directory::identity(target->get()))) return SQLITE_IOERR_DELETE;
            FILE_DISPOSITION_INFO deletion{TRUE};
            if (!::SetFileInformationByHandle(target->get(), FileDispositionInfo, &deletion, sizeof(deletion))) return SQLITE_IOERR_DELETE;
          }
        } catch (const HostError &error) {
          // 另一进程仍持有 SHM 时保留文件，不能删除其活动映射或绕过分享模式。
          if (error.code() != CITIZENSDK_ERROR_BUSY) return SQLITE_IOERR_DELETE;
        } catch (...) { return SQLITE_IOERR_DELETE; }
      }
    }
    return result;
  }
  inline static const sqlite3_io_methods methods_ = {
    3, close_file, read_file, write_file, truncate_file, sync_file, file_size,
    lock_file, unlock_file, reserved_lock, control,
    [](sqlite3_file *) { return 4096; }, [](sqlite3_file *) { return 0; },
    shm_map, shm_lock, [](sqlite3_file *) { std::atomic_thread_fence(std::memory_order_seq_cst); },
    shm_unmap, [](sqlite3_file *, sqlite3_int64, int, void **out) {
      if (out == nullptr) return SQLITE_IOERR;
      *out = nullptr; return SQLITE_OK;
    }, [](sqlite3_file *file, sqlite3_int64, void *) { return valid(state(file)) ? SQLITE_OK : SQLITE_IOERR; }
  };
  std::shared_ptr<Directory> directory_;
  std::string database_name_, name_;
  sqlite3_vfs *delegate_{};
  sqlite3_vfs vfs_{};
  bool registered_{};
};

SQLiteStore::Statement::Statement(sqlite3 *database, const char *sql) {
  if (sqlite3_prepare_v2(database, sql, -1, &statement_, nullptr) != SQLITE_OK ||
      statement_ == nullptr) {
    throw sqlite_error(database, "CitizenSDK SQLite prepare failed");
  }
}

SQLiteStore::Statement::~Statement() {
  if (statement_ != nullptr) sqlite3_finalize(statement_);
}

std::string SQLiteStore::Statement::text(int column, int maximum) const {
  if (maximum < 0 || sqlite3_column_type(statement_, column) != SQLITE_TEXT) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK SQLite text has an invalid storage type");
  }
  const int count = sqlite3_column_bytes(statement_, column);
  const auto *source = sqlite3_column_text(statement_, column);
  if (count < 0 || count > maximum || (count > 0 && source == nullptr)) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK SQLite text violates its schema bounds");
  }
  if (count == 0) return {};
  return std::string(reinterpret_cast<const char *>(source),
                     static_cast<std::size_t>(count));
}

void SQLiteStore::Statement::bind(int index, int64_t value) {
  if (sqlite3_bind_int64(statement_, index, value) != SQLITE_OK) {
    throw sqlite_error(sqlite3_db_handle(statement_), "CitizenSDK SQLite integer bind failed");
  }
}

void SQLiteStore::Statement::bind(int index, const std::string &value) {
  if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()) ||
      sqlite3_bind_text(statement_, index, value.data(),
                        static_cast<int>(value.size()), SQLITE_TRANSIENT) != SQLITE_OK) {
    throw sqlite_error(sqlite3_db_handle(statement_), "CitizenSDK SQLite text bind failed");
  }
}

void SQLiteStore::Statement::bind(int index, const Bytes &value) {
  // A non-null zero-length view denotes an empty BLOB, not SQL NULL. Keep
  // both conditional operands the same pointer type for strict C++ builds.
  static constexpr uint8_t empty_blob = 0;
  const void *bytes = value.empty() ? &empty_blob : value.data();
  if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()) ||
      sqlite3_bind_blob(statement_, index, bytes, static_cast<int>(value.size()),
                        SQLITE_TRANSIENT) != SQLITE_OK) {
    throw sqlite_error(sqlite3_db_handle(statement_), "CitizenSDK SQLite blob bind failed");
  }
}

bool SQLiteStore::Statement::step_row_or_done() {
  const int code = sqlite3_step(statement_);
  if (code == SQLITE_ROW) return true;
  if (code == SQLITE_DONE) return false;
  throw sqlite_error(sqlite3_db_handle(statement_), "CitizenSDK SQLite read failed");
}

void SQLiteStore::Statement::step_done() {
  if (sqlite3_step(statement_) != SQLITE_DONE) {
    throw sqlite_error(sqlite3_db_handle(statement_), "CitizenSDK SQLite write failed");
  }
}

int64_t SQLiteStore::Statement::integer(int column, int64_t minimum,
                                        int64_t maximum) const {
  if (sqlite3_column_type(statement_, column) != SQLITE_INTEGER) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK SQLite integer has an invalid storage type");
  }
  const int64_t value = sqlite3_column_int64(statement_, column);
  if (value < minimum || value > maximum) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK SQLite integer violates its schema bounds");
  }
  return value;
}

Bytes SQLiteStore::Statement::bytes(int column, int maximum) const {
  if (maximum < 0 || sqlite3_column_type(statement_, column) != SQLITE_BLOB) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK SQLite blob has an invalid storage type");
  }
  const int count = sqlite3_column_bytes(statement_, column);
  const auto *source = static_cast<const uint8_t *>(sqlite3_column_blob(statement_, column));
  if (count < 0 || count > maximum) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK SQLite blob violates its schema bounds");
  }
  if (count <= 0 || source == nullptr) return {};
  return Bytes(source, source + count);
}

namespace {

std::string canonical_schema_sql(const std::string &sql) {
  std::string canonical;
  canonical.reserve(sql.size());
  char quote = '\0';
  for (std::size_t index = 0; index < sql.size(); ++index) {
    const char character = sql[index];
    if (quote != '\0') {
      canonical.push_back(character);
      const char terminator = quote == '[' ? ']' : quote;
      if (character == terminator) {
        if (quote != '[' && index + 1 < sql.size() &&
            sql[index + 1] == terminator) {
          canonical.push_back(sql[++index]);
        } else {
          quote = '\0';
        }
      }
      continue;
    }
    if (character == '\'' || character == '"' || character == '`' ||
        character == '[') {
      quote = character;
      canonical.push_back(character);
      continue;
    }
    const unsigned char byte = static_cast<unsigned char>(character);
    if (byte == ' ' || byte == '\t' || byte == '\r' || byte == '\n') continue;
    canonical.push_back(static_cast<char>(std::tolower(byte)));
  }
  require(quote == '\0', CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK SQLite schema contains an unterminated quoted token");
  constexpr std::string_view create_prefix = "createtable";
  constexpr std::string_view create_index_prefix = "createindex";
  constexpr std::string_view optional_clause = "ifnotexists";
  if (canonical.size() >= create_prefix.size() + optional_clause.size() &&
      canonical.compare(create_prefix.size(), optional_clause.size(),
                        optional_clause) == 0) {
    canonical.erase(create_prefix.size(), optional_clause.size());
  } else if (canonical.size() >=
                 create_index_prefix.size() + optional_clause.size() &&
             canonical.compare(create_index_prefix.size(), optional_clause.size(),
                               optional_clause) == 0) {
    canonical.erase(create_index_prefix.size(), optional_clause.size());
  }
  return canonical;
}

std::pair<std::string, std::string> expected_schema_object(const std::string &sql) {
  constexpr std::string_view table_prefix = "CREATE TABLE IF NOT EXISTS ";
  constexpr std::string_view index_prefix = "CREATE INDEX IF NOT EXISTS ";
  const bool table = sql.compare(0, table_prefix.size(), table_prefix.data(),
                                 table_prefix.size()) == 0;
  const std::string_view prefix = table ? table_prefix : index_prefix;
  require(table || sql.compare(0, index_prefix.size(), index_prefix.data(),
                               index_prefix.size()) == 0,
          CITIZENSDK_ERROR_INTERNAL,
          "CitizenSDK embedded SQLite schema is malformed");
  const std::size_t end = sql.find(table ? '(' : ' ', prefix.size());
  require(end != std::string::npos && end > prefix.size(),
          CITIZENSDK_ERROR_INTERNAL,
          "CitizenSDK embedded SQLite table name is malformed");
  std::size_t trimmed_end = end;
  while (trimmed_end > prefix.size() && sql[trimmed_end - 1] == ' ') {
    --trimmed_end;
  }
  const std::string name = sql.substr(prefix.size(),
                                      trimmed_end - prefix.size());
  require(!name.empty() && name.find_first_not_of(
              "abcdefghijklmnopqrstuvwxyz_0123456789") == std::string::npos,
          CITIZENSDK_ERROR_INTERNAL,
          "CitizenSDK embedded SQLite table identifier is invalid");
  return {table ? "table" : "index", name};
}

void expect_single_row(SQLiteStore::Statement &statement,
                       const char *message) {
  require(statement.step_row_or_done(), CITIZENSDK_ERROR_INTEGRITY, message);
}

void expect_no_second_row(SQLiteStore::Statement &statement,
                          const char *message) {
  require(!statement.step_row_or_done(), CITIZENSDK_ERROR_INTEGRITY, message);
}

void verify_schema(sqlite3 *database,
                   const std::vector<std::string> &schema) {
  // GLOB 中 '_' 为字面字符；LIKE 会把 sqlitex_* 表/触发器错误排除在闭集之外。
  SQLiteStore::Statement count(
      database,
      "SELECT count(*) FROM sqlite_master "
      "WHERE name NOT GLOB 'sqlite_*'");
  expect_single_row(count, "CitizenSDK SQLite schema count is unavailable");
  (void)count.integer(0, static_cast<int64_t>(schema.size()),
                      static_cast<int64_t>(schema.size()));
  expect_no_second_row(count, "CitizenSDK SQLite schema count is ambiguous");
  for (const std::string &expected_sql : schema) {
    const auto [type, name] = expected_schema_object(expected_sql);
    SQLiteStore::Statement query(
        database,
        "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?");
    query.bind(1, type);
    query.bind(2, name);
    expect_single_row(query, "CitizenSDK SQLite table is missing");
    const std::string actual_sql = query.text(0, 65536);
    require(canonical_schema_sql(actual_sql) ==
                canonical_schema_sql(expected_sql),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK SQLite table schema differs from its fixed contract");
    expect_no_second_row(query, "CitizenSDK SQLite table identity is ambiguous");
  }
}

void verify_integer_pragma(sqlite3 *database, const char *sql,
                           int64_t expected, const char *message) {
  SQLiteStore::Statement query(database, sql);
  expect_single_row(query, message);
  (void)query.integer(0, expected, expected);
  expect_no_second_row(query, message);
}

void verify_text_pragma(sqlite3 *database, const char *sql,
                        const std::string &expected, const char *message) {
  SQLiteStore::Statement query(database, sql);
  expect_single_row(query, message);
  std::string actual = query.text(0, 128);
  std::transform(actual.begin(), actual.end(), actual.begin(),
                 [](char character) {
                   return static_cast<char>(std::tolower(
                       static_cast<unsigned char>(character)));
                 });
  require(actual == expected, CITIZENSDK_ERROR_INTEGRITY, message);
  expect_no_second_row(query, message);
}

void configure_and_verify_database(
    sqlite3 *database, const std::vector<std::string> &schema, bool secure,
    int schema_version, bool incremental_vacuum) {
  const auto execute_checked = [database](const char *sql) {
    if (sqlite3_exec(database, sql, nullptr, nullptr, nullptr) != SQLITE_OK) {
      throw sqlite_error(database, "CitizenSDK SQLite command failed");
    }
  };
  int configured = 0;
  require(sqlite3_extended_result_codes(database, 1) == SQLITE_OK &&
              sqlite3_db_config(database,
                                SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
                                0, &configured) == SQLITE_OK && configured == 0,
          CITIZENSDK_ERROR_STORAGE,
          "CitizenSDK SQLite defensive configuration failed");
  require(sqlite3_db_config(database, SQLITE_DBCONFIG_DEFENSIVE,
                            1, &configured) == SQLITE_OK && configured == 1,
          CITIZENSDK_ERROR_STORAGE,
          "CitizenSDK SQLite defensive mode could not be enabled");

  int64_t version = 0;
  {
    SQLiteStore::Statement version_query(database, "PRAGMA user_version");
    expect_single_row(version_query,
                      "CitizenSDK SQLite schema version is unavailable");
    version = version_query.integer(0, 0, 0x7fffffff);
    expect_no_second_row(version_query,
                         "CitizenSDK SQLite schema version is ambiguous");
  }
  int64_t objects = 0;
  {
    SQLiteStore::Statement object_count(
        database,
        "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'");
    expect_single_row(object_count,
                      "CitizenSDK SQLite object count is unavailable");
    objects = object_count.integer(
        0, 0, std::numeric_limits<int64_t>::max());
    expect_no_second_row(object_count,
                         "CitizenSDK SQLite object count is ambiguous");
  }
  const bool initialize = version == 0 && objects == 0;
  require(schema_version > 0 && schema_version <= 0x7fffffff,
          CITIZENSDK_ERROR_INTERNAL,
          "CitizenSDK embedded SQLite schema version is invalid");
  require(initialize || version == schema_version, CITIZENSDK_ERROR_INTEGRITY,
          "CitizenSDK SQLite schema version is unknown");
  if (initialize) {
    // Schema 和版本标记沿用同一 rollback-journal 事务；正式记录之后才用 WAL+FULL。
    // Windows 没有目录 fsync 合同，此处不把进程崩溃恢复夸大为所有硬件掉电保证。
    execute_checked("BEGIN IMMEDIATE");
    try {
      if (incremental_vacuum) execute_checked("PRAGMA auto_vacuum=INCREMENTAL");
      for (const std::string &statement : schema) {
        execute_checked(statement.c_str());
      }
      const std::string version_sql =
          "PRAGMA user_version=" + std::to_string(schema_version);
      execute_checked(version_sql.c_str());
      verify_schema(database, schema);
      verify_integer_pragma(database, "PRAGMA user_version", schema_version,
                            "CitizenSDK SQLite schema version differs");
      execute_checked("COMMIT");
    } catch (...) {
      try { execute_checked("ROLLBACK"); } catch (...) {}
      throw;
    }
  } else {
    // Reject unknown/extra objects before journal-mode or other persistent
    // configuration can mutate an existing database.
    verify_schema(database, schema);
  }

  execute_checked("PRAGMA journal_mode=WAL");
  execute_checked("PRAGMA synchronous=FULL");
  execute_checked("PRAGMA foreign_keys=ON");
  execute_checked("PRAGMA busy_timeout=5000");
  execute_checked("PRAGMA temp_store=MEMORY");
  execute_checked("PRAGMA trusted_schema=OFF");
  execute_checked("PRAGMA wal_autocheckpoint=1000");
  execute_checked(secure ? "PRAGMA secure_delete=ON"
                         : "PRAGMA secure_delete=OFF");
  verify_text_pragma(database, "PRAGMA journal_mode", "wal",
                     "CitizenSDK SQLite journal mode is not WAL");
  verify_integer_pragma(database, "PRAGMA synchronous", 2,
                        "CitizenSDK SQLite synchronous mode is not FULL");
  verify_integer_pragma(database, "PRAGMA foreign_keys", 1,
                        "CitizenSDK SQLite foreign-key mode is disabled");
  verify_integer_pragma(database, "PRAGMA busy_timeout", 5000,
                        "CitizenSDK SQLite busy timeout differs from contract");
  verify_integer_pragma(database, "PRAGMA temp_store", 2,
                        "CitizenSDK SQLite temp store is not memory-only");
  verify_integer_pragma(database, "PRAGMA trusted_schema", 0,
                        "CitizenSDK SQLite trusted schema is enabled");
  verify_integer_pragma(database, "PRAGMA wal_autocheckpoint", 1000,
                        "CitizenSDK SQLite WAL checkpoint policy differs");
  verify_integer_pragma(database, "PRAGMA user_version", schema_version,
                        "CitizenSDK SQLite schema version differs");
  verify_integer_pragma(database, "PRAGMA auto_vacuum",
                        incremental_vacuum ? 2 : 0,
                        "CitizenSDK SQLite auto-vacuum policy differs");
  verify_integer_pragma(database, "PRAGMA secure_delete", secure ? 1 : 0,
                        "CitizenSDK SQLite secure-delete policy differs");
}

}  // namespace


SQLiteStore::SQLiteStore(const std::filesystem::path &directory, const char *file_name,
                         const std::vector<std::string> &schema, bool secure,
                         int schema_version, bool incremental_vacuum) {
  require(file_name != nullptr && file_name[0] != '\0' &&
              std::strchr(file_name, '/') == nullptr && std::strchr(file_name, '\\') == nullptr,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK SQLite file name is invalid");
  file_name_ = file_name;
  directory_ = std::make_shared<Directory>(directory);
  try {
    enforce_file_permissions();
    vfs_ = std::make_unique<HandleSQLiteVfs>(directory_, file_name_);
    const int flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX |
                      SQLITE_OPEN_PRIVATECACHE | SQLITE_OPEN_NOFOLLOW;
    if (sqlite3_open_v2(file_name_.c_str(), &database_, flags, vfs_->name()) != SQLITE_OK ||
        database_ == nullptr) {
      sqlite3 *failed = database_;
      database_ = nullptr;
      HostError error = sqlite_error(failed, "CitizenSDK state store could not be opened");
      if (failed != nullptr) sqlite3_close_v2(failed);
      throw error;
    }
    enforce_file_permissions();
    configure_and_verify_database(database_, schema, secure, schema_version,
                                  incremental_vacuum);
    enforce_file_permissions();
  } catch (...) {
    close();
    throw;
  }
}

SQLiteStore::~SQLiteStore() { close(); }

void SQLiteStore::close() noexcept {
  std::lock_guard<std::recursive_mutex> guard(lock_);
  if (database_ != nullptr) {
    if (sqlite3_close(database_) != SQLITE_OK) std::terminate();
    database_ = nullptr;
  }
  vfs_.reset();
  directory_.reset();
}

void SQLiteStore::enforce_file_permissions() {
  require(directory_ != nullptr, CITIZENSDK_ERROR_STORAGE, "CitizenSDK state directory is closed");
  directory_->verify();
  // 主库和每个 sidecar 都独立做同句柄检查；不能仅保护主库后让 SQLite 另开路径。
  const std::array<std::string, 4> names{
    file_name_, file_name_ + "-journal", file_name_ + "-wal", file_name_ + "-shm"
  };
  for (const auto &name : names) {
    auto file = directory_->find(Directory::utf16(name), GENERIC_READ | GENERIC_WRITE);
    if (file) directory_->verify_file(file->get());
  }
  if (database_ != nullptr) {
    int moved = 1;
    require(sqlite3_file_control(database_, "main", SQLITE_FCNTL_HAS_MOVED, &moved) == SQLITE_OK &&
                moved == 0, CITIZENSDK_ERROR_PERMISSION_DENIED,
            "CitizenSDK database identity changed while open");
  }
}

void SQLiteStore::execute(sqlite3 *database, const char *sql) {
  if (sqlite3_exec(database, sql, nullptr, nullptr, nullptr) != SQLITE_OK) {
    throw sqlite_error(database, "CitizenSDK SQLite command failed");
  }
}

}  // namespace citizen_sdk::windows
