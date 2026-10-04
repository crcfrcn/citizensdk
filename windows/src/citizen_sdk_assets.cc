#include "citizen_sdk_assets.hpp"

#include "citizen_sdk_directory.hpp"
#include "citizen_sdk_input_limits.hpp"

namespace citizen_sdk::windows {

Assets Assets::load(const std::filesystem::path &root) {
  // 安装资产可归安装者所有，但只允许从逐级验证的目录句柄读取；
  // 不通过路径回退，不跟随 reparse point，不把 checkpoint 当普通缓存。
  try {
    auto directory = Directory::assets(root);
    Assets result{directory.read("manifest.json", input_limits::kMaximumAssetBytes),
                  directory.read("chainspec.json", input_limits::kMaximumAssetBytes),
                  directory.read("light_sync_state.json", input_limits::kMaximumAssetBytes)};
    require(!result.manifest.empty() && !result.chain_spec.empty() && !result.light_sync_state.empty(),
            CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK packaged chain asset is empty");
    return result;
  } catch (const HostError &error) {
    if (error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT ||
        error.code() == CITIZENSDK_ERROR_UNSUPPORTED) throw;
    // 资产缺失、被替换或不可信统一映射现有 INTEGRITY 合同，不泄露系统路径。
    throw HostError(CITIZENSDK_ERROR_INTEGRITY, "CitizenSDK packaged chain asset is unavailable or untrusted");
  }
}

}  // namespace citizen_sdk::windows
