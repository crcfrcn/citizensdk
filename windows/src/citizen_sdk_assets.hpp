// 声明Windows链信任资产的持有和安全读取接口。

#ifndef CITIZENSDK_WINDOWS_ASSETS_HPP
#define CITIZENSDK_WINDOWS_ASSETS_HPP

#include <filesystem>
#include "input.hpp"

namespace citizen_sdk::windows {

struct Assets final {
  Bytes manifest;
  Bytes chain_spec;
  Bytes light_sync_state;

  static Assets load(const std::filesystem::path &root);
};

}  // namespace citizen_sdk::windows

#endif
