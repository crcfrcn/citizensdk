#ifndef CITIZENSDK_WINDOWS_DIRECTORY_HPP
#define CITIZENSDK_WINDOWS_DIRECTORY_HPP

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winternl.h>
#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::windows {

// 当前有效线程 SID（无 impersonation token 才回退进程）；仅供系统适配复用。
Bytes current_user_sid();

class UniqueHandle final {
 public:
  explicit UniqueHandle(HANDLE value = INVALID_HANDLE_VALUE) noexcept : value_(value) {}
  UniqueHandle(const UniqueHandle &) = delete;
  UniqueHandle &operator=(const UniqueHandle &) = delete;
  UniqueHandle(UniqueHandle &&other) noexcept : value_(other.release()) {}
  UniqueHandle &operator=(UniqueHandle &&other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  ~UniqueHandle() { reset(); }
  HANDLE get() const noexcept { return value_; }
  explicit operator bool() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() noexcept { return std::exchange(value_, INVALID_HANDLE_VALUE); }
  void reset(HANDLE value = INVALID_HANDLE_VALUE) noexcept {
    if (*this) (void)::CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_;
};

// 私有系统适配：不向公共 C/C++ API 暴露 HANDLE、SID 或文件系统路径操作。
class Directory final {
 public:
  explicit Directory(const std::filesystem::path &path, bool private_state = true);
  Directory(const Directory &) = delete;
  Directory &operator=(const Directory &) = delete;
  Directory(Directory &&) noexcept = default;
  Directory &operator=(Directory &&) noexcept = default;
  static Directory assets(const std::filesystem::path &path) { return Directory(path, false); }

  HANDLE handle() const noexcept { return handles_.back().get(); }
  // disposition 使用 NtCreateFile 官方值：FILE_OPEN=1、FILE_CREATE=2、FILE_OPEN_IF=3。
  UniqueHandle open(const std::wstring &name, DWORD access = GENERIC_READ,
                    ULONG disposition = 1) const;
  std::optional<UniqueHandle> find(const std::wstring &name,
                                 DWORD access = GENERIC_READ) const;
  Bytes read(const std::string &name, std::size_t maximum) const;
  void remove(const std::wstring &name) const;
  void verify() const;
  void verify_file(HANDLE file) const;
  static FILE_ID_INFO identity(HANDLE file);
  static bool same_identity(const FILE_ID_INFO &left, const FILE_ID_INFO &right) noexcept;
  static std::wstring utf16(const std::string &value);

 private:
  UniqueHandle open_relative(const std::wstring &name, DWORD access,
                             ULONG disposition, bool missing_allowed) const;
  void verify_security(HANDLE file) const;
  std::vector<UniqueHandle> handles_;
  Bytes user_sid_;
  bool private_state_;
};

}  // namespace citizen_sdk::windows
#endif
