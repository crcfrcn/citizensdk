#include "citizen_sdk_sqlite.hpp"

#include <algorithm>
#include <atomic>
#include <array>
#include <cerrno>
#include <cctype>
#include <cstring>
#include <exception>
#include <limits>
#include <new>
#include <string_view>
#include <utility>
#include <vector>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef SQLITE_OPEN_NOFOLLOW
#error "CitizenSDK requires SQLite SQLITE_OPEN_NOFOLLOW support"
#endif
#ifndef F_OFD_SETLK
#error "CitizenSDK requires Linux open-file-description locks"
#endif
#ifndef F_OFD_GETLK
#error "CitizenSDK requires Linux open-file-description lock queries"
#endif

namespace citizen_sdk::linux {
namespace {

class UniqueFd final {
 public:
  explicit UniqueFd(int value = -1) noexcept : value_(value) {}
  UniqueFd(const UniqueFd &) = delete;
  UniqueFd &operator=(const UniqueFd &) = delete;
  ~UniqueFd() {
    if (value_ >= 0) ::close(value_);
  }
  int get() const noexcept { return value_; }
  int release() noexcept {
    const int result = value_;
    value_ = -1;
    return result;
  }
  void reset(int value = -1) noexcept {
    if (value_ >= 0) ::close(value_);
    value_ = value;
  }

 private:
  int value_;
};

HostError sqlite_error(sqlite3 *database, const char *fallback) {
  return HostError(CITIZENSDK_ERROR_STORAGE,
                   database == nullptr ? fallback : sqlite3_errmsg(database));
}

}  // namespace

/* A private SQLite VFS is used instead of a /proc/self/fd pathname. Every
 * named database, journal and WAL file is opened relative to the already
 * validated data-root descriptor with O_NOFOLLOW; all SQLite I/O then stays
 * on that exact descriptor. The implementation deliberately has no fallback
 * to SQLite's path-opening Unix VFS. */
class OpenAtSQLiteVfs final {
 public:
  OpenAtSQLiteVfs(int directory_fd, std::string database_name)
      : directory_fd_(directory_fd), database_name_(std::move(database_name)) {
    require(directory_fd_ >= 0 && allowed_name(database_name_.c_str()),
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK SQLite VFS configuration is invalid");
    sqlite3_vfs *delegate = sqlite3_vfs_find(nullptr);
    require(delegate != nullptr, CITIZENSDK_ERROR_STORAGE,
            "CitizenSDK SQLite platform VFS is unavailable");
    delegate_ = delegate;
    static std::atomic<uint64_t> next_identity{1};
    uint64_t identity = next_identity.load();
    for (;;) {
      require(identity != 0 && identity != std::numeric_limits<uint64_t>::max(),
              CITIZENSDK_ERROR_UNAVAILABLE,
              "CitizenSDK SQLite VFS identity space is exhausted");
      if (next_identity.compare_exchange_weak(identity, identity + 1)) break;
    }
    name_ = "citizensdk-openat-v1-" + std::to_string(identity);
    vfs_.iVersion = 3;
    vfs_.szOsFile = static_cast<int>(sizeof(OpenFile));
    vfs_.mxPathname = 4096;
    vfs_.zName = name_.c_str();
    vfs_.pAppData = this;
    vfs_.xOpen = &open_callback;
    vfs_.xDelete = &delete_callback;
    vfs_.xAccess = &access_callback;
    vfs_.xFullPathname = &full_path_callback;
    vfs_.xDlOpen = &dl_open_callback;
    vfs_.xDlError = &dl_error_callback;
    vfs_.xDlSym = &dl_symbol_callback;
    vfs_.xDlClose = &dl_close_callback;
    vfs_.xRandomness = &randomness_callback;
    vfs_.xSleep = &sleep_callback;
    vfs_.xCurrentTime = &current_time_callback;
    vfs_.xGetLastError = &last_error_callback;
    vfs_.xCurrentTimeInt64 = &current_time_int64_callback;
    vfs_.xSetSystemCall = &set_system_call_callback;
    vfs_.xGetSystemCall = &get_system_call_callback;
    vfs_.xNextSystemCall = &next_system_call_callback;
    require(sqlite3_vfs_register(&vfs_, 0) == SQLITE_OK,
            CITIZENSDK_ERROR_STORAGE,
            "CitizenSDK SQLite openat VFS could not be registered");
    registered_ = true;
  }

  OpenAtSQLiteVfs(const OpenAtSQLiteVfs &) = delete;
  OpenAtSQLiteVfs &operator=(const OpenAtSQLiteVfs &) = delete;
  ~OpenAtSQLiteVfs() {
    if (registered_) (void)sqlite3_vfs_unregister(&vfs_);
  }

  const char *name() const noexcept { return name_.c_str(); }

 private:
  struct Mapping final {
    void *address{};
    std::size_t length{};
  };

  struct FileState final {
    OpenAtSQLiteVfs *owner{};
    int descriptor{-1};
    std::string name;
    bool delete_on_close{false};
    int lock_level{SQLITE_LOCK_NONE};
    int shared_memory_descriptor{-1};
    int shared_memory_page_size{0};
    std::string shared_memory_name;
    std::vector<Mapping> mappings;
  };

  struct OpenFile final {
    sqlite3_file base;
    FileState *state;
  };

  static OpenFile *file(sqlite3_file *value) noexcept {
    return reinterpret_cast<OpenFile *>(value);
  }
  static const OpenFile *file(const sqlite3_file *value) noexcept {
    return reinterpret_cast<const OpenFile *>(value);
  }
  static OpenAtSQLiteVfs *owner(sqlite3_vfs *value) noexcept {
    return static_cast<OpenAtSQLiteVfs *>(value->pAppData);
  }

  static bool descriptor_matches_path(const FileState &state) noexcept {
    if (state.descriptor < 0) return false;
    struct stat opened {};
    if (::fstat(state.descriptor, &opened) != 0 ||
        !S_ISREG(opened.st_mode) || opened.st_uid != ::geteuid()) {
      return false;
    }
    // O_TMPFILE objects have no directory entry and are deliberately private.
    if (state.name.empty()) return opened.st_nlink == 0;
    struct stat path {};
    return opened.st_nlink == 1 &&
           ::fstatat(state.owner->directory_fd_, state.name.c_str(), &path,
                     AT_SYMLINK_NOFOLLOW) == 0 &&
           S_ISREG(path.st_mode) && path.st_nlink == 1 &&
           path.st_uid == ::geteuid() && opened.st_dev == path.st_dev &&
           opened.st_ino == path.st_ino;
  }

  static bool shared_memory_matches_path(const FileState &state) noexcept {
    if (state.shared_memory_descriptor < 0 ||
        state.shared_memory_name.empty()) {
      return false;
    }
    struct stat opened {}, path {};
    return ::fstat(state.shared_memory_descriptor, &opened) == 0 &&
           S_ISREG(opened.st_mode) && opened.st_nlink == 1 &&
           opened.st_uid == ::geteuid() &&
           ::fstatat(state.owner->directory_fd_,
                     state.shared_memory_name.c_str(), &path,
                     AT_SYMLINK_NOFOLLOW) == 0 &&
           S_ISREG(path.st_mode) && path.st_nlink == 1 &&
           path.st_uid == ::geteuid() && opened.st_dev == path.st_dev &&
           opened.st_ino == path.st_ino;
  }

  bool allowed_name(const char *value) const noexcept {
    if (value == nullptr || value[0] == '\0') return false;
    const std::string_view name(value);
    if (name.find('/') != std::string_view::npos ||
        name.find('\\') != std::string_view::npos ||
        name == "." || name == "..") {
      return false;
    }
    if (name == database_name_) return true;
    if (name.size() <= database_name_.size() ||
        name.compare(0, database_name_.size(), database_name_) != 0) {
      return false;
    }
    const std::string_view suffix = name.substr(database_name_.size());
    return suffix == "-journal" || suffix == "-wal" || suffix == "-shm";
  }

  int open_named(const char *name, int sqlite_flags) const noexcept {
    if (!allowed_name(name)) {
      errno = EPERM;
      return -1;
    }
    int flags = O_CLOEXEC | O_NOFOLLOW;
    flags |= (sqlite_flags & SQLITE_OPEN_READONLY) != 0 ? O_RDONLY : O_RDWR;
    if ((sqlite_flags & SQLITE_OPEN_CREATE) != 0) flags |= O_CREAT;
    if ((sqlite_flags & SQLITE_OPEN_EXCLUSIVE) != 0) flags |= O_EXCL;
    int descriptor;
    do {
      descriptor = ::openat(directory_fd_, name, flags, 0600);
    } while (descriptor < 0 && errno == EINTR);
    if (descriptor < 0) return -1;
    struct stat opened {}, confirmed {};
    const bool valid = ::fstat(descriptor, &opened) == 0 &&
        S_ISREG(opened.st_mode) && opened.st_nlink == 1 &&
        opened.st_uid == ::geteuid() && ::fchmod(descriptor, 0600) == 0 &&
        ::fstatat(directory_fd_, name, &confirmed, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(confirmed.st_mode) && confirmed.st_nlink == 1 &&
        confirmed.st_uid == ::geteuid() && opened.st_dev == confirmed.st_dev &&
        opened.st_ino == confirmed.st_ino;
    if (!valid || ::fsync(directory_fd_) != 0) {
      (void)::close(descriptor);
      if (valid) errno = EIO;
      else errno = EPERM;
      return -1;
    }
    return descriptor;
  }

  int open_temporary() const noexcept {
#ifdef O_TMPFILE
    int descriptor;
    do {
      descriptor = ::openat(directory_fd_, ".",
                            O_RDWR | O_CLOEXEC | O_TMPFILE, 0600);
    } while (descriptor < 0 && errno == EINTR);
    return descriptor;
#else
    errno = ENOTSUP;
    return -1;
#endif
  }

  static int open_callback(sqlite3_vfs *vfs, const char *name,
                           sqlite3_file *output, int flags,
                           int *out_flags) noexcept {
    if (vfs == nullptr || output == nullptr || vfs->pAppData == nullptr) {
      return SQLITE_CANTOPEN;
    }
    std::memset(output, 0, sizeof(OpenFile));
    try {
      OpenAtSQLiteVfs *self = owner(vfs);
      if ((flags & SQLITE_OPEN_MAIN_DB) != 0 &&
          (flags & SQLITE_OPEN_NOFOLLOW) == 0) {
        return SQLITE_CANTOPEN;
      }
      const int descriptor = name == nullptr
                                 ? self->open_temporary()
                                 : self->open_named(name, flags);
      if (descriptor < 0) return SQLITE_CANTOPEN;
      std::unique_ptr<FileState> state;
      try {
        state = std::make_unique<FileState>();
        state->owner = self;
        state->descriptor = descriptor;
        if (name != nullptr) state->name = name;
        state->delete_on_close =
            (flags & SQLITE_OPEN_DELETEONCLOSE) != 0;
      } catch (...) {
        (void)::close(descriptor);
        throw;
      }
      OpenFile *opened = file(output);
      opened->state = state.release();
      opened->base.pMethods = &io_methods_;
      if (out_flags != nullptr) {
        *out_flags = (flags & SQLITE_OPEN_READONLY) != 0
                         ? SQLITE_OPEN_READONLY
                         : SQLITE_OPEN_READWRITE;
      }
      return SQLITE_OK;
    } catch (const std::bad_alloc &) {
      return SQLITE_NOMEM;
    } catch (...) {
      return SQLITE_CANTOPEN;
    }
  }

  static int delete_callback(sqlite3_vfs *vfs, const char *name,
                             int synchronize_directory) noexcept {
    OpenAtSQLiteVfs *self = owner(vfs);
    if (!self->allowed_name(name)) return SQLITE_IOERR_DELETE;
    struct stat status {};
    if (::fstatat(self->directory_fd_, name, &status,
                  AT_SYMLINK_NOFOLLOW) != 0) {
      return errno == ENOENT ? SQLITE_IOERR_DELETE_NOENT : SQLITE_IOERR_DELETE;
    }
    if (!S_ISREG(status.st_mode) || status.st_nlink != 1 ||
        status.st_uid != ::geteuid()) {
      return SQLITE_IOERR_DELETE;
    }
    if (::unlinkat(self->directory_fd_, name, 0) != 0) {
      return errno == ENOENT ? SQLITE_IOERR_DELETE_NOENT : SQLITE_IOERR_DELETE;
    }
    if (synchronize_directory != 0 && ::fsync(self->directory_fd_) != 0) {
      return SQLITE_IOERR_DIR_FSYNC;
    }
    return SQLITE_OK;
  }

  static int access_callback(sqlite3_vfs *vfs, const char *name,
                             int flags, int *out_result) noexcept {
    if (out_result == nullptr) return SQLITE_IOERR_ACCESS;
    *out_result = 0;
    OpenAtSQLiteVfs *self = owner(vfs);
    if (!self->allowed_name(name)) return SQLITE_IOERR_ACCESS;
    struct stat status {};
    if (::fstatat(self->directory_fd_, name, &status,
                  AT_SYMLINK_NOFOLLOW) != 0) {
      return errno == ENOENT ? SQLITE_OK : SQLITE_IOERR_ACCESS;
    }
    if (!S_ISREG(status.st_mode) || status.st_nlink != 1 ||
        status.st_uid != ::geteuid()) {
      return SQLITE_IOERR_ACCESS;
    }
    if (flags == SQLITE_ACCESS_EXISTS) {
      *out_result = 1;
    } else if (flags == SQLITE_ACCESS_READ ||
               flags == SQLITE_ACCESS_READWRITE) {
      const mode_t required = flags == SQLITE_ACCESS_READ
                                  ? S_IRUSR
                                  : static_cast<mode_t>(S_IRUSR | S_IWUSR);
      *out_result = (status.st_mode & required) == required;
    }
    return SQLITE_OK;
  }

  static int full_path_callback(sqlite3_vfs *vfs, const char *name,
                                int capacity, char *output) noexcept {
    OpenAtSQLiteVfs *self = owner(vfs);
    if (!self->allowed_name(name) || output == nullptr || capacity <= 0) {
      return SQLITE_CANTOPEN;
    }
    const std::size_t length = std::strlen(name);
    if (length + 1 > static_cast<std::size_t>(capacity)) {
      return SQLITE_CANTOPEN;
    }
    std::memcpy(output, name, length + 1);
    return SQLITE_OK;
  }

  static void *dl_open_callback(sqlite3_vfs *, const char *) noexcept {
    // CitizenSDK never permits a database to load process extensions.
    return nullptr;
  }
  static void dl_error_callback(sqlite3_vfs *, int capacity,
                                char *message) noexcept {
    if (capacity <= 0 || message == nullptr) return;
    constexpr char error[] = "CitizenSDK SQLite extensions are disabled";
    const std::size_t count = std::min(sizeof(error) - 1,
                                       static_cast<std::size_t>(capacity - 1));
    std::memcpy(message, error, count);
    message[count] = '\0';
  }
  static void (*dl_symbol_callback(sqlite3_vfs *, void *, const char *))(void) {
    return nullptr;
  }
  static void dl_close_callback(sqlite3_vfs *, void *) noexcept {}
  static int randomness_callback(sqlite3_vfs *vfs, int count,
                                 char *output) noexcept {
    sqlite3_vfs *delegate = owner(vfs)->delegate_;
    return delegate->xRandomness == nullptr
               ? 0
               : delegate->xRandomness(delegate, count, output);
  }
  static int sleep_callback(sqlite3_vfs *vfs, int microseconds) noexcept {
    sqlite3_vfs *delegate = owner(vfs)->delegate_;
    return delegate->xSleep == nullptr
               ? 0
               : delegate->xSleep(delegate, microseconds);
  }
  static int current_time_callback(sqlite3_vfs *vfs,
                                   double *time) noexcept {
    sqlite3_vfs *delegate = owner(vfs)->delegate_;
    return delegate->xCurrentTime == nullptr
               ? SQLITE_ERROR
               : delegate->xCurrentTime(delegate, time);
  }
  static int last_error_callback(sqlite3_vfs *vfs, int capacity,
                                 char *message) noexcept {
    sqlite3_vfs *delegate = owner(vfs)->delegate_;
    return delegate->xGetLastError == nullptr
               ? 0
               : delegate->xGetLastError(delegate, capacity, message);
  }
  static int current_time_int64_callback(sqlite3_vfs *vfs,
                                         sqlite3_int64 *time) noexcept {
    sqlite3_vfs *delegate = owner(vfs)->delegate_;
    if (delegate->iVersion >= 2 && delegate->xCurrentTimeInt64 != nullptr) {
      return delegate->xCurrentTimeInt64(delegate, time);
    }
    double julian = 0;
    const int code = current_time_callback(vfs, &julian);
    if (code == SQLITE_OK && time != nullptr) {
      *time = static_cast<sqlite3_int64>(julian * 86400000.0);
    }
    return code;
  }
  static int set_system_call_callback(sqlite3_vfs *, const char *,
                                      sqlite3_syscall_ptr) noexcept {
    // An embedding process cannot replace filesystem syscalls used by this VFS.
    return SQLITE_NOTFOUND;
  }
  static sqlite3_syscall_ptr get_system_call_callback(
      sqlite3_vfs *, const char *) noexcept {
    return nullptr;
  }
  static const char *next_system_call_callback(sqlite3_vfs *,
                                               const char *) noexcept {
    return nullptr;
  }

  static int close_file(sqlite3_file *value) noexcept {
    OpenFile *opened = file(value);
    FileState *state = opened->state;
    opened->state = nullptr;
    opened->base.pMethods = nullptr;
    if (state == nullptr) return SQLITE_OK;
    const bool owned_path = state->name.empty() ||
                            descriptor_matches_path(*state);
    for (const Mapping &mapping : state->mappings) {
      if (mapping.address != nullptr && mapping.length != 0) {
        (void)::munmap(mapping.address, mapping.length);
      }
    }
    if (state->shared_memory_descriptor >= 0) {
      (void)::close(state->shared_memory_descriptor);
    }
    if (state->descriptor >= 0) (void)::close(state->descriptor);
    if (state->delete_on_close && !state->name.empty() && owned_path) {
      (void)delete_callback(&state->owner->vfs_, state->name.c_str(), 0);
    }
    delete state;
    return SQLITE_OK;
  }

  static int read_file(sqlite3_file *value, void *output, int count,
                       sqlite3_int64 offset) noexcept {
    if (count < 0 || offset < 0 ||
        offset > std::numeric_limits<off_t>::max() ||
        static_cast<uint64_t>(count) >
            static_cast<uint64_t>(std::numeric_limits<off_t>::max() - offset)) {
      return SQLITE_IOERR_READ;
    }
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_READ;
    }
    if (count == 0) return SQLITE_OK;
    if (output == nullptr) return SQLITE_IOERR_READ;
    uint8_t *cursor = static_cast<uint8_t *>(output);
    int remaining = count;
    while (remaining > 0) {
      const ssize_t read = ::pread(state->descriptor, cursor,
                                   static_cast<std::size_t>(remaining),
                                   static_cast<off_t>(offset));
      if (read < 0 && errno == EINTR) continue;
      if (read < 0) return SQLITE_IOERR_READ;
      if (read == 0) {
        std::memset(cursor, 0, static_cast<std::size_t>(remaining));
        return SQLITE_IOERR_SHORT_READ;
      }
      cursor += read;
      remaining -= static_cast<int>(read);
      offset += read;
    }
    return SQLITE_OK;
  }

  static int write_file(sqlite3_file *value, const void *input, int count,
                        sqlite3_int64 offset) noexcept {
    if (count < 0 || offset < 0 ||
        offset > std::numeric_limits<off_t>::max() ||
        static_cast<uint64_t>(count) >
            static_cast<uint64_t>(std::numeric_limits<off_t>::max() - offset)) {
      return SQLITE_IOERR_WRITE;
    }
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_WRITE;
    }
    if (count == 0) return SQLITE_OK;
    if (input == nullptr) return SQLITE_IOERR_WRITE;
    const uint8_t *cursor = static_cast<const uint8_t *>(input);
    int remaining = count;
    while (remaining > 0) {
      const ssize_t written = ::pwrite(state->descriptor, cursor,
                                       static_cast<std::size_t>(remaining),
                                       static_cast<off_t>(offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) return SQLITE_IOERR_WRITE;
      cursor += written;
      remaining -= static_cast<int>(written);
      offset += written;
    }
    return SQLITE_OK;
  }

  static int truncate_file(sqlite3_file *value,
                           sqlite3_int64 size) noexcept {
    if (size < 0 || size > std::numeric_limits<off_t>::max()) {
      return SQLITE_IOERR_TRUNCATE;
    }
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_TRUNCATE;
    }
    return ::ftruncate(state->descriptor,
                       static_cast<off_t>(size)) == 0
               ? SQLITE_OK
               : SQLITE_IOERR_TRUNCATE;
  }

  static int sync_file(sqlite3_file *value, int flags) noexcept {
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_FSYNC;
    }
    const int descriptor = state->descriptor;
    int code;
    do {
      code = (flags & SQLITE_SYNC_DATAONLY) != 0
                 ? ::fdatasync(descriptor)
                 : ::fsync(descriptor);
    } while (code != 0 && errno == EINTR);
    return code == 0 ? SQLITE_OK : SQLITE_IOERR_FSYNC;
  }

  static int file_size(sqlite3_file *value,
                       sqlite3_int64 *out_size) noexcept {
    if (out_size == nullptr) return SQLITE_IOERR_FSTAT;
    struct stat status {};
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state) ||
        ::fstat(state->descriptor, &status) != 0 ||
        status.st_size < 0) {
      return SQLITE_IOERR_FSTAT;
    }
    *out_size = static_cast<sqlite3_int64>(status.st_size);
    return SQLITE_OK;
  }

  static int set_lock(int descriptor, short type, off_t start,
                      off_t length) noexcept {
    struct flock lock {};
    lock.l_type = type;
    lock.l_whence = SEEK_SET;
    lock.l_start = start;
    lock.l_len = length;
    int result;
    do { result = ::fcntl(descriptor, F_OFD_SETLK, &lock); }
    while (result != 0 && errno == EINTR);
    if (result == 0) return SQLITE_OK;
    return errno == EACCES || errno == EAGAIN ? SQLITE_BUSY
                                              : SQLITE_IOERR_LOCK;
  }

  static constexpr off_t kPendingByte = static_cast<off_t>(0x40000000);
  static constexpr off_t kReservedByte = kPendingByte + 1;
  static constexpr off_t kSharedFirst = kPendingByte + 2;
  static constexpr off_t kSharedSize = 510;

  static int lock_file(sqlite3_file *value, int requested) noexcept {
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_LOCK;
    }
    if (requested <= state->lock_level) return SQLITE_OK;
    if (requested == SQLITE_LOCK_SHARED) {
      int code = set_lock(state->descriptor, F_RDLCK, kPendingByte, 1);
      if (code != SQLITE_OK) return code;
      code = set_lock(state->descriptor, F_RDLCK, kSharedFirst, kSharedSize);
      (void)set_lock(state->descriptor, F_UNLCK, kPendingByte, 1);
      if (code == SQLITE_OK) state->lock_level = SQLITE_LOCK_SHARED;
      return code;
    }
    if (requested == SQLITE_LOCK_RESERVED) {
      const int code = set_lock(state->descriptor, F_WRLCK, kReservedByte, 1);
      if (code == SQLITE_OK) state->lock_level = SQLITE_LOCK_RESERVED;
      return code;
    }
    if (requested == SQLITE_LOCK_PENDING || requested == SQLITE_LOCK_EXCLUSIVE) {
      int code = set_lock(state->descriptor, F_WRLCK, kPendingByte, 1);
      if (code != SQLITE_OK) return code;
      state->lock_level = SQLITE_LOCK_PENDING;
      if (requested == SQLITE_LOCK_PENDING) return SQLITE_OK;
      code = set_lock(state->descriptor, F_WRLCK, kSharedFirst, kSharedSize);
      if (code == SQLITE_OK) state->lock_level = SQLITE_LOCK_EXCLUSIVE;
      return code;
    }
    return SQLITE_IOERR_LOCK;
  }

  static int unlock_file(sqlite3_file *value, int requested) noexcept {
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_UNLOCK;
    }
    if (requested >= state->lock_level) return SQLITE_OK;
    if (requested == SQLITE_LOCK_SHARED) {
      int code = set_lock(state->descriptor, F_RDLCK, kSharedFirst, kSharedSize);
      if (code != SQLITE_OK) return SQLITE_IOERR_UNLOCK;
      if (set_lock(state->descriptor, F_UNLCK, kPendingByte, 2) != SQLITE_OK) {
        return SQLITE_IOERR_UNLOCK;
      }
      state->lock_level = SQLITE_LOCK_SHARED;
      return SQLITE_OK;
    }
    if (requested == SQLITE_LOCK_NONE) {
      if (set_lock(state->descriptor, F_UNLCK, kPendingByte,
                   2 + kSharedSize) != SQLITE_OK) {
        return SQLITE_IOERR_UNLOCK;
      }
      state->lock_level = SQLITE_LOCK_NONE;
      return SQLITE_OK;
    }
    return SQLITE_IOERR_UNLOCK;
  }

  static int check_reserved_lock(sqlite3_file *value,
                                 int *out_reserved) noexcept {
    if (out_reserved == nullptr) return SQLITE_IOERR_CHECKRESERVEDLOCK;
    FileState *state = file(value)->state;
    if (state == nullptr || !descriptor_matches_path(*state)) {
      return SQLITE_IOERR_CHECKRESERVEDLOCK;
    }
    if (state->lock_level >= SQLITE_LOCK_RESERVED) {
      *out_reserved = 1;
      return SQLITE_OK;
    }
    struct flock lock {};
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = kReservedByte;
    lock.l_len = 1;
    int result;
    do { result = ::fcntl(state->descriptor, F_OFD_GETLK, &lock); }
    while (result != 0 && errno == EINTR);
    if (result != 0) return SQLITE_IOERR_CHECKRESERVEDLOCK;
    *out_reserved = lock.l_type == F_UNLCK ? 0 : 1;
    return SQLITE_OK;
  }

  static int file_control(sqlite3_file *value, int operation,
                          void *argument) noexcept {
    FileState *state = file(value)->state;
    if (state == nullptr || state->owner == nullptr) return SQLITE_IOERR;
    if (operation == SQLITE_FCNTL_LOCKSTATE && argument != nullptr) {
      *static_cast<int *>(argument) = state->lock_level;
      return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_HAS_MOVED && argument != nullptr) {
      int moved = 0;
      if (!state->name.empty()) {
        moved = !descriptor_matches_path(*state);
      }
      *static_cast<int *>(argument) = moved;
      return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_VFSNAME && argument != nullptr) {
      char **output = static_cast<char **>(argument);
      *output = sqlite3_mprintf("%s", state->owner->name_.c_str());
      return *output == nullptr ? SQLITE_NOMEM : SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_SYNC) return sync_file(value, 0);
    return SQLITE_NOTFOUND;
  }

  static int sector_size(sqlite3_file *) noexcept { return 4096; }
  static int device_characteristics(sqlite3_file *) noexcept { return 0; }

  // SQLite Unix VFS 的官方 WAL 锁区及 dead-man-switch 字节。OFD 锁
  // 绑定本连接的描述符，同进程另一个 SQLiteStore 关闭不会释放它。
  static constexpr off_t UNIX_SHM_BASE = (22 + SQLITE_SHM_NLOCK) * 4;
  static constexpr off_t UNIX_SHM_DMS = UNIX_SHM_BASE + SQLITE_SHM_NLOCK;

  static int initialize_shared_memory(FileState &state) noexcept {
    if (!shared_memory_matches_path(state)) return SQLITE_IOERR_SHMOPEN;
    struct flock lock {};
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = UNIX_SHM_DMS;
    lock.l_len = 1;
    int result;
    do { result = ::fcntl(state.shared_memory_descriptor, F_OFD_GETLK, &lock); }
    while (result != 0 && errno == EINTR);
    if (result != 0) return SQLITE_IOERR_SHMLOCK;
    if (lock.l_type == F_WRLCK) return SQLITE_BUSY;
    if (lock.l_type == F_UNLCK) {
      const int code = set_lock(state.shared_memory_descriptor, F_WRLCK,
                                UNIX_SHM_DMS, 1);
      if (code != SQLITE_OK) return code;
      // 只有独占 DMS 证明不存在存活连接后才清除非持久 WAL 索引。
      // 与官方 Unix VFS 一样截为 3 字节，让 SQLite 从 WAL 重建；
      // 数据库和 WAL 始终保留，不能拿旧 SHM 的自洽校验代替恢复。
      if (!shared_memory_matches_path(state)) return SQLITE_IOERR_SHMOPEN;
      do { result = ::ftruncate(state.shared_memory_descriptor, 3); }
      while (result != 0 && errno == EINTR);
      if (result != 0) return SQLITE_IOERR_SHMSIZE;
    }
    // 获取/降级为共享 DMS 后一直持有至 unmap/close，禁止先解锁再 mmap。
    return set_lock(state.shared_memory_descriptor, F_RDLCK, UNIX_SHM_DMS, 1);
  }

  static int shared_memory_map(sqlite3_file *value, int page,
                               int page_size, int extend,
                               void volatile **out_mapping) noexcept {
    if (out_mapping == nullptr || page < 0 || page_size <= 0 ||
        page_size > 1024 * 1024 || page >= 64 ||
        (extend != 0 && extend != 1)) {
      return SQLITE_IOERR_SHMMAP;
    }
    *out_mapping = nullptr;
    try {
      FileState *state = file(value)->state;
      if (state == nullptr || state->owner == nullptr || state->name.empty()) {
        return SQLITE_IOERR_SHMMAP;
      }
      if (state->shared_memory_descriptor < 0) {
        state->shared_memory_name = state->name + "-shm";
        if (extend == 0) {
          struct stat existing {};
          if (::fstatat(state->owner->directory_fd_,
                        state->shared_memory_name.c_str(), &existing,
                        AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT) {
            return SQLITE_OK;
          }
        }
        const int open_flags = SQLITE_OPEN_READWRITE |
            (extend != 0 ? SQLITE_OPEN_CREATE : 0);
        state->shared_memory_descriptor = state->owner->open_named(
            state->shared_memory_name.c_str(), open_flags);
        if (state->shared_memory_descriptor < 0) return SQLITE_IOERR_SHMOPEN;
        const int code = initialize_shared_memory(*state);
        if (code != SQLITE_OK) {
          (void)::close(state->shared_memory_descriptor);
          state->shared_memory_descriptor = -1;
          return code;
        }
        state->shared_memory_page_size = page_size;
      }
      if (!shared_memory_matches_path(*state)) return SQLITE_IOERR_SHMOPEN;
      if (state->shared_memory_page_size != page_size) {
        return SQLITE_IOERR_SHMSIZE;
      }
      if (state->mappings.size() <= static_cast<std::size_t>(page)) {
        state->mappings.resize(static_cast<std::size_t>(page) + 1);
      }
      Mapping &mapping = state->mappings[static_cast<std::size_t>(page)];
      if (mapping.address == nullptr) {
        const sqlite3_int64 required =
            static_cast<sqlite3_int64>(page + 1) * page_size;
        struct stat status {};
        if (::fstat(state->shared_memory_descriptor, &status) != 0) {
          return SQLITE_IOERR_SHMSIZE;
        }
        if (status.st_size < required) {
          if (extend == 0 ||
              ::ftruncate(state->shared_memory_descriptor,
                          static_cast<off_t>(required)) != 0) {
            return extend == 0 ? SQLITE_OK : SQLITE_IOERR_SHMSIZE;
          }
        }
        void *address = ::mmap(nullptr, static_cast<std::size_t>(page_size),
                               PROT_READ | PROT_WRITE, MAP_SHARED,
                               state->shared_memory_descriptor,
                               static_cast<off_t>(page) * page_size);
        if (address == MAP_FAILED) return SQLITE_IOERR_SHMMAP;
        mapping = {address, static_cast<std::size_t>(page_size)};
      }
      *out_mapping = mapping.address;
      return SQLITE_OK;
    } catch (const std::bad_alloc &) {
      return SQLITE_NOMEM;
    } catch (...) {
      return SQLITE_IOERR_SHMMAP;
    }
  }

  static int shared_memory_lock(sqlite3_file *value, int offset, int count,
                                int flags) noexcept {
    FileState *state = file(value)->state;
    if (state == nullptr || !shared_memory_matches_path(*state) || offset < 0 ||
        count <= 0 || offset > SQLITE_SHM_NLOCK - count ||
        offset > std::numeric_limits<off_t>::max() - count) {
      return SQLITE_IOERR_SHMLOCK;
    }
    const int operation = flags & (SQLITE_SHM_LOCK | SQLITE_SHM_UNLOCK);
    const int sharing = flags & (SQLITE_SHM_SHARED | SQLITE_SHM_EXCLUSIVE);
    if ((operation != SQLITE_SHM_LOCK && operation != SQLITE_SHM_UNLOCK) ||
        (sharing != SQLITE_SHM_SHARED && sharing != SQLITE_SHM_EXCLUSIVE) ||
        (flags & ~(SQLITE_SHM_LOCK | SQLITE_SHM_UNLOCK | SQLITE_SHM_SHARED |
                   SQLITE_SHM_EXCLUSIVE)) != 0) {
      return SQLITE_IOERR_SHMLOCK;
    }
    short type = F_UNLCK;
    if (operation == SQLITE_SHM_LOCK) {
      type = sharing == SQLITE_SHM_EXCLUSIVE ? F_WRLCK : F_RDLCK;
    }
    const int code = set_lock(state->shared_memory_descriptor, type,
                              UNIX_SHM_BASE + static_cast<off_t>(offset),
                              static_cast<off_t>(count));
    if (code == SQLITE_BUSY) return SQLITE_BUSY;
    return code == SQLITE_OK ? SQLITE_OK : SQLITE_IOERR_SHMLOCK;
  }

  static void shared_memory_barrier(sqlite3_file *) noexcept {
    std::atomic_thread_fence(std::memory_order_seq_cst);
  }

  static int shared_memory_unmap(sqlite3_file *value,
                                 int delete_file) noexcept {
    FileState *state = file(value)->state;
    if (state == nullptr || state->owner == nullptr) return SQLITE_IOERR_SHMMAP;
    const bool owned_path = state->shared_memory_descriptor < 0 ||
                            shared_memory_matches_path(*state);
    for (Mapping &mapping : state->mappings) {
      if (mapping.address != nullptr && mapping.length != 0) {
        (void)::munmap(mapping.address, mapping.length);
        mapping = {};
      }
    }
    state->mappings.clear();
    int result = SQLITE_OK;
    if (delete_file != 0 && !state->shared_memory_name.empty()) {
      if (!owned_path) {
        result = SQLITE_IOERR_DELETE;
      } else if (state->shared_memory_descriptor >= 0) {
        // 不能先关闭 DMS 再 unlink：另一进程可能已接入相同 SHM。
        // 有存活连接时保留文件；成功升级独占后仍需重新核对路径身份。
        const int code = set_lock(state->shared_memory_descriptor, F_WRLCK,
                                  UNIX_SHM_DMS, 1);
        if (code == SQLITE_OK) {
          if (!shared_memory_matches_path(*state)) {
            result = SQLITE_IOERR_DELETE;
          } else {
            result = delete_callback(&state->owner->vfs_,
                                      state->shared_memory_name.c_str(), 1);
            if (result == SQLITE_IOERR_DELETE_NOENT) result = SQLITE_OK;
          }
        } else if (code != SQLITE_BUSY) {
          result = SQLITE_IOERR_SHMLOCK;
        }
      }
    }
    if (state->shared_memory_descriptor >= 0) {
      (void)::close(state->shared_memory_descriptor);
      state->shared_memory_descriptor = -1;
    }
    state->shared_memory_page_size = 0;
    return result;
  }

  static int fetch_file(sqlite3_file *, sqlite3_int64, int,
                        void **output) noexcept {
    if (output == nullptr) return SQLITE_IOERR;
    *output = nullptr;
    return SQLITE_OK;
  }
  static int unfetch_file(sqlite3_file *value, sqlite3_int64,
                          void *) noexcept {
    FileState *state = file(value)->state;
    return state != nullptr && descriptor_matches_path(*state)
               ? SQLITE_OK
               : SQLITE_IOERR;
  }

  inline static const sqlite3_io_methods io_methods_ = {
      3, &close_file, &read_file, &write_file, &truncate_file, &sync_file,
      &file_size, &lock_file, &unlock_file, &check_reserved_lock,
      &file_control, &sector_size, &device_characteristics,
      &shared_memory_map, &shared_memory_lock, &shared_memory_barrier,
      &shared_memory_unmap, &fetch_file, &unfetch_file};

  int directory_fd_;
  std::string database_name_;
  std::string name_;
  sqlite3_vfs *delegate_{};
  sqlite3_vfs vfs_{};
  bool registered_{false};
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
             canonical.compare(create_index_prefix.size(),
                               optional_clause.size(), optional_clause) == 0) {
    canonical.erase(create_index_prefix.size(), optional_clause.size());
  }
  return canonical;
}

std::pair<std::string, std::string> expected_schema_object(
    const std::string &sql) {
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
    // Schema objects and their version marker are one rollback-journal
    // transaction. Power loss can therefore leave either the original empty
    // database or the complete v1 schema, never a version-zero partial schema.
    execute_checked("BEGIN IMMEDIATE");
    try {
      if (incremental_vacuum) {
        execute_checked("PRAGMA auto_vacuum=INCREMENTAL");
      }
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

int SQLiteStore::open_private_directory(const std::filesystem::path &directory) {
  require(directory.is_absolute(), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK storage root must be absolute");
  UniqueFd current(::open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (current.get() < 0) {
    throw HostError(CITIZENSDK_ERROR_STORAGE,
                    "CitizenSDK could not open the filesystem root");
  }
  for (const auto &part : directory) {
    const std::string name = part.string();
    if (name == "/" || name.empty()) continue;
    if (name == "." || name == "..") {
      throw HostError(CITIZENSDK_ERROR_INVALID_ARGUMENT,
                      "CitizenSDK storage path contains a forbidden component");
    }
    struct stat status {};
    bool created = false;
    if (::fstatat(current.get(), name.c_str(), &status,
                  AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno != ENOENT || ::mkdirat(current.get(), name.c_str(), 0700) != 0 ||
          ::fstatat(current.get(), name.c_str(), &status,
                    AT_SYMLINK_NOFOLLOW) != 0) {
        throw HostError(CITIZENSDK_ERROR_STORAGE,
                        "CitizenSDK storage directory could not be created");
      }
      created = true;
    }
    if (!S_ISDIR(status.st_mode) || S_ISLNK(status.st_mode)) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK storage path must not contain symbolic links");
    }
    if (created && ::fsync(current.get()) != 0) {
      throw HostError(CITIZENSDK_ERROR_STORAGE,
                      "CitizenSDK storage parent could not be synchronized");
    }
    UniqueFd next(::openat(current.get(), name.c_str(),
                           O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (next.get() < 0) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK storage directory changed during validation");
    }
    struct stat opened {};
    if (::fstat(next.get(), &opened) != 0 || !S_ISDIR(opened.st_mode) ||
        opened.st_dev != status.st_dev || opened.st_ino != status.st_ino) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK storage directory identity changed during validation");
    }
    current.reset(next.release());
  }
  struct stat final_directory {};
  if (::fstat(current.get(), &final_directory) != 0 ||
      !S_ISDIR(final_directory.st_mode) ||
      final_directory.st_uid != ::geteuid() ||
      ::fchmod(current.get(), 0700) != 0) {
    throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                    "CitizenSDK storage permissions could not be enforced");
  }
  return current.release();
}

SQLiteStore::SQLiteStore(const std::filesystem::path &directory,
                         const char *file_name,
                         const std::vector<std::string> &schema, bool secure,
                         int schema_version, bool incremental_vacuum) {
  require(file_name != nullptr && file_name[0] != '\0' &&
              std::strchr(file_name, '/') == nullptr &&
              std::strchr(file_name, '\\') == nullptr,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK SQLite file name is invalid");
  file_name_ = file_name;
  UniqueFd directory_handle(open_private_directory(directory));
  directory_fd_ = directory_handle.release();
  try {
    // Preflight all existing SQLite companions before SQLite sees the path.
    // SQLITE_OPEN_NOFOLLOW protects the main database final component; the
    // descriptor-backed private directory and repeated inode checks protect
    // the database, rollback journal, WAL and shared-memory files before and
    // after SQLite creates journal state.
    enforce_file_permissions();
    vfs_ = std::make_unique<OpenAtSQLiteVfs>(directory_fd_, file_name_);
    const int flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE |
                      SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_PRIVATECACHE |
                      SQLITE_OPEN_NOFOLLOW;
    if (sqlite3_open_v2(file_name_.c_str(), &database_, flags,
                        vfs_->name()) != SQLITE_OK ||
        database_ == nullptr) {
      sqlite3 *failed = database_;
      database_ = nullptr;
      HostError error = sqlite_error(
          failed, "CitizenSDK state store could not be opened");
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
  if (directory_fd_ >= 0) {
    ::close(directory_fd_);
    directory_fd_ = -1;
  }
}

void SQLiteStore::enforce_file_permissions() {
  if (directory_fd_ < 0) {
    throw HostError(CITIZENSDK_ERROR_STORAGE,
                    "CitizenSDK state directory is closed");
  }
  const std::array<std::string, 4> names{
      file_name_, file_name_ + "-journal", file_name_ + "-wal",
      file_name_ + "-shm"};
  for (const auto &name : names) {
    struct stat path_status {};
    if (::fstatat(directory_fd_, name.c_str(), &path_status,
                  AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      throw HostError(CITIZENSDK_ERROR_STORAGE,
                      "CitizenSDK database companion could not be inspected");
    }
    if (!S_ISREG(path_status.st_mode) || S_ISLNK(path_status.st_mode) ||
        path_status.st_nlink != 1 || path_status.st_uid != ::geteuid()) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK database companion is not a private regular file");
    }
    UniqueFd file(::openat(directory_fd_, name.c_str(),
                           O_RDWR | O_CLOEXEC | O_NOFOLLOW));
    if (file.get() < 0) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK database companion could not be locked safely");
    }
    struct stat opened {}, confirmed {};
    const bool valid = ::fstat(file.get(), &opened) == 0 &&
        S_ISREG(opened.st_mode) && opened.st_nlink == 1 &&
        opened.st_uid == ::geteuid() && ::fchmod(file.get(), 0600) == 0 &&
        ::fstatat(directory_fd_, name.c_str(), &confirmed,
                  AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(confirmed.st_mode) &&
        confirmed.st_nlink == 1 && confirmed.st_uid == ::geteuid() &&
        opened.st_dev == confirmed.st_dev && opened.st_ino == confirmed.st_ino;
    if (!valid) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK database companion changed during validation");
    }
  }
  if (database_ != nullptr) {
    int moved = 1;
    const int code = sqlite3_file_control(
        database_, "main", SQLITE_FCNTL_HAS_MOVED, &moved);
    if (code != SQLITE_OK || moved != 0) {
      throw HostError(CITIZENSDK_ERROR_PERMISSION_DENIED,
                      "CitizenSDK database identity changed while open");
    }
  }
}

void SQLiteStore::execute(sqlite3 *database, const char *sql) {
  if (sqlite3_exec(database, sql, nullptr, nullptr, nullptr) != SQLITE_OK) {
    throw sqlite_error(database, "CitizenSDK SQLite command failed");
  }
}

}  // namespace citizen_sdk::linux
