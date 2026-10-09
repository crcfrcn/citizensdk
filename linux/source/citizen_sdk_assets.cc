#include "citizen_sdk_assets.hpp"

#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include "citizen_sdk_input_limits.hpp"

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

int open_directory_no_follow(const std::filesystem::path &path) {
  require(path.is_absolute(), CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK asset root must be absolute");
  UniqueFd current(::open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (current.get() < 0) {
    throw HostError(CITIZENSDK_ERROR_STORAGE,
                    "CitizenSDK could not open the asset filesystem root");
  }
  for (const auto &part : path) {
    const std::string name = part.string();
    if (name.empty() || name == "/") continue;
    if (name == "." || name == "..") {
      throw HostError(CITIZENSDK_ERROR_INVALID_ARGUMENT,
                      "CitizenSDK asset path contains a forbidden component");
    }
    UniqueFd next(::openat(current.get(), name.c_str(),
                           O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (next.get() < 0) {
      throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                      "CitizenSDK asset path is missing or not a real directory");
    }
    current.reset(next.release());
  }
  return current.release();
}

Bytes read_asset(int directory, const char *name) {
  UniqueFd file(::openat(directory, name,
                         O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (file.get() < 0) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK packaged chain asset is missing");
  }
  struct stat status {};
  if (::fstat(file.get(), &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_size <= 0 ||
      static_cast<uint64_t>(status.st_size) > input_limits::kMaximumAssetBytes) {
    throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                    "CitizenSDK packaged chain asset is malformed");
  }
  Bytes bytes(static_cast<std::size_t>(status.st_size));
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = ::read(file.get(), bytes.data() + offset,
                                 bytes.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                      "CitizenSDK packaged chain asset was truncated");
    }
    offset += static_cast<std::size_t>(count);
  }
  return bytes;
}

}  // namespace

Assets Assets::load(const std::filesystem::path &root) {
  UniqueFd directory(open_directory_no_follow(root));
  return {read_asset(directory.get(), "manifest.json"),
          read_asset(directory.get(), "chainspec.json"),
          read_asset(directory.get(), "light_sync_state.json")};
}

}  // namespace citizen_sdk::linux
