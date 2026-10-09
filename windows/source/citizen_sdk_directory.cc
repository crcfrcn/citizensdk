#include "citizen_sdk_directory.hpp"

#include <aclapi.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <limits>

namespace citizen_sdk::windows {
namespace {

// NtCreateFile 的官方选项；仅在此系统适配内使用，不定义另一套文件协议。
constexpr ULONG kDirectory = 0x00000001;
constexpr ULONG kWriteThrough = 0x00000002;
constexpr ULONG kSynchronous = 0x00000020;
constexpr ULONG kNonDirectory = 0x00000040;
constexpr ULONG kOpenReparsePoint = 0x00200000;
constexpr NTSTATUS kNameMissing = static_cast<NTSTATUS>(0xc0000034u);
constexpr NTSTATUS kPathMissing = static_cast<NTSTATUS>(0xc000003au);

class LocalMemory final {
 public:
  ~LocalMemory() { if (value != nullptr) ::LocalFree(value); }
  PSECURITY_DESCRIPTOR value{};
};

void valid_component(const std::wstring &name) {
  require(!name.empty() && name.size() <= 255 && name != L"." && name != L".." &&
              name.back() != L'.' && name.back() != L' ' &&
              name.find_first_of(L"\\/:*?\"<>|") == std::wstring::npos &&
              name.find(L'\0') == std::wstring::npos &&
              std::none_of(name.begin(), name.end(), [](wchar_t c) { return c < 32; }),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK file component is invalid");
  // Win32 接口接收 UTF-16；不能让未配对 surrogate 以另一种名字到达文件系统。
  for (std::size_t index = 0; index < name.size(); ++index) {
    const auto unit = static_cast<uint16_t>(name[index]);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      require(index + 1 < name.size() && name[index + 1] >= 0xdc00 && name[index + 1] <= 0xdfff,
              CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK file component is not UTF-16");
      ++index;
    } else {
      require(unit < 0xdc00 || unit > 0xdfff, CITIZENSDK_ERROR_INVALID_ARGUMENT,
              "CitizenSDK file component is not UTF-16");
    }
  }
  std::wstring base = name.substr(0, name.find(L'.'));
  std::transform(base.begin(), base.end(), base.begin(), [](wchar_t c) {
    return c >= L'a' && c <= L'z' ? static_cast<wchar_t>(c - L'a' + L'A') : c;
  });
  const bool port = base.size() == 4 && (base.compare(0, 3, L"COM") == 0 ||
      base.compare(0, 3, L"LPT") == 0) &&
      ((base[3] >= L'1' && base[3] <= L'9') || base[3] == L'\u00b9' ||
       base[3] == L'\u00b2' || base[3] == L'\u00b3');
  require(!port && base != L"CON" && base != L"PRN" && base != L"AUX" &&
              base != L"NUL" && base != L"CONIN$" && base != L"CONOUT$",
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK device names are forbidden");
}

}  // namespace

Bytes current_user_sid() {
  HANDLE raw = nullptr;
  // 以实际调用线程身份为准；没有 impersonation token 才使用进程 token。
  if (!::OpenThreadToken(::GetCurrentThread(), TOKEN_QUERY, TRUE, &raw)) {
    require(::GetLastError() == ERROR_NO_TOKEN &&
                ::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &raw),
            CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK user identity is unavailable");
  }
  UniqueHandle token(raw);
  DWORD size = 0;
  (void)::GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
  require(size >= sizeof(TOKEN_USER) && size <= 65536,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK user identity size is invalid");
  Bytes data(size);
  require(::GetTokenInformation(token.get(), TokenUser, data.data(), size, &size) &&
              ::IsValidSid(reinterpret_cast<TOKEN_USER *>(data.data())->User.Sid),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK user identity is invalid");
  PSID sid = reinterpret_cast<TOKEN_USER *>(data.data())->User.Sid;
  Bytes result(::GetLengthSid(sid));
  require(::CopySid(static_cast<DWORD>(result.size()), result.data(), sid),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK user identity copy failed");
  return result;
}

namespace {

class PrivateSecurity final {
 public:
  explicit PrivateSecurity(const Bytes &sid)
      : acl_(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid.size()) {
    require(::InitializeSecurityDescriptor(&descriptor_, SECURITY_DESCRIPTOR_REVISION) &&
                ::InitializeAcl(reinterpret_cast<ACL *>(acl_.data()),
                                static_cast<DWORD>(acl_.size()), ACL_REVISION) &&
                ::AddAccessAllowedAceEx(reinterpret_cast<ACL *>(acl_.data()), ACL_REVISION,
                                        0, FILE_ALL_ACCESS, const_cast<uint8_t *>(sid.data())) &&
                ::SetSecurityDescriptorOwner(&descriptor_, const_cast<uint8_t *>(sid.data()), FALSE) &&
                ::SetSecurityDescriptorDacl(&descriptor_, TRUE,
                                           reinterpret_cast<ACL *>(acl_.data()), FALSE) &&
                ::SetSecurityDescriptorControl(&descriptor_, SE_DACL_PROTECTED, SE_DACL_PROTECTED),
            CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK private security descriptor failed");
  }
  PSECURITY_DESCRIPTOR get() noexcept { return &descriptor_; }
 private:
  SECURITY_DESCRIPTOR descriptor_{};
  Bytes acl_;
};

UniqueHandle create_relative(HANDLE parent, const std::wstring &name, DWORD access,
                             ULONG disposition, ULONG options,
                             PSECURITY_DESCRIPTOR security, DWORD share,
                             bool missing_allowed) {
  require(name.size() <= (std::numeric_limits<USHORT>::max() / sizeof(wchar_t)),
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK path is too long");
  UNICODE_STRING object_name{};
  object_name.Buffer = const_cast<wchar_t *>(name.data());
  object_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &object_name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE;
  attributes.SecurityDescriptor = security;
  IO_STATUS_BLOCK status_block{};
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS result = ::NtCreateFile(&raw, access | SYNCHRONIZE | READ_CONTROL |
      FILE_READ_ATTRIBUTES, &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL,
      share, disposition, options | kSynchronous | kOpenReparsePoint, nullptr, 0);
  if (missing_allowed && (result == kNameMissing || result == kPathMissing)) return {};
  require(result != static_cast<NTSTATUS>(0xc0000043u), CITIZENSDK_ERROR_BUSY,
          "CitizenSDK file has a conflicting open handle");
  require(result >= 0, CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK relative file open failed");
  return UniqueHandle(raw);
}

void verify_kind(HANDLE file, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  require(::GetFileType(file) == FILE_TYPE_DISK &&
              ::GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
              ::GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) &&
              (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
              ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory &&
              (standard.Directory != FALSE) == directory && !standard.DeletePending &&
              (directory || standard.NumberOfLinks == 1),
          CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK file must be an ordinary local object with one link");
}

void verify_volume(HANDLE file) {
  DWORD flags = 0;
  require(::GetVolumeInformationByHandleW(file, nullptr, 0, nullptr, nullptr, &flags,
                                         nullptr, 0) && (flags & FILE_PERSISTENT_ACLS) != 0,
          CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK storage requires persistent file ACLs");
  std::array<wchar_t, 32768> path{};
  const DWORD length = ::GetFinalPathNameByHandleW(file, path.data(),
      static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  require(length > 0 && length < path.size(), CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK local volume identity is unavailable");
  const std::wstring resolved(path.data(), length);
  const auto end = resolved.find(L"}\\");
  require(resolved.compare(0, 11, L"\\\\?\\Volume{") == 0 && end != std::wstring::npos,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK remote volumes are forbidden");
  const UINT type = ::GetDriveTypeW(resolved.substr(0, end + 2).c_str());
  require(type == DRIVE_FIXED || type == DRIVE_REMOVABLE,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK storage must use a local disk");
  (void)Directory::identity(file);
}

}  // namespace

Directory::Directory(const std::filesystem::path &path, bool private_state)
    : user_sid_(current_user_sid()), private_state_(private_state) {
  // 版本宏只控制编译；实际最低系统必须读 ntdll 返回的 OS 版本，不依赖应用 manifest。
  using GetVersion = NTSTATUS(NTAPI *)(OSVERSIONINFOW *);
  const auto address = ::GetProcAddress(::GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  GetVersion get_version = nullptr;
  static_assert(sizeof(get_version) == sizeof(address));
  std::memcpy(&get_version, &address, sizeof(get_version));
  OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  require(get_version != nullptr && get_version(&version) >= 0 &&
              (version.dwMajorVersion > 10 ||
               (version.dwMajorVersion == 10 && version.dwBuildNumber >= 22000)),
          CITIZENSDK_ERROR_UNSUPPORTED, "CitizenSDK requires Windows 11 or later");
  auto preferred = path;
  preferred.make_preferred();
  const std::wstring input = preferred.native();
  require(input.size() >= 3 && input.size() < 32760 &&
              ((input[0] >= L'A' && input[0] <= L'Z') || (input[0] >= L'a' && input[0] <= L'z')) &&
              input[1] == L':' && input[2] == L'\\' && input.find(L'\0') == std::wstring::npos &&
              input.find(L'/') == std::wstring::npos,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK storage root must be a local absolute path");
  PrivateSecurity security(user_sid_);
  handles_.push_back(create_relative(nullptr, L"\\??\\" + input.substr(0, 3),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE, 1, kDirectory, nullptr,
      FILE_SHARE_READ | FILE_SHARE_WRITE, false));
  verify_kind(handle(), true);
  verify_volume(handle());
  std::size_t begin = 3;
  while (begin < input.size()) {
    const std::size_t slash = input.find(L'\\', begin);
    const std::size_t end = slash == std::wstring::npos ? input.size() : slash;
    const auto component = input.substr(begin, end - begin);
    valid_component(component);
    // 每一级都由父 HANDLE 打开，保留祖先句柄且不分享删除，避免验证后换路径。
    auto next = create_relative(handle(), component, FILE_LIST_DIRECTORY | FILE_TRAVERSE,
        private_state_ ? 3 : 1, kDirectory, private_state_ ? security.get() : nullptr,
        FILE_SHARE_READ | FILE_SHARE_WRITE, false);
    verify_kind(next.get(), true);
    handles_.push_back(std::move(next));
    begin = end + 1;
  }
  require(handles_.size() > 1, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK volume root cannot be a data directory");
  verify_volume(handle());
  verify();
}

void Directory::verify_security(HANDLE file) const {
  LocalMemory descriptor;
  PSID owner = nullptr;
  PACL acl = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  require(::GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION |
              DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor.value) == ERROR_SUCCESS &&
              owner != nullptr && ::IsValidSid(owner) &&
              ::EqualSid(owner, const_cast<uint8_t *>(user_sid_.data())) && acl != nullptr &&
              ::IsValidAcl(acl) && acl->AceCount == 1 &&
              ::GetSecurityDescriptorControl(descriptor.value, &control, &revision) &&
              (control & SE_DACL_PROTECTED) != 0,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK storage owner or protected DACL differs");
  void *entry = nullptr;
  require(::GetAce(acl, 0, &entry), CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK storage ACE is unavailable");
  const auto *ace = static_cast<ACCESS_ALLOWED_ACE *>(entry);
  require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
              ace->Header.AceSize >= offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8 &&
              ace->Mask == FILE_ALL_ACCESS && ::IsValidSid(const_cast<DWORD *>(&ace->SidStart)) &&
              ::GetLengthSid(const_cast<DWORD *>(&ace->SidStart)) <=
                  ace->Header.AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart) &&
              ::EqualSid(const_cast<DWORD *>(&ace->SidStart), const_cast<uint8_t *>(user_sid_.data())),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK storage must have only its user ACE");
}

void Directory::verify() const {
  require(!handles_.empty(), CITIZENSDK_ERROR_STORAGE, "CitizenSDK directory is closed");
  const Bytes effective = current_user_sid();
  require(effective == user_sid_, CITIZENSDK_ERROR_PERMISSION_DENIED,
          "CitizenSDK storage identity changed");
  for (const auto &entry : handles_) verify_kind(entry.get(), true);
  if (private_state_) verify_security(handle());
}

FILE_ID_INFO Directory::identity(HANDLE file) {
  FILE_ID_INFO result{};
  require(::GetFileInformationByHandleEx(file, FileIdInfo, &result, sizeof(result)),
          CITIZENSDK_ERROR_UNAVAILABLE, "CitizenSDK stable file identity is unavailable");
  return result;
}

bool Directory::same_identity(const FILE_ID_INFO &left, const FILE_ID_INFO &right) noexcept {
  return left.VolumeSerialNumber == right.VolumeSerialNumber &&
      std::memcmp(left.FileId.Identifier, right.FileId.Identifier, sizeof(left.FileId.Identifier)) == 0;
}

void Directory::verify_file(HANDLE file) const {
  verify();
  verify_kind(file, false);
  if (private_state_) verify_security(file);
  require(identity(file).VolumeSerialNumber == identity(handle()).VolumeSerialNumber,
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK file escaped its storage volume");
}

UniqueHandle Directory::open_relative(const std::wstring &name, DWORD access,
                                      ULONG disposition, bool missing_allowed) const {
  valid_component(name);
  verify();
  require(disposition >= 1 && disposition <= 3 &&
              (private_state_ || (disposition == 1 && (access & ~GENERIC_READ) == 0)),
          CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK asset directories are read-only");
  PrivateSecurity security(user_sid_);
  auto result = create_relative(handle(), name, access, disposition,
      kNonDirectory | (private_state_ ? kWriteThrough : 0),
      private_state_ ? security.get() : nullptr,
      private_state_ ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ,
      missing_allowed);
  if (result) verify_file(result.get());
  return result;
}

UniqueHandle Directory::open(const std::wstring &name, DWORD access, ULONG disposition) const {
  return open_relative(name, access, disposition, false);
}

std::optional<UniqueHandle> Directory::find(const std::wstring &name, DWORD access) const {
  auto result = open_relative(name, access, 1, true);
  if (!result) return std::nullopt;
  return std::optional<UniqueHandle>(std::move(result));
}

void Directory::remove(const std::wstring &name) const {
  require(private_state_, CITIZENSDK_ERROR_PERMISSION_DENIED, "CitizenSDK assets cannot be deleted");
  auto file = find(name, DELETE | GENERIC_READ | GENERIC_WRITE);
  if (!file) return;
  // 不关闭目标后再使用 DeleteFile(path)：删除对象必须仍是被核验的同一句柄。
  FILE_DISPOSITION_INFO disposition{TRUE};
  require(::SetFileInformationByHandle(file->get(), FileDispositionInfo, &disposition, sizeof(disposition)),
          CITIZENSDK_ERROR_STORAGE, "CitizenSDK handle-bound deletion failed");
}

std::wstring Directory::utf16(const std::string &value) {
  require(value.size() <= static_cast<std::size_t>(std::numeric_limits<int>::max()) &&
              value.find('\0') == std::string::npos, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK file name is not bounded UTF-8");
  const int size = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0);
  require(size > 0, CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK file name is not UTF-8");
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  require(::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
              static_cast<int>(value.size()), result.data(), size) == size,
          CITIZENSDK_ERROR_INVALID_ARGUMENT, "CitizenSDK file name decoding failed");
  return result;
}

Bytes Directory::read(const std::string &name, std::size_t maximum) const {
  auto file = open(utf16(name));
  LARGE_INTEGER size{};
  require(::GetFileSizeEx(file.get(), &size) && size.QuadPart >= 0 &&
              static_cast<uint64_t>(size.QuadPart) <= maximum,
          CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK file exceeds its size bound");
  Bytes result(static_cast<std::size_t>(size.QuadPart));
  std::size_t offset = 0;
  while (offset < result.size()) {
    const DWORD count = static_cast<DWORD>(std::min<std::size_t>(result.size() - offset, 1024 * 1024));
    DWORD actual = 0;
    require(::ReadFile(file.get(), result.data() + offset, count, &actual, nullptr) && actual > 0,
            CITIZENSDK_ERROR_STORAGE, "CitizenSDK file read failed");
    offset += actual;
  }
  verify_file(file.get());
  return result;
}

}  // namespace citizen_sdk::windows
