#ifndef CITIZENSDK_WINDOWS_FLUTTER_TEST_SUPPORT_HPP
#define CITIZENSDK_WINDOWS_FLUTTER_TEST_SUPPORT_HPP

#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdio>
#include <cstddef>
#include <deque>
#include <filesystem>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <variant>
#include <vector>
#include "citizen_sdk/citizen_sdk_error.hpp"
#include "citizen_sdk_flutter_sessions.hpp"

#ifdef NDEBUG
#error "CitizenSDK Windows Flutter contract assertions must remain enabled"
#endif

namespace citizen_sdk::flutter::test {
namespace csf = citizen_sdk::flutter;

// 只复用生产 codec；不在测试中另写元组协议或返回伪造的硬件验收结果。
inline Value list(std::initializer_list<Value> values) {
  return Value::list(Value::List(values));
}
inline ::flutter::EncodableValue fl(const Value &value) {
  return to_encodable_value(value);
}
template <class Function>
void expect_failure(Function &&function, citizensdk_error_code_t expected) {
  bool rejected = false;
  try { std::forward<Function>(function)(); }
  catch (const ContractFailure &error) {
    rejected = error.code == expected;
    if (!rejected) { std::fprintf(stderr, "WINDOWS_EXPECT_FAILURE expected=%d actual=%d\n", static_cast<int>(expected), static_cast<int>(error.code)); std::fflush(stderr); }
  }
  if (!rejected) { std::fprintf(stderr, "WINDOWS_EXPECT_FAILURE rejected=false expected=%d\n", static_cast<int>(expected)); std::fflush(stderr); }
  assert(rejected);
}

class FiniteScheduler final {
 public:
  FiniteScheduler() : owner_(std::this_thread::get_id()) {}
  void post(std::function<void()> work) {
    std::lock_guard<std::mutex> guard(lock_);
    if (fail_next_) { fail_next_ = false; throw std::bad_alloc(); }
    pending_.push_back(std::move(work));
  }
  Scheduler scheduler() { return [this](std::function<void()> work) { post(std::move(work)); }; }
  void fail_next() { std::lock_guard<std::mutex> guard(lock_); fail_next_ = true; }
  void drain() {
    assert(std::this_thread::get_id() == owner_);
    for (std::size_t budget = 0; budget < 4096; ++budget) {
      std::function<void()> work;
      {
        std::lock_guard<std::mutex> guard(lock_);
        if (pending_.empty()) return;
        work = std::move(pending_.front());
        pending_.pop_front();
      }
      work();
    }
    throw std::runtime_error("CitizenSDK finite test scheduler did not drain");
  }
 private:
  std::thread::id owner_;
  std::mutex lock_;
  std::deque<std::function<void()>> pending_;
  bool fail_next_{};
};

class TestHandle final {
 public:
  explicit TestHandle(HANDLE value = INVALID_HANDLE_VALUE) noexcept : value_(value) {}
  TestHandle(const TestHandle &) = delete;
  TestHandle &operator=(const TestHandle &) = delete;
  TestHandle(TestHandle &&other) noexcept : value_(other.release()) {}
  TestHandle &operator=(TestHandle &&other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  ~TestHandle() { reset(); }
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

// adapter 测试只使用 Windows 官方 API，不能 include Host 私有 Directory/SQLite。
// 显式中央根必须已经存在；逐级 no-reparse 并保活祖先，随机夹具及清理均相对已开句柄。
class TempDirectory final {
 public:
  explicit TempDirectory(const std::string &label) {
    if (label.empty() || label.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") != std::string::npos)
      throw std::invalid_argument("CitizenSDK test label is invalid");
    const DWORD required = ::GetEnvironmentVariableW(L"CITIZENSDK_TEST_WORK_DIR", nullptr, 0);
    if (required < 2 || required > 32768)
      throw std::runtime_error("CITIZENSDK_TEST_WORK_DIR is required without a default");
    std::wstring configured(required, L'\0');
    const DWORD copied = ::GetEnvironmentVariableW(L"CITIZENSDK_TEST_WORK_DIR",
        configured.data(), static_cast<DWORD>(configured.size()));
    if (copied == 0 || copied >= required)
      throw std::runtime_error("CitizenSDK test root changed while reading");
    configured.resize(copied);
    const std::filesystem::path root(configured);
    const std::wstring drive = root.root_name().native();
    if (!root.is_absolute() || root == root.root_path() || drive.size() != 2 || drive[1] != L':' ||
        !((drive[0] >= L'A' && drive[0] <= L'Z') || (drive[0] >= L'a' && drive[0] <= L'z')))
      throw std::runtime_error("CitizenSDK test root must be an absolute local directory");
    std::filesystem::path current = root.root_path();
    ancestors_.push_back(open_directory(current));
    for (const auto &part : root.relative_path()) {
      validate_name(part.native());
      current /= part;
      ancestors_.push_back(open_directory(current));
    }
    const auto sid = current_sid();
    PSECURITY_DESCRIPTOR root_security = nullptr;
    PSID owner = nullptr;
    const DWORD queried = ::GetSecurityInfo(ancestors_.back().get(), SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &root_security);
    const bool owned = queried == ERROR_SUCCESS && owner != nullptr && ::IsValidSid(owner) &&
        ::EqualSid(owner, const_cast<uint8_t *>(sid.data()));
    if (root_security != nullptr) ::LocalFree(root_security);
    if (!owned) throw std::runtime_error("CitizenSDK test root belongs to another user");
    std::array<uint8_t, 16> random{};
    if (::BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                          BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
      throw std::runtime_error("CitizenSDK test entropy is unavailable");
    std::string name = "citizensdk-" + label + "-";
    constexpr char digits[] = "0123456789abcdef";
    for (const uint8_t byte : random) { name += digits[byte >> 4]; name += digits[byte & 15]; }
    name_ = std::wstring(name.begin(), name.end());
    path_ = root / name_;
    LPWSTR sid_text = nullptr;
    if (!::ConvertSidToStringSidW(const_cast<uint8_t *>(sid.data()), &sid_text))
      throw std::runtime_error("CitizenSDK test SID is unavailable");
    std::wstring descriptor;
    try { descriptor = L"O:" + std::wstring(sid_text) + L"D:P(A;OICI;FA;;;" + sid_text + L")"; }
    catch (...) { ::LocalFree(sid_text); throw; }
    ::LocalFree(sid_text);
    PSECURITY_DESCRIPTOR security = nullptr;
    if (!::ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.c_str(),
        SDDL_REVISION_1, &security, nullptr))
      throw std::runtime_error("CitizenSDK test private ACL is unavailable");
    TestHandle created;
    try { created = relative(ancestors_.back().get(), name_, true, 2, security); }
    catch (...) { ::LocalFree(security); throw; }
    ::LocalFree(security);
    try {
      identity_ = identity(created.get());
      created.reset();
      directory_ = open_directory(path_);
      // DELETE 句柄与 no-share-delete pin 不能同时存在；重开后必须确认仍是原夹具。
      if (!same_identity(identity_, identity(directory_.get())))
        throw std::runtime_error("CitizenSDK test directory identity changed");
    } catch (...) {
      // 构造未完成也只清理刚创建的精确空目录；重新打开时必须比较 FileId。
      try {
        if (!created) {
          created = relative(ancestors_.back().get(), name_, true, 1);
          if (!same_identity(identity_, identity(created.get()))) throw std::runtime_error("Test identity changed");
        }
        FILE_DISPOSITION_INFO removed{TRUE};
        (void)::SetFileInformationByHandle(created.get(), FileDispositionInfo,
            &removed, static_cast<DWORD>(sizeof(removed)));
      } catch (...) {}
      throw;
    }
  }
  TempDirectory(const TempDirectory &) = delete;
  TempDirectory &operator=(const TempDirectory &) = delete;
  ~TempDirectory() noexcept {
    try {
      directory_.reset();
      auto opened = relative(ancestors_.back().get(), name_, true, 1);
      if (!same_identity(identity_, identity(opened.get()))) return;
      cleanup(opened.get());
      FILE_DISPOSITION_INFO removed{TRUE};
      (void)::SetFileInformationByHandle(opened.get(), FileDispositionInfo,
                                         &removed, static_cast<DWORD>(sizeof(removed)));
    } catch (...) {}
  }
  const std::filesystem::path &path() const noexcept { return path_; }

 private:
  static void validate_name(const std::wstring &name) {
    if (name.empty() || name == L"." || name == L".." || name.size() > 255 ||
        name.find_first_of(L"/\\:*?\"<>|") != std::wstring::npos ||
        name.back() == L'.' || name.back() == L' ')
      throw std::runtime_error("CitizenSDK test relative name is invalid");
  }
  static std::vector<uint8_t> current_sid() {
    HANDLE raw = nullptr;
    if (!::OpenThreadToken(::GetCurrentThread(), TOKEN_QUERY, TRUE, &raw) &&
        (::GetLastError() != ERROR_NO_TOKEN ||
         !::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &raw)))
      throw std::runtime_error("CitizenSDK test identity is unavailable");
    TestHandle token(raw);
    DWORD length = 0;
    (void)::GetTokenInformation(token.get(), TokenUser, nullptr, 0, &length);
    if (length < sizeof(TOKEN_USER) || length > 65536)
      throw std::runtime_error("CitizenSDK test identity size is invalid");
    std::vector<uint8_t> information(length);
    if (!::GetTokenInformation(token.get(), TokenUser, information.data(), length, &length))
      throw std::runtime_error("CitizenSDK test identity read failed");
    PSID sid = reinterpret_cast<TOKEN_USER *>(information.data())->User.Sid;
    if (!::IsValidSid(sid)) throw std::runtime_error("CitizenSDK test SID is invalid");
    std::vector<uint8_t> result(::GetLengthSid(sid));
    if (!::CopySid(static_cast<DWORD>(result.size()), result.data(), sid))
      throw std::runtime_error("CitizenSDK test SID copy failed");
    return result;
  }
  static TestHandle open_directory(const std::filesystem::path &path) {
    TestHandle result(::CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (!result || !::GetFileInformationByHandleEx(result.get(), FileAttributeTagInfo,
        &tag, static_cast<DWORD>(sizeof(tag))) || (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
      throw std::runtime_error("CitizenSDK test root contains a reparse point or non-directory");
    return result;
  }
  static TestHandle relative(HANDLE parent, const std::wstring &name, bool directory,
                            ULONG disposition, PSECURITY_DESCRIPTOR security = nullptr) {
    validate_name(name);
    using Create = NTSTATUS (NTAPI *)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
                                      PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
    const auto create = reinterpret_cast<Create>(::GetProcAddress(::GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
    if (!create) throw std::runtime_error("CitizenSDK test relative open is unavailable");
    UNICODE_STRING value{};
    value.Buffer = const_cast<PWSTR>(name.data());
    value.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
    value.MaximumLength = value.Length;
    OBJECT_ATTRIBUTES attributes{};
    InitializeObjectAttributes(&attributes, &value, OBJ_CASE_INSENSITIVE, parent, security);
    IO_STATUS_BLOCK status{};
    HANDLE handle = INVALID_HANDLE_VALUE;
    const auto result = create(&handle, DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE |
        (directory ? FILE_LIST_DIRECTORY : FILE_READ_DATA), &attributes, &status, nullptr,
        FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        disposition, FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT |
        (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), nullptr, 0);
    if (result < 0) throw std::runtime_error("CitizenSDK test relative open failed");
    return TestHandle(handle);
  }
  static FILE_ID_INFO identity(HANDLE handle) {
    FILE_ID_INFO value{};
    if (!::GetFileInformationByHandleEx(handle, FileIdInfo, &value, static_cast<DWORD>(sizeof(value))))
      throw std::runtime_error("CitizenSDK test file identity is unavailable");
    return value;
  }
  static bool same_identity(const FILE_ID_INFO &left, const FILE_ID_INFO &right) noexcept {
    return left.VolumeSerialNumber == right.VolumeSerialNumber &&
        std::equal(std::begin(left.FileId.Identifier), std::end(left.FileId.Identifier),
                   std::begin(right.FileId.Identifier));
  }
  static void cleanup(HANDLE directory) {
    alignas(FILE_ID_BOTH_DIR_INFO) std::array<uint8_t, 65536> buffer{};
    for (;;) {
      if (!::GetFileInformationByHandleEx(directory, FileIdBothDirectoryRestartInfo,
          buffer.data(), static_cast<DWORD>(buffer.size()))) {
        if (::GetLastError() == ERROR_NO_MORE_FILES) return;
        throw std::runtime_error("CitizenSDK test cleanup enumeration failed");
      }
      bool removed = false;
      auto *entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO *>(buffer.data());
      for (;;) {
        const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          const bool is_directory = (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          auto child = relative(directory, name, is_directory, 1);
          FILE_ATTRIBUTE_TAG_INFO tag{};
          if (!::GetFileInformationByHandleEx(child.get(), FileAttributeTagInfo,
              &tag, static_cast<DWORD>(sizeof(tag))))
            throw std::runtime_error("CitizenSDK test cleanup identity failed");
          if (is_directory && (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) cleanup(child.get());
          FILE_DISPOSITION_INFO disposition{TRUE};
          if (!::SetFileInformationByHandle(child.get(), FileDispositionInfo,
              &disposition, static_cast<DWORD>(sizeof(disposition))))
            throw std::runtime_error("CitizenSDK test cleanup deletion failed");
          removed = true;
          break;
        }
        if (entry->NextEntryOffset == 0) break;
        entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO *>(reinterpret_cast<uint8_t *>(entry) + entry->NextEntryOffset);
      }
      if (!removed) return;
    }
  }
  std::vector<TestHandle> ancestors_;
  TestHandle directory_;
  std::filesystem::path path_;
  std::wstring name_;
  FILE_ID_INFO identity_{};
};

// 替身仅生成有界回调，不实现链、密钥、存储或 Host；被测试的是生产 session 路由。
inline const csf::Value::List &items(const csf::Value &value) {
  return std::get<csf::Value::List>(value.data);
}
inline const std::string &text(const csf::Value &value) {
  return std::get<std::string>(value.data);
}

}  // namespace citizen_sdk::flutter::test

#endif
