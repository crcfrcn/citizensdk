#include "citizen_sdk_flutter_environment.hpp"

#include <gio/gio.h>

#include <array>
#include <unistd.h>

#include "citizen_sdk_flutter_codec.hpp"

namespace citizen_sdk::flutter {
namespace {

void require(bool valid, citizensdk_error_code_t code, const char *message) {
  if (!valid) throw ContractFailure(code, message);
}

void require_absolute_path(const std::filesystem::path &path) {
  const std::string native = path.string();
  require(path.is_absolute() && path != path.root_path() &&
              native.find('\0') == std::string::npos,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK native environment path must be absolute and non-root");
  for (const auto &part : path) {
    require(part != "." && part != "..",
            CITIZENSDK_ERROR_INVALID_ARGUMENT,
            "CitizenSDK native environment path contains an unsafe component");
  }
}

std::filesystem::path executable_path() {
  // 只使用官方 bundle 的可执行文件相对资产路径，不接收 Dart 路径或共享默认身份。
  // Flutter's public FlEngine API has no asset-root accessor. A Linux bundle
  // therefore uses its official executable-relative data/flutter_assets tree;
  // cwd, Dart arguments and another application's assets are never fallbacks.
  std::array<char, 4096> buffer{};
  const ssize_t length = ::readlink("/proc/self/exe", buffer.data(), buffer.size());
  require(length > 0 && static_cast<std::size_t>(length) < buffer.size(),
          CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK could not resolve the native executable");
  return std::filesystem::path(
      std::string(buffer.data(), static_cast<std::size_t>(length)));
}

void preflight_assets(const std::filesystem::path &root) {
  // 此处仅提前诊断缺失文件；真正的 no-follow 读取与链锚验真仍由既有 Host/Core 负责。
  // This is an early packaging diagnostic, not Host's security boundary.
  // The installed Host re-opens with its no-follow reader and Core verifies
  // hashes/manifest. Do not link hidden Host helpers or rebuild its VFS here.
  std::filesystem::path current;
  std::error_code error;
  for (const auto &part : root) {
    current /= part;
    const auto status = std::filesystem::symlink_status(current, error);
    require(!error && std::filesystem::is_directory(status),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK Flutter asset directory is missing or unsafe");
  }
  for (const char *name : {"manifest.json", "chainspec.json", "light_sync_state.json"}) {
    const auto path = root / name;
    const auto status = std::filesystem::symlink_status(path, error);
    require(!error && std::filesystem::is_regular_file(status),
            CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK Flutter chain asset is missing or unsafe");
    const auto size = std::filesystem::file_size(path, error);
    require(!error && size > 0, CITIZENSDK_ERROR_INTEGRITY,
            "CitizenSDK Flutter chain asset is empty or unreadable");
  }
}

}  // namespace

FlutterEnvironment::FlutterEnvironment(GtkWidget *view)
    : ui_thread_(std::this_thread::get_id()) {
  require(view == nullptr || GTK_IS_WIDGET(view),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK Flutter registrar view is invalid");
  g_weak_ref_init(&view_, view);
}

FlutterEnvironment::~FlutterEnvironment() { g_weak_ref_clear(&view_); }

void FlutterEnvironment::detach() noexcept {
  // Plugin/session lifecycle calls are UI-thread confined. Clearing a weak
  // reference does not destroy a GTK window or prolong its lifetime.
  if (std::this_thread::get_id() != ui_thread_) return;
  detached_ = true;
  g_weak_ref_set(&view_, nullptr);
}

Config FlutterEnvironment::resolve(const NativeEnvironmentInputs &inputs, uint32_t modules) {
  require_absolute_path(inputs.executable);
  require_absolute_path(inputs.user_data);
  require(inputs.application_id.find('\0') == std::string::npos &&
              g_application_id_is_valid(inputs.application_id.c_str()),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK requires a valid native GApplication identifier");
  const auto assets = inputs.executable.parent_path() / "data" /
                      "flutter_assets" / "packages" / "citizen_sdk" /
                      "chain";

  // 未选择链模块时不探测链资产；真正启用链时保留原来的严格预检。
  if ((modules & CITIZENSDK_MODULE_CHAIN) != 0) preflight_assets(assets);
  Config config;
  config.storage_root = inputs.user_data;
  config.asset_root = assets;
  // Host remains the authority for its stricter lowercase reverse-DNS rule.
  config.application_id = inputs.application_id;
  config.modules = modules;
  return config;
}

OpenEnvironment FlutterEnvironment::open(uint32_t modules) const {
  require(std::this_thread::get_id() == ui_thread_,
          CITIZENSDK_ERROR_INVALID_STATE,
          "CitizenSDK Flutter environment must be resolved on the UI thread");
  require(!detached_, CITIZENSDK_ERROR_INVALID_STATE,
          "CitizenSDK Flutter environment is detached");
  GApplication *application = g_application_get_default();
  require(application != nullptr, CITIZENSDK_ERROR_INVALID_STATE,
          "CitizenSDK requires the embedding application's GApplication");
  const char *identifier = g_application_get_application_id(application);
  const char *data_root = g_get_user_data_dir();
  require(identifier != nullptr && identifier[0] != '\0',
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "CitizenSDK requires the embedding application's real identifier");
  require(data_root != nullptr && data_root[0] != '\0',
          CITIZENSDK_ERROR_UNAVAILABLE,
          "CitizenSDK user data directory is unavailable");

  OpenEnvironment result{
      resolve({executable_path(), std::filesystem::path(data_root), identifier}, modules),
      {}};
  g_autoptr(GObject) object =
      static_cast<GObject *>(g_weak_ref_get(const_cast<GWeakRef *>(&view_)));
  if ((modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING | CITIZENSDK_MODULE_QR)) != 0 &&
      object != nullptr && GTK_IS_WIDGET(object)) {
    // 父窗口临时升级强引用仅跨越 Host 装配；Host 随后仍持有弱引用，不延长窗口生命周期。
    GtkWidget *view = GTK_WIDGET(object);
    GtkWidget *top = gtk_widget_get_toplevel(view);
    if (!gtk_widget_in_destruction(view) && GTK_IS_WINDOW(top) &&
        !gtk_widget_in_destruction(top)) {
      // A window belonging to another GApplication cannot lend CitizenSDK a
      // presentation identity. Headless/detached views are not silently
      // replaced by the active window of some unrelated application.
      GtkApplication *owner = gtk_window_get_application(GTK_WINDOW(top));
      require(owner != nullptr && G_APPLICATION(owner) == application,
              CITIZENSDK_ERROR_INVALID_STATE,
              "CitizenSDK Flutter parent belongs to another application");
      result.ui_parent_lease = std::shared_ptr<void>(
          g_object_ref(top), [](void *window) { g_object_unref(window); });
      result.config.gtk_parent_window = top;
    }
  }
  // No view/window is valid for read-only chain work. Host's native wallet UI
  // explicitly refuses presentation without a live parent; do not invent one.
  return result;
}

}  // namespace citizen_sdk::flutter
