#ifndef CITIZENSDK_LINUX_TEST_SUPPORT_HPP
#define CITIZENSDK_LINUX_TEST_SUPPORT_HPP

#include <dirent.h>
#include <fcntl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cassert>
#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#include "citizensdk_types.h"
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux::test {

// 跨进程测试使用管道屏障而非 sleep 猜测交错；读等待有上限，避免回归
// 死锁拖住整个 CI。所有子进程都在单线程、未打开测试数据库时 fork。
class ProcessPipe final {
 public:
  ProcessPipe() { assert(::pipe2(descriptors_, O_CLOEXEC) == 0); }
  ProcessPipe(const ProcessPipe &) = delete;
  ProcessPipe &operator=(const ProcessPipe &) = delete;
  ~ProcessPipe() { ::close(descriptors_[0]); ::close(descriptors_[1]); }
  void send(const void *value, std::size_t length) const {
    const auto *bytes = static_cast<const uint8_t *>(value);
    while (length != 0) {
      const ssize_t count = ::write(descriptors_[1], bytes, length);
      if (count < 0 && errno == EINTR) continue;
      assert(count > 0);
      bytes += count;
      length -= static_cast<std::size_t>(count);
    }
  }
  void receive(void *value, std::size_t length) const {
    auto *bytes = static_cast<uint8_t *>(value);
    while (length != 0) {
      struct pollfd pending {descriptors_[0], POLLIN, 0};
      int ready;
      do { ready = ::poll(&pending, 1, 10000); } while (ready < 0 && errno == EINTR);
      assert(ready == 1 && (pending.revents & POLLIN) != 0);
      const ssize_t count = ::read(descriptors_[0], bytes, length);
      if (count < 0 && errno == EINTR) continue;
      assert(count > 0);
      bytes += count;
      length -= static_cast<std::size_t>(count);
    }
  }
  void send() const { const uint8_t value = 1; send(&value, 1); }
  void receive() const { uint8_t value = 0; receive(&value, 1); assert(value == 1); }

 private:
  int descriptors_[2]{};
};

inline void wait_for_child(pid_t child, int signal = 0) {
  assert(child > 0);
  int status = 0;
  pid_t result;
  do { result = ::waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
  assert(result == child);
  if (signal == 0) assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  else assert(WIFSIGNALED(status) && WTERMSIG(status) == signal);
}

inline std::vector<uint8_t> read_shm(const std::filesystem::path &path) {
  const int descriptor = ::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  assert(descriptor >= 0);
  struct stat status {};
  assert(::fstat(descriptor, &status) == 0 && S_ISREG(status.st_mode) &&
         status.st_nlink == 1 && status.st_uid == ::geteuid());
  assert(status.st_size >= 136 && status.st_size <= 1024 * 1024);
  std::vector<uint8_t> bytes(static_cast<std::size_t>(status.st_size));
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto count = ::pread(descriptor, bytes.data() + offset,
                               bytes.size() - offset, static_cast<off_t>(offset));
    if (count < 0 && errno == EINTR) continue;
    assert(count > 0);
    offset += static_cast<std::size_t>(count);
  }
  assert(::close(descriptor) == 0);
  return bytes;
}

inline void assert_shared_dms(const std::filesystem::path &path) {
  const int descriptor = ::open(path.c_str(), O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  assert(descriptor >= 0);
  struct flock lock {};
  lock.l_type = F_WRLCK;
  lock.l_whence = SEEK_SET;
  lock.l_start = (22 + 8) * 4 + 8;  // SQLite 官方 UNIX_SHM_DMS = 128。
  lock.l_len = 1;
  assert(::fcntl(descriptor, F_OFD_GETLK, &lock) == 0 && lock.l_type == F_RDLCK);
  lock.l_type = F_WRLCK;
  assert(::fcntl(descriptor, F_OFD_SETLK, &lock) == -1 &&
         (errno == EAGAIN || errno == EACCES));
  assert(::close(descriptor) == 0);
}

template <typename Store, typename Load, typename CompareAndSwap>
void verify_wal_processes(const std::filesystem::path &directory,
                          const char *file_name, Load load,
                          CompareAndSwap compare_and_swap) {
  const auto shm = directory / (std::string(file_name) + "-shm");
  ProcessPipe snapshot_pipe;
  const pid_t crashed = ::fork();
  assert(crashed >= 0);
  if (crashed == 0) {
    ::alarm(15);
    Store store(directory);
    assert((store.*compare_and_swap)(0, {1}).revision == 1);
    const auto snapshot = read_shm(shm);
    assert((store.*compare_and_swap)(1, {2}).revision == 2);
    const uint64_t length = snapshot.size();
    snapshot_pipe.send(&length, sizeof(length));
    snapshot_pipe.send(snapshot.data(), snapshot.size());
    // 实际 SIGKILL，不调用 SQLite close/checkpoint；WAL 必须保留已提交数据。
    ::kill(::getpid(), SIGKILL);
    ::_exit(99);
  }
  uint64_t length = 0;
  snapshot_pipe.receive(&length, sizeof(length));
  assert(length >= 136 && length <= 1024 * 1024);
  std::vector<uint8_t> snapshot(static_cast<std::size_t>(length));
  snapshot_pipe.receive(snapshot.data(), snapshot.size());
  wait_for_child(crashed, SIGKILL);
  // 模拟掉电时较早但校验自洽的 SHM 落盘；只修改本测试专属合成数据。
  const int descriptor = ::open(shm.c_str(), O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  assert(descriptor >= 0);
  std::size_t offset = 0;
  while (offset < snapshot.size()) {
    const auto count = ::pwrite(descriptor, snapshot.data() + offset,
                                snapshot.size() - offset, static_cast<off_t>(offset));
    if (count < 0 && errno == EINTR) continue;
    assert(count > 0);
    offset += static_cast<std::size_t>(count);
  }
  assert(::ftruncate(descriptor, static_cast<off_t>(snapshot.size())) == 0);
  assert(::close(descriptor) == 0);
  // 一个首连接正在初始化时，其独占 DMS 必须让并发打开失败且不改索引。
  const int initializing = ::open(shm.c_str(), O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  assert(initializing >= 0);
  struct flock exclusive {};
  exclusive.l_type = F_WRLCK;
  exclusive.l_whence = SEEK_SET;
  exclusive.l_start = 128;
  exclusive.l_len = 1;
  assert(::fcntl(initializing, F_OFD_SETLK, &exclusive) == 0);
  const pid_t contender = ::fork();
  assert(contender >= 0);
  if (contender == 0) {
    ::alarm(15);
    // fork 继承的同一 OFD 必须先关闭，否则会伪造初始化者仍然存活。
    assert(::close(initializing) == 0);
    bool rejected = false;
    try { Store opening(directory); }
    catch (const HostError &error) {
      rejected = error.code() == CITIZENSDK_ERROR_STORAGE;
    }
    assert(rejected);
    ::_exit(0);
  }
  wait_for_child(contender);
  assert(read_shm(shm) == snapshot);
  assert(::close(initializing) == 0);
  {
    Store recovered(directory);
    const auto record = (recovered.*load)();
    assert(record.revision == 2 && record.record == std::vector<uint8_t>{2});
    assert((recovered.*compare_and_swap)(2, {3}).revision == 3);
  }

  ProcessPipe ready, proceed;
  const pid_t active = ::fork();
  assert(active >= 0);
  if (active == 0) {
    ::alarm(15);
    Store store(directory);
    assert((store.*load)().revision == 3);
    ready.send();
    proceed.receive();
    assert((store.*compare_and_swap)(3, {4}).revision == 4);
    ready.send();
    proceed.receive();
    store.close();
    ::_exit(0);
  }
  ready.receive();
  const auto before = read_shm(shm);
  {
    Store reader(directory);
    assert((reader.*load)().revision == 3);
    const auto after = read_shm(shm);
    assert(before.size() == after.size());
    assert(std::equal(before.begin(), before.begin() + 96, after.begin()));
    assert_shared_dms(shm);
    // 同进程另一个连接关闭后仍须保留 reader 与远端连接的 OFD DMS。
    { Store another(directory); assert((another.*load)().revision == 3); }
    assert_shared_dms(shm);
    proceed.send();
    ready.receive();
    assert((reader.*load)().revision == 4);
    assert((reader.*compare_and_swap)(3, {5}).error_code == CITIZENSDK_ERROR_CONFLICT);
  }
  assert_shared_dms(shm);
  proceed.send();
  wait_for_child(active);
  Store persisted(directory);
  assert((persisted.*load)().revision == 4);
}

// 调用方必须把 CITIZENSDK_TEST_WORK_DIR 指向 调用方 为本次任务
// 独占创建的 0700 目录。本 helper 逐级 no-follow 打开该目录，随后只
// 通过该目录 fd + CSPRNG 名称创建子目录；没有路径重解析或 fallback。
class TempDirectory final {
 public:
  explicit TempDirectory(const std::string &label) {
    if (label.empty() || label.find('/') != std::string::npos) {
      throw std::invalid_argument("CitizenSDK test label is invalid");
    }
    const char *configured = std::getenv("CITIZENSDK_TEST_WORK_DIR");
    if (configured == nullptr || configured[0] == '\0') {
      throw std::runtime_error(
          "CITIZENSDK_TEST_WORK_DIR is required and has no fallback");
    }
    const std::filesystem::path work_root(configured);
    parent_fd_ = open_verified_work_root(work_root);
    try {
      create_directory(label);
      path_ = work_root / name_;
    } catch (...) {
      if (directory_fd_ >= 0) {
        cleanup(directory_fd_);
        ::close(directory_fd_);
        directory_fd_ = -1;
      }
      remove_created_directory();
      ::close(parent_fd_);
      parent_fd_ = -1;
      throw;
    }
  }

  TempDirectory(const TempDirectory &) = delete;
  TempDirectory &operator=(const TempDirectory &) = delete;

  ~TempDirectory() noexcept {
    if (directory_fd_ >= 0) cleanup(directory_fd_);
    remove_created_directory();
    if (directory_fd_ >= 0) ::close(directory_fd_);
    if (parent_fd_ >= 0) ::close(parent_fd_);
  }

  const std::filesystem::path &path() const noexcept { return path_; }

 private:
  static std::string random_name(const std::string &label) {
    std::array<uint8_t, 16> random{};
    std::size_t offset = 0;
    while (offset < random.size()) {
      const ssize_t count =
          ::getrandom(random.data() + offset, random.size() - offset, 0);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) {
        throw std::runtime_error("CitizenSDK test CSPRNG is unavailable");
      }
      offset += static_cast<std::size_t>(count);
    }
    constexpr char hexadecimal[] = "0123456789abcdef";
    std::string name = "citizensdk-" + label + "-";
    name.reserve(name.size() + random.size() * 2);
    for (const uint8_t byte : random) {
      name.push_back(hexadecimal[byte >> 4]);
      name.push_back(hexadecimal[byte & 0x0f]);
    }
    return name;
  }

  void create_directory(const std::string &label) {
    for (unsigned attempt = 0; attempt < 32; ++attempt) {
      name_ = random_name(label);
      owns_directory_ = false;
      identity_known_ = false;
      if (::mkdirat(parent_fd_, name_.c_str(), 0700) != 0) {
        if (errno == EEXIST) continue;
        throw std::runtime_error("CitizenSDK test directory creation failed");
      }
      owns_directory_ = true;
      struct stat named {};
      struct stat opened {};
      const bool named_found =
          ::fstatat(parent_fd_, name_.c_str(), &named,
                    AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(named.st_mode);
      if (named_found) {
        identity_ = named;
        identity_known_ = true;
      }
      const bool named_valid =
          named_found && named.st_uid == ::geteuid() &&
          (named.st_mode & 07777) == 0700;
      directory_fd_ = ::openat(parent_fd_, name_.c_str(),
                               O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                   O_NOFOLLOW);
      const bool opened_found =
          directory_fd_ >= 0 && ::fstat(directory_fd_, &opened) == 0 &&
          S_ISDIR(opened.st_mode);
      if (opened_found && !identity_known_) {
        identity_ = opened;
        identity_known_ = true;
      }
      const bool opened_valid =
          opened_found && opened.st_uid == ::geteuid() &&
          (opened.st_mode & 07777) == 0700 && named_valid &&
          opened.st_dev == named.st_dev && opened.st_ino == named.st_ino;
      if (!opened_valid) {
        if (directory_fd_ >= 0) {
          ::close(directory_fd_);
          directory_fd_ = -1;
        }
        remove_created_directory();
        throw std::runtime_error(
            "CitizenSDK test directory validation failed");
      }
      identity_ = opened;
      return;
    }
    throw std::runtime_error(
        "CitizenSDK test directory identity collisions were exhausted");
  }

  void remove_created_directory() noexcept {
    if (parent_fd_ < 0 || name_.empty() || !owns_directory_ ||
        !identity_known_) {
      return;
    }
    struct stat current {};
    if (::fstatat(parent_fd_, name_.c_str(), &current,
                  AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISDIR(current.st_mode) && current.st_uid == ::geteuid() &&
        current.st_dev == identity_.st_dev &&
        current.st_ino == identity_.st_ino) {
      if (::unlinkat(parent_fd_, name_.c_str(), AT_REMOVEDIR) == 0) {
        owns_directory_ = false;
      }
    }
  }

  static int open_verified_work_root(
      const std::filesystem::path &work_root) {
    if (!work_root.is_absolute() || work_root == work_root.root_path()) {
      throw std::runtime_error(
          "CitizenSDK test work root must be a non-root absolute path");
    }
    int current = ::open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (current < 0) {
      throw std::runtime_error("CitizenSDK test filesystem root is unavailable");
    }
    for (const auto &part : work_root) {
      const std::string name = part.string();
      if (name == "/" || name.empty()) continue;
      if (name == "." || name == "..") {
        ::close(current);
        throw std::runtime_error(
            "CitizenSDK test work root contains a forbidden component");
      }
      struct stat named {};
      if (::fstatat(current, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 ||
          !S_ISDIR(named.st_mode) || S_ISLNK(named.st_mode)) {
        ::close(current);
        throw std::runtime_error(
            "CitizenSDK test work root is missing or unsafe");
      }
      const int next = ::openat(current, name.c_str(),
                                O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                    O_NOFOLLOW);
      struct stat opened {};
      if (next < 0 || ::fstat(next, &opened) != 0 ||
          !S_ISDIR(opened.st_mode) || opened.st_dev != named.st_dev ||
          opened.st_ino != named.st_ino) {
        if (next >= 0) ::close(next);
        ::close(current);
        throw std::runtime_error(
            "CitizenSDK test work root changed during validation");
      }
      ::close(current);
      current = next;
    }
    struct stat root_status {};
    if (::fstat(current, &root_status) != 0 ||
        root_status.st_uid != ::geteuid() ||
        (root_status.st_mode & 07777) != 0700) {
      ::close(current);
      throw std::runtime_error(
          "CitizenSDK test work root must be effective-UID-owned mode 0700");
    }
    return current;
  }

  static void cleanup(int directory_fd) noexcept {
    const int duplicate = ::dup(directory_fd);
    if (duplicate < 0) return;
    DIR *directory = ::fdopendir(duplicate);
    if (directory == nullptr) {
      ::close(duplicate);
      return;
    }
    while (dirent *entry = ::readdir(directory)) {
      const std::string name = entry->d_name;
      if (name == "." || name == "..") continue;
      struct stat status {};
      if (::fstatat(directory_fd, name.c_str(), &status,
                    AT_SYMLINK_NOFOLLOW) != 0) {
        continue;
      }
      if (S_ISDIR(status.st_mode) && !S_ISLNK(status.st_mode)) {
        const int child = ::openat(directory_fd, name.c_str(),
                                   O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                       O_NOFOLLOW);
        struct stat opened {};
        if (child >= 0 && ::fstat(child, &opened) == 0 &&
            S_ISDIR(opened.st_mode) && opened.st_dev == status.st_dev &&
            opened.st_ino == status.st_ino) {
          cleanup(child);
          struct stat current {};
          const bool unchanged =
              ::fstatat(directory_fd, name.c_str(), &current,
                        AT_SYMLINK_NOFOLLOW) == 0 &&
              S_ISDIR(current.st_mode) && current.st_dev == opened.st_dev &&
              current.st_ino == opened.st_ino;
          ::close(child);
          if (unchanged) {
            (void)::unlinkat(directory_fd, name.c_str(), AT_REMOVEDIR);
          }
        } else if (child >= 0) {
          ::close(child);
        }
      } else {
        (void)::unlinkat(directory_fd, name.c_str(), 0);
      }
    }
    ::closedir(directory);
  }

  std::filesystem::path path_;
  std::string name_;
  int parent_fd_{-1};
  int directory_fd_{-1};
  bool owns_directory_{false};
  bool identity_known_{false};
  struct stat identity_ {};
};

}  // namespace citizen_sdk::linux::test

#endif
