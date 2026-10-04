#ifndef CITIZENSDK_LINUX_FLUTTER_TEST_SUPPORT_HPP
#define CITIZENSDK_LINUX_FLUTTER_TEST_SUPPORT_HPP

#include <dirent.h>
#include <fcntl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

#include <array>
#include <cassert>
#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <utility>

#include "citizen_sdk_flutter_codec.hpp"

#ifdef NDEBUG
#error "CitizenSDK Flutter contract assertions must remain enabled"
#endif

namespace citizen_sdk::flutter::test {

// Exercises the real production value converter/codec. This is deliberately
// not a second tuple implementation or a fake successful Core operation.
inline Value list(std::initializer_list<Value> values) {
  return Value::list(Value::List(values));
}
inline FlValuePtr fl(const Value &value) { return to_fl_value(value); }

template <typename Function>
void expect_failure(Function &&function, citizensdk_error_code_t expected) {
  bool rejected = false;
  try {
    std::forward<Function>(function)();
  } catch (const ContractFailure &error) {
    rejected = error.code == expected;
  }
  assert(rejected);
}

struct GBytesDeleter {
  void operator()(GBytes *value) const noexcept {
    if (value != nullptr) g_bytes_unref(value);
  }
};
using GBytesPtr = std::unique_ptr<GBytes, GBytesDeleter>;

template <typename T> struct GObjectDeleter {
  void operator()(T *value) const noexcept {
    if (value != nullptr) g_object_unref(value);
  }
};
template <typename T>
using GObjectPtr = std::unique_ptr<T, GObjectDeleter<T>>;

// Independent Flutter-adapter fixture root. It accepts no /tmp fallback and
// walks the console-owned mode-0700 work root one no-follow component at a
// time. Cleanup operates only through verified directory descriptors.
class TempDirectory final {
 public:
  explicit TempDirectory(const std::string &label) {
    if (label.empty() || label.find('/') != std::string::npos)
      throw std::invalid_argument("CitizenSDK Flutter test label is invalid");
    const char *configured = std::getenv("CITIZENSDK_TEST_WORK_DIR");
    if (configured == nullptr || configured[0] == '\0')
      throw std::runtime_error("CITIZENSDK_TEST_WORK_DIR is required");
    const std::filesystem::path work_root(configured);
    parent_fd_ = open_root(work_root);
    try {
      for (unsigned attempt = 0; attempt < 32; ++attempt) {
        name_ = random_name(label);
        if (::mkdirat(parent_fd_, name_.c_str(), 0700) == 0) {
          owns_ = true;
          break;
        }
        if (errno != EEXIST)
          throw std::runtime_error("CitizenSDK Flutter test directory creation failed");
      }
      if (!owns_)
        throw std::runtime_error("CitizenSDK Flutter test directory identity was exhausted");
      struct stat named {};
      if (::fstatat(parent_fd_, name_.c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 &&
          S_ISDIR(named.st_mode)) {
        identity_ = named;
        identity_known_ = true;
      }
      directory_fd_ = ::openat(parent_fd_, name_.c_str(),
          O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      struct stat opened {};
      if (directory_fd_ < 0 ||
          !identity_known_ ||
          ::fstat(directory_fd_, &opened) != 0 || !S_ISDIR(named.st_mode) ||
          named.st_uid != ::geteuid() || (named.st_mode & 07777) != 0700 ||
          named.st_dev != opened.st_dev || named.st_ino != opened.st_ino)
        throw std::runtime_error("CitizenSDK Flutter test directory is unsafe");
      identity_ = opened;
      identity_known_ = true;
      directory_verified_ = true;
      path_ = work_root / name_;
    } catch (...) {
      release();
      throw;
    }
  }
  TempDirectory(const TempDirectory &) = delete;
  TempDirectory &operator=(const TempDirectory &) = delete;
  ~TempDirectory() noexcept { release(); }
  const std::filesystem::path &path() const noexcept { return path_; }

 private:
  static std::string random_name(const std::string &label) {
    std::array<uint8_t, 16> bytes{}; std::size_t done = 0;
    while (done < bytes.size()) {
      const auto count = ::getrandom(bytes.data() + done, bytes.size() - done, 0);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) throw std::runtime_error("CitizenSDK test CSPRNG is unavailable");
      done += static_cast<std::size_t>(count);
    }
    constexpr char digits[] = "0123456789abcdef";
    std::string value = "citizensdk-" + label + "-";
    for (uint8_t byte : bytes) { value.push_back(digits[byte >> 4]); value.push_back(digits[byte & 15]); }
    return value;
  }
  static int open_root(const std::filesystem::path &root) {
    if (!root.is_absolute() || root == root.root_path())
      throw std::runtime_error("CitizenSDK test root must be absolute and non-root");
    int current = ::open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (current < 0) throw std::runtime_error("CitizenSDK filesystem root is unavailable");
    try {
      for (const auto &part : root) {
        const std::string name = part.string();
        if (name.empty() || name == "/") continue;
        if (name == "." || name == "..") throw std::runtime_error("Unsafe test root component");
        struct stat named {}, opened {};
        if (::fstatat(current, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 ||
            !S_ISDIR(named.st_mode)) throw std::runtime_error("Unsafe test root");
        const int next = ::openat(current, name.c_str(),
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (next < 0 || ::fstat(next, &opened) != 0 ||
            named.st_dev != opened.st_dev || named.st_ino != opened.st_ino) {
          if (next >= 0) ::close(next);
          throw std::runtime_error("Test root changed during validation");
        }
        ::close(current); current = next;
      }
      struct stat status {};
      if (::fstat(current, &status) != 0 || status.st_uid != ::geteuid() ||
          (status.st_mode & 07777) != 0700)
        throw std::runtime_error("Test root must be effective-UID-owned mode 0700");
      return current;
    } catch (...) { ::close(current); throw; }
  }
  static void cleanup(int fd) noexcept {
    const int copy = ::dup(fd); if (copy < 0) return;
    DIR *entries = ::fdopendir(copy); if (entries == nullptr) { ::close(copy); return; }
    while (dirent *entry = ::readdir(entries)) {
      const std::string name = entry->d_name;
      if (name == "." || name == "..") continue;
      struct stat named {};
      if (::fstatat(fd, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) continue;
      if (S_ISDIR(named.st_mode)) {
        const int child = ::openat(fd, name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        struct stat opened {};
        if (child >= 0 && ::fstat(child, &opened) == 0 && opened.st_dev == named.st_dev &&
            opened.st_ino == named.st_ino) {
          cleanup(child); ::close(child);
          struct stat current {};
          if (::fstatat(fd, name.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
              current.st_dev == named.st_dev && current.st_ino == named.st_ino)
            (void)::unlinkat(fd, name.c_str(), AT_REMOVEDIR);
        } else if (child >= 0) ::close(child);
      } else {
        (void)::unlinkat(fd, name.c_str(), 0);
      }
    }
    ::closedir(entries);
  }
  void release() noexcept {
    if (directory_fd_ >= 0 && directory_verified_) cleanup(directory_fd_);
    if (owns_ && identity_known_) {
      struct stat current {};
      if (::fstatat(parent_fd_, name_.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0 &&
          current.st_dev == identity_.st_dev && current.st_ino == identity_.st_ino)
        (void)::unlinkat(parent_fd_, name_.c_str(), AT_REMOVEDIR);
    }
    if (directory_fd_ >= 0) ::close(directory_fd_);
    if (parent_fd_ >= 0) ::close(parent_fd_);
    directory_fd_ = parent_fd_ = -1;
  }
  std::filesystem::path path_;
  std::string name_;
  int parent_fd_{-1};
  int directory_fd_{-1};
  bool owns_{};
  bool identity_known_{};
  bool directory_verified_{};
  struct stat identity_ {};
};

}  // namespace citizen_sdk::flutter::test

#endif
