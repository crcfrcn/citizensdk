#ifndef CITIZENSDK_WINDOWS_ASSETS_HPP
#define CITIZENSDK_WINDOWS_ASSETS_HPP

#include <filesystem>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::windows {

struct Assets final {
  Bytes manifest;
  Bytes chain_spec;
  Bytes light_sync_state;

  static Assets load(const std::filesystem::path &root);
};

}  // namespace citizen_sdk::windows

#endif
