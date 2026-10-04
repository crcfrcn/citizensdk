// Windows 存储测试只创建中央测试根内的对象，不修改用户目录 ACL。
#include "citizen_sdk_directory.hpp"
#include "citizen_sdk_test_support.hpp"

#include <aclapi.h>
#include <sddl.h>
#include <winioctl.h>
#include <array>
#include <cassert>
#include <cstring>
#include <filesystem>
#include <functional>
#include <string>

#ifdef NDEBUG
#error "CitizenSDK Windows contract assertions must remain enabled"
#endif

namespace {
using namespace citizen_sdk::windows;

void rejects(const std::function<void()> &action, citizensdk_error_code_t expected) {
  bool rejected = false;
  try { action(); }
  catch (const HostError &error) { rejected = error.code() == expected; }
  assert(rejected);
}

Bytes security(HANDLE handle) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  assert(GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION |
      DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor) == ERROR_SUCCESS);
  const auto *bytes = static_cast<const uint8_t *>(descriptor);
  Bytes result(bytes, bytes + GetSecurityDescriptorLength(descriptor));
  LocalFree(descriptor);
  return result;
}

void public_acl(HANDLE handle) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  assert(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"D:P(A;;FA;;;WD)", SDDL_REVISION_1, &descriptor, nullptr));
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  assert(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) && present && dacl);
  assert(SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION |
      PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS);
  LocalFree(descriptor);
}

void junction(const std::filesystem::path &path, const std::filesystem::path &target) {
  // 使用 Windows 官方 mount-point reparse 布局，不依赖 symlink 管理员特权。
  assert(CreateDirectoryW(path.c_str(), nullptr));
  UniqueHandle handle(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ |
      FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  assert(handle);
  struct MountPoint {
    ULONG tag;
    USHORT data_length, reserved;
    USHORT substitute_offset, substitute_length, print_offset, print_length;
    wchar_t paths[2048];
  } data{};
  auto native_target = target;
  native_target.make_preferred();
  const std::wstring printed = native_target.native();
  const std::wstring substitute = L"\\??\\" + printed;
  assert(substitute.size() + printed.size() + 2 <= std::size(data.paths));
  data.tag = IO_REPARSE_TAG_MOUNT_POINT;
  data.substitute_length = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  data.print_offset = static_cast<USHORT>((substitute.size() + 1) * sizeof(wchar_t));
  data.print_length = static_cast<USHORT>(printed.size() * sizeof(wchar_t));
  data.data_length = static_cast<USHORT>(8 + data.print_offset + data.print_length + sizeof(wchar_t));
  std::memcpy(data.paths, substitute.data(), data.substitute_length);
  std::memcpy(reinterpret_cast<uint8_t *>(data.paths) + data.print_offset,
              printed.data(), data.print_length);
  DWORD returned = 0;
  assert(DeviceIoControl(handle.get(), FSCTL_SET_REPARSE_POINT, &data,
      static_cast<DWORD>(8 + data.data_length), nullptr, 0, &returned, nullptr));
}
}  // namespace

int main() {
  using namespace citizen_sdk::windows;
  test::TempDirectory temporary("directory");
  const auto root = temporary.path() / "state";
  Directory directory(root);
  directory.verify();
  // C:/ 由 std::filesystem 官方分隔符正规化；不应误拒 cygpath -m 输入。
  Directory slashes(std::filesystem::u8path(root.generic_u8string()));
  assert(Directory::same_identity(Directory::identity(directory.handle()),
                                 Directory::identity(slashes.handle())));
  const auto unicode = Directory::utf16(u8"公开状态-公民-😀.bin");
  {
    auto file = directory.open(unicode, GENERIC_READ | GENERIC_WRITE, 2);
    const std::array<uint8_t, 5> input{0, 1, 2, 3, 255};
    DWORD written = 0;
    assert(WriteFile(file.get(), input.data(), static_cast<DWORD>(input.size()), &written, nullptr));
    assert(written == input.size() && FlushFileBuffers(file.get()));
    directory.verify_file(file.get());
  }
  assert((directory.read(u8"公开状态-公民-😀.bin", 5) == Bytes{0, 1, 2, 3, 255}));
  rejects([&] { (void)directory.read(u8"公开状态-公民-😀.bin", 4); }, CITIZENSDK_ERROR_INTEGRITY);
  assert(!directory.find(L"missing.bin"));
  for (const auto *name : {L"", L".", L"..", L"a/b", L"a\\b", L"x:stream", L"NUL",
                           L"COM1.txt", L"LPT\u00b2", L"x.", L"x ", L"a*"}) {
    rejects([&] { (void)directory.open(name); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  rejects([&] { (void)directory.open(std::wstring(1, static_cast<wchar_t>(0xd800))); },
          CITIZENSDK_ERROR_INVALID_ARGUMENT);
  rejects([] { (void)Directory::utf16(std::string("a\0b", 3)); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  rejects([] { (void)Directory::utf16(std::string("\xc0\xaf", 2)); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  rejects([&] { Directory relative("relative"); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);
  rejects([&] { Directory traversing(root / ".." / "escape"); }, CITIZENSDK_ERROR_INVALID_ARGUMENT);

  // 同一个文件对象的额外硬链接须拒绝，包括已经打开后的 link count 变化。
  {
    auto file = directory.open(L"hard.bin", GENERIC_READ | GENERIC_WRITE, 2);
  }
  std::filesystem::create_hard_link(root / "hard.bin", root / "hard-alias.bin");
  rejects([&] { (void)directory.open(L"hard.bin"); }, CITIZENSDK_ERROR_PERMISSION_DENIED);

  const auto target = temporary.path() / "junction-target";
  { Directory created(target); }
  const auto link = temporary.path() / "junction";
  junction(link, target);
  rejects([&] { Directory linked(link); }, CITIZENSDK_ERROR_PERMISSION_DENIED);
  rejects([&] { Directory nested(link / "must-not-create"); }, CITIZENSDK_ERROR_PERMISSION_DENIED);
  assert(!std::filesystem::exists(target / "must-not-create"));

  // 活动祖先/主文件禁止 rename；关闭后普通 rename 仍可由宿主执行。
  std::error_code rename_error;
  std::filesystem::rename(root, temporary.path() / "renamed", rename_error);
  assert(rename_error);
  {
    auto file = directory.open(unicode);
    std::filesystem::rename(root / unicode, root / "renamed.bin", rename_error);
    assert(rename_error);
    rejects([&] { directory.remove(unicode); }, CITIZENSDK_ERROR_BUSY);
  }
  directory.remove(unicode);
  assert(!directory.find(unicode));

  const auto wide = temporary.path() / "wide-state";
  { Directory created(wide); }
  UniqueHandle wide_handle(CreateFileW(wide.c_str(), WRITE_DAC | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  assert(wide_handle);
  public_acl(wide_handle.get());
  const auto before = security(wide_handle.get());
  rejects([&] { Directory rejected(wide); }, CITIZENSDK_ERROR_PERMISSION_DENIED);
  assert(security(wide_handle.get()) == before);  // 不偷偷收紧现存用户数据权限。
  wide_handle.reset();

  const auto installed = temporary.path() / "assets";
  { Directory created(installed); auto file = created.open(L"manifest.json", GENERIC_READ | GENERIC_WRITE, 2); }
  auto assets = Directory::assets(installed);
  assert(assets.read("manifest.json", 1024).empty());
  rejects([&] { (void)assets.open(L"new", GENERIC_READ | GENERIC_WRITE, 3); }, CITIZENSDK_ERROR_PERMISSION_DENIED);
  rejects([&] { assets.remove(L"manifest.json"); }, CITIZENSDK_ERROR_PERMISSION_DENIED);
  return 0;
}
