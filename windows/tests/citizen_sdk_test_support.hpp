#ifndef CITIZENSDK_WINDOWS_TEST_SUPPORT_HPP
#define CITIZENSDK_WINDOWS_TEST_SUPPORT_HPP

#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>
#include <sddl.h>
#include <array>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include "citizen_sdk_directory.hpp"

namespace citizen_sdk::windows::test {

// 测试只在调用方给定的中央任务根下创建随机子目录。清理通过同一个
// 已打开目录句柄逐级进行，不递归跟随路径、链接或 reparse point。
class TempDirectory final {
 public:
  explicit TempDirectory(const std::string &label) {
    if (label.empty() || label.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") != std::string::npos)
      throw std::invalid_argument("CitizenSDK test label is invalid");
    const char *configured = std::getenv("CITIZENSDK_TEST_WORK_DIR");
    if (configured == nullptr || configured[0] == '\0')
      throw std::runtime_error("CITIZENSDK_TEST_WORK_DIR is required and has no fallback");
    const auto work = std::filesystem::u8path(configured);
    parent_ = std::make_unique<Directory>(work);
    std::array<unsigned char, 16> random{};
    if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
      throw std::runtime_error("CitizenSDK test random identity is unavailable");
    std::string name = "citizensdk-" + label + "-";
    constexpr char digits[] = "0123456789abcdef";
    for (const auto byte : random) { name += digits[byte >> 4]; name += digits[byte & 15]; }
    name_ = Directory::utf16(name);
    path_ = work / name_;
    const auto sid = current_user_sid();
    LPWSTR sid_text = nullptr;
    if (!ConvertSidToStringSidW(const_cast<uint8_t *>(sid.data()), &sid_text))
      throw std::runtime_error("CitizenSDK test SID conversion failed");
    const std::wstring descriptor = L"O:" + std::wstring(sid_text) + L"D:P(A;;FA;;;" + sid_text + L")";
    LocalFree(sid_text);
    PSECURITY_DESCRIPTOR security = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.c_str(), SDDL_REVISION_1, &security, nullptr))
      throw std::runtime_error("CitizenSDK test descriptor creation failed");
    UniqueHandle created;
    try { created = relative(parent_->handle(), name_, true, 2, security); }
    catch (...) { LocalFree(security); throw; }
    LocalFree(security);
    identity_ = Directory::identity(created.get());
    // 正常生命周期不持 DELETE access，否则生产目录的 no-share-delete 合同
    // 会产生 Windows sharing violation。清理前才重新取得删除句柄并比对身份。
    directory_ = std::make_unique<Directory>(path_);
    if (!Directory::same_identity(identity_, Directory::identity(directory_->handle())))
      throw std::runtime_error("CitizenSDK test directory identity changed");
    created.reset();
  }
  TempDirectory(const TempDirectory &) = delete;
  TempDirectory &operator=(const TempDirectory &) = delete;
  ~TempDirectory() noexcept {
    try {
      directory_.reset();
      auto opened = relative(parent_->handle(), name_, true, 1);
      if (Directory::same_identity(identity_, Directory::identity(opened.get()))) {
        cleanup(opened.get());
        FILE_DISPOSITION_INFO disposition{TRUE};
        (void)SetFileInformationByHandle(opened.get(), FileDispositionInfo, &disposition, sizeof(disposition));
      }
    } catch (...) {}
  }
  const std::filesystem::path &path() const noexcept { return path_; }

 private:
  static UniqueHandle relative(HANDLE parent, const std::wstring &name, bool directory,
                               ULONG disposition, PSECURITY_DESCRIPTOR security = nullptr) {
    using Create = NTSTATUS (NTAPI *)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
                                      PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
    const auto create = reinterpret_cast<Create>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
    if (!create || name.empty() || name.find_first_of(L"/\\:") != std::wstring::npos || name == L"." || name == L"..")
      throw std::runtime_error("CitizenSDK test relative name is invalid");
    UNICODE_STRING value{};
    value.Buffer = const_cast<PWSTR>(name.data());
    value.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
    value.MaximumLength = value.Length;
    OBJECT_ATTRIBUTES attributes{};
    InitializeObjectAttributes(&attributes, &value, OBJ_CASE_INSENSITIVE, parent, security);
    IO_STATUS_BLOCK status{};
    HANDLE handle = INVALID_HANDLE_VALUE;
    const bool creating = disposition == 2;
    const auto result = create(&handle, (creating ? 0 : DELETE) | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE |
        (directory ? FILE_LIST_DIRECTORY : FILE_READ_DATA), &attributes, &status, nullptr,
        FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | (creating ? 0 : FILE_SHARE_DELETE),
        disposition, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
        (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), nullptr, 0);
    if (result < 0) throw std::runtime_error("CitizenSDK test relative open failed");
    return UniqueHandle(handle);
  }
  static void cleanup(HANDLE directory) {
    alignas(FILE_ID_BOTH_DIR_INFO) std::array<unsigned char, 65536> buffer{};
    // 每轮只删除一项再从目录句柄重启枚举，不依赖删除后的不稳定枚举游标。
    for (;;) {
      if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryRestartInfo,
                                       buffer.data(), static_cast<DWORD>(buffer.size()))) {
        if (GetLastError() == ERROR_NO_MORE_FILES) return;
        throw std::runtime_error("CitizenSDK test enumeration failed");
      }
      bool removed = false;
      auto *entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO *>(buffer.data());
      for (;;) {
        const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          const bool is_directory = (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          auto child = relative(directory, name, is_directory, 1);
          FILE_ATTRIBUTE_TAG_INFO tag{};
          if (!GetFileInformationByHandleEx(child.get(), FileAttributeTagInfo, &tag, sizeof(tag)))
            throw std::runtime_error("CitizenSDK test child identity failed");
          if (is_directory && (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) cleanup(child.get());
          FILE_DISPOSITION_INFO disposition{TRUE};
          if (!SetFileInformationByHandle(child.get(), FileDispositionInfo, &disposition, sizeof(disposition)))
            throw std::runtime_error("CitizenSDK test child deletion failed");
          removed = true;
          break;
        }
        if (entry->NextEntryOffset == 0) break;
        entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO *>(reinterpret_cast<unsigned char *>(entry) + entry->NextEntryOffset);
      }
      if (!removed) return;
    }
  }
  std::unique_ptr<Directory> parent_;
  std::unique_ptr<Directory> directory_;
  FILE_ID_INFO identity_{};
  std::wstring name_;
  std::filesystem::path path_;
};
}  // namespace citizen_sdk::windows::test
#endif
