#include "citizen_sdk_sensitive_buffer.hpp"

#include <windows.h>
#include <stdexcept>
#include <utility>

namespace citizen_sdk::windows {

void secure_zero(void *memory, std::size_t size) noexcept {
  if (memory != nullptr && size != 0) SecureZeroMemory(memory, size);
}

SensitiveBuffer::SensitiveBuffer(std::size_t size) : bytes_(size, 0) {}

SensitiveBuffer::SensitiveBuffer(const uint8_t *bytes, std::size_t size) {
  if (size == 0) return;
  if (bytes == nullptr) {
    throw std::invalid_argument("CitizenSDK sensitive input is null");
  }
  bytes_.assign(bytes, bytes + size);
}

SensitiveBuffer::SensitiveBuffer(SensitiveBuffer &&other) noexcept
    : bytes_(std::move(other.bytes_)) {
  other.clear();
}

SensitiveBuffer &SensitiveBuffer::operator=(SensitiveBuffer &&other) noexcept {
  if (this != &other) {
    clear();
    bytes_ = std::move(other.bytes_);
    other.clear();
  }
  return *this;
}

SensitiveBuffer::~SensitiveBuffer() { clear(); }

void SensitiveBuffer::clear() noexcept {
  secure_zero(bytes_.data(), bytes_.size());
  bytes_.clear();
  // 秘密先显式清零再释放；不把渲染器或操作系统内部副本宣称为已清零。
  // shrink_to_fit is not a noexcept contract. Swapping releases the already
  // cleansed allocation without a throwing operation on the destruction path.
  std::vector<uint8_t> empty;
  bytes_.swap(empty);
}

}  // namespace citizen_sdk::windows
