#ifndef CITIZENSDK_CPP_CONFIG_HPP
#define CITIZENSDK_CPP_CONFIG_HPP

#include <array>
#include <filesystem>
#include <functional>
#include <future>
#include <optional>
#include <vector>
#include <string>
#include "citizen_sdk/citizensdk_host.h"
#include "citizen_sdk/citizen_sdk_models.hpp"

namespace citizen_sdk {

// 只传递实际密钥操作事实；宿主拥有输入界面，必须响应cancelled并终结Future。
struct CredentialChallenge {
  uint64_t host_operation_id{};
  std::string key_purpose;
  std::optional<AccountId> account_id;
  std::shared_future<void> cancelled;
};

struct Config {
  std::filesystem::path storage_root;
  std::filesystem::path asset_root;
  std::string application_id;
  void *gtk_parent_window = nullptr;
  // 唯一模块选择；平台只装配资源，不复制 Rust 的依赖规则。
  uint32_t modules = CITIZENSDK_MODULE_FULL;
  // nullopt表示取消；返回的字节由SDK在交付后清零，不接收布尔授权。
  std::function<std::future<std::optional<std::vector<uint8_t>>>(
      const CredentialChallenge &)> credentialProvider;
};

inline citizensdk_bytes_view_t bytes_view(const std::string &value) noexcept {
  return {reinterpret_cast<const uint8_t *>(value.data()), static_cast<uint64_t>(value.size())};
}

}  // namespace citizen_sdk

#endif
