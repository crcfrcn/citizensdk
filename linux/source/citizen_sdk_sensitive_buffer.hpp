#ifndef CITIZENSDK_LINUX_SENSITIVE_BUFFER_HPP
#define CITIZENSDK_LINUX_SENSITIVE_BUFFER_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

namespace citizen_sdk::linux {

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

}  // namespace citizen_sdk::linux

#endif
