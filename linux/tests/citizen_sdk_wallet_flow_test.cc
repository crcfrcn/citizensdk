// 直接验证Core输入合同及非UI敏感缓冲的边界、清零与所有权。
// 私钥receiver的取消/迟到/排空回归由同平台flutter_sessions_test运行生产资源状态机。
#include <array>
#include <cassert>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include "citizensdk.h"
#include "secret.hpp"
#include "host.hpp"
#ifdef NDEBUG
#error "CitizenSDK contract assertions must remain enabled"
#endif

namespace {
citizensdk_bytes_view_t view(const std::string &value) {
  return {reinterpret_cast<const uint8_t *>(value.data()), value.size()};
}
citizensdk_wallet_input_validation_v1_t validation(uint32_t kind, const std::string &input, uint32_t count = 0) {
  citizensdk_wallet_input_validation_v1_t result{};
  result.struct_size = sizeof(result); result.abi_version = CITIZENSDK_ABI_VERSION;
  assert(citizensdk_validate_wallet_input(kind, view(input), count, &result) == CITIZENSDK_OK);
  return result;
}
}

int main() {
  const auto empty = validation(1, "");
  assert(empty.reason == 0 && empty.position == UINT32_MAX);
  assert(validation(1, "public-test").reason == 0);
  assert(validation(1, "short").reason == 7);
  assert(validation(1, "public test").reason == 5);
  assert(validation(1, std::string(1025, 'x')).reason == 1);
  // 全零合成熵对应的公开BIP39向量，不读取真实钱包。
  for (const auto &entry : std::vector<std::pair<uint32_t, std::string>>{{12, "about"}, {18, "agent"}, {24, "art"}}) {
    std::string sentence;
    for (uint32_t i = 1; i < entry.first; ++i) sentence += "abandon ";
    sentence += entry.second;
    const auto valid = validation(2, sentence, entry.first);
    assert(valid.reason == 0 && valid.position == UINT32_MAX);
    assert(validation(2, "notawalletword" + sentence.substr(7), entry.first).reason == 3);
    sentence.replace(sentence.rfind(' ') + 1, std::string::npos, "abandon");
    assert(validation(2, sentence, entry.first).reason == 4);
  }
  auto rejected = validation(1, "");
  rejected.reason = 77; rejected.position = 88;
  for (const uint32_t count : {0U, 15U, 21U, 25U}) {
    assert(citizensdk_validate_wallet_input(2, {nullptr, 0}, count, &rejected) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(rejected.reason == 77 && rejected.position == 88);
  }
  rejected.struct_size = 0;
  assert(citizensdk_validate_wallet_input(1, {nullptr, 0}, 0, &rejected) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(rejected.reason == 77 && rejected.position == 88);
  assert(citizensdk_validate_wallet_input(1, {nullptr, 0}, 0, nullptr) == CITIZENSDK_ERROR_INVALID_ARGUMENT);

  uint64_t required = 0;
  const std::string prefix = "aban";
  assert(citizensdk_wallet_word_suggestions(view(prefix), nullptr, 0, &required) == CITIZENSDK_OK);
  assert(required == 7);
  std::array<uint8_t, 7> candidate{};
  assert(citizensdk_wallet_word_suggestions(view(prefix), candidate.data(), candidate.size(), &required) == CITIZENSDK_OK);
  assert(std::string(reinterpret_cast<const char *>(candidate.data()), candidate.size()) == "abandon");
  candidate.fill(0xa5);
  assert(citizensdk_wallet_word_suggestions(view(prefix), candidate.data(), 6, &required) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  for (auto byte : candidate) assert(byte == 0xa5);

  std::array<uint8_t, 32> synthetic{}; synthetic.fill(7);
  citizen_sdk::SensitiveBuffer owned(synthetic.data(), synthetic.size());
  synthetic.fill(0);
  assert(owned.size() == 32 && owned.data()[0] == 7);
  auto moved = std::move(owned);
  assert(owned.empty() && moved.size() == 32);
  moved.clear(); assert(moved.empty());
  bool null_rejected = false;
  try { citizen_sdk::SensitiveBuffer invalid(nullptr, 32); }
  catch (const std::invalid_argument &) { null_rejected = true; }
  assert(null_rejected);
  synthetic.fill(9);
  citizen_sdk::secure_zero(synthetic.data(), synthetic.size());
  for (auto byte : synthetic) assert(byte == 0);
  // 空宿主弱引用不需要窗口或显示服务器，非宿主线程不能变更其归属。
  citizen_sdk::linux::GtkParentRef parent(nullptr, std::this_thread::get_id());
  assert(!parent.acquire() && parent.set(nullptr) == CITIZENSDK_OK);
  citizensdk_error_code_t wrong_thread = CITIZENSDK_OK;
  std::thread worker([&] { wrong_thread = parent.set(nullptr); }); worker.join();
  assert(wrong_thread == CITIZENSDK_ERROR_BUSY);
  assert(parent.set(nullptr) == CITIZENSDK_OK && !parent.acquire());

  return 0;
}
