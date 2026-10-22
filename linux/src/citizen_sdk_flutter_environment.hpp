#ifndef CITIZENSDK_FLUTTER_ENVIRONMENT_HPP
#define CITIZENSDK_FLUTTER_ENVIRONMENT_HPP

#include <gtk/gtk.h>

#include <filesystem>
#include <memory>
#include <string>
#include <thread>

#include "citizen_sdk/citizen_sdk_config.hpp"

namespace citizen_sdk::flutter {

// 环境参数只在原生装配层存在，不能通过公共 channel 覆盖身份、路径或窗口。
// Native-only environment values. No platform-channel method accepts this
// structure, an application identifier, a filesystem path or a GTK pointer.
struct NativeEnvironmentInputs {
  std::filesystem::path executable;
  std::filesystem::path user_data;
  std::string application_id;
};

// Keep the temporary strong parent reference alive until Host has installed
// its own weak reference. Sessions must construct Host on the captured UI
// thread before releasing this short-lived native-only snapshot.
struct OpenEnvironment {
  Config config;
  std::shared_ptr<void> ui_parent_lease;
};

class FlutterEnvironment final {
 public:
  explicit FlutterEnvironment(GtkWidget *view);
  ~FlutterEnvironment();
  FlutterEnvironment(const FlutterEnvironment &) = delete;
  FlutterEnvironment &operator=(const FlutterEnvironment &) = delete;

  OpenEnvironment open(uint32_t modules = CITIZENSDK_MODULE_FULL) const;
  void detach() noexcept;

  // The same validation used by open(), separated only so contract tests can
  // supply native process fixtures without altering global environment state.
  static Config resolve(const NativeEnvironmentInputs &inputs,
                        uint32_t modules = CITIZENSDK_MODULE_FULL);

 private:
  GWeakRef view_{};
  std::thread::id ui_thread_;
  bool detached_ = false;
};

}  // namespace citizen_sdk::flutter

#endif
