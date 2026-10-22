#ifndef CITIZENSDK_LINUX_ASSETS_HPP
#define CITIZENSDK_LINUX_ASSETS_HPP

#include <filesystem>
#include "input.hpp"

namespace citizen_sdk::linux {

struct Assets final {
  Bytes manifest;
  Bytes chain_spec;
  Bytes light_sync_state;

  static Assets load(const std::filesystem::path &root);
};

}  // namespace citizen_sdk::linux

#endif
