#ifndef CITIZENSDK_SECRET_HPP
#define CITIZENSDK_SECRET_HPP

#include <cstddef>
#include <cstdint>
#include <vector>
#include <array>
#include <string>
#include <stdexcept>
#include <utility>
#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <string.h>
#else
#include <openssl/crypto.h>
#endif

namespace citizen_sdk {
// 仅保存身份、公开材料及硬件密封对象；不承载明文账户秘密。
struct WalletKey final {uint32_t wallet_index{};std::array<uint8_t,16> generation{};};
struct VaultObject final {std::vector<uint8_t> public_blob,private_blob,name,auth_salt;std::string key_name;};


void secure_zero(void *memory, std::size_t size) noexcept;

class SensitiveBuffer final {
 public:
  SensitiveBuffer() = default;
  explicit SensitiveBuffer(std::size_t size);
  SensitiveBuffer(const uint8_t *bytes, std::size_t size);
  SensitiveBuffer(const SensitiveBuffer &) = delete;
  SensitiveBuffer &operator=(const SensitiveBuffer &) = delete;
  SensitiveBuffer(SensitiveBuffer &&other) noexcept;
  SensitiveBuffer &operator=(SensitiveBuffer &&other) noexcept;
  ~SensitiveBuffer();

  uint8_t *data() noexcept { return bytes_.data(); }
  const uint8_t *data() const noexcept { return bytes_.data(); }
  std::size_t size() const noexcept { return bytes_.size(); }
  bool empty() const noexcept { return bytes_.empty(); }
  void clear() noexcept;

 private:
  std::vector<uint8_t> bytes_;
};



inline void secure_zero(void *memory, std::size_t size) noexcept {
  if (memory != nullptr && size != 0) {
#if defined(_WIN32)
    SecureZeroMemory(memory, size);
#elif defined(__APPLE__)
    volatile unsigned char *bytes = static_cast<volatile unsigned char *>(memory);
    while (size-- != 0) *bytes++ = 0;
#else
    OPENSSL_cleanse(memory, size);
#endif
  }
}

inline SensitiveBuffer::SensitiveBuffer(std::size_t size) : bytes_(size, 0) {}

inline SensitiveBuffer::SensitiveBuffer(const uint8_t *bytes, std::size_t size) {
  if (size == 0) return;
  if (bytes == nullptr) {
    throw std::invalid_argument("CitizenSDK sensitive input is null");
  }
  bytes_.assign(bytes, bytes + size);
}

inline SensitiveBuffer::SensitiveBuffer(SensitiveBuffer &&other) noexcept
    : bytes_(std::move(other.bytes_)) {
  other.clear();
}

inline SensitiveBuffer &SensitiveBuffer::operator=(SensitiveBuffer &&other) noexcept {
  if (this != &other) {
    clear();
    bytes_ = std::move(other.bytes_);
    other.clear();
  }
  return *this;
}

inline SensitiveBuffer::~SensitiveBuffer() { clear(); }

inline void SensitiveBuffer::clear() noexcept {
  secure_zero(bytes_.data(), bytes_.size());
  bytes_.clear();
  // shrink_to_fit is not a noexcept contract. Swapping releases the already
  // cleansed allocation without a throwing operation on the destruction path.
  std::vector<uint8_t> empty;
  bytes_.swap(empty);
}


} // namespace citizen_sdk

#endif
