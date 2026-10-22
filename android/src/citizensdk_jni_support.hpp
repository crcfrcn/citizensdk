#ifndef CITIZENSDK_JNI_SUPPORT_HPP
#define CITIZENSDK_JNI_SUPPORT_HPP

#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

#include "citizensdk.h"

namespace citizen::sdk::jni {

void throw_sdk(JNIEnv *env, citizensdk_error_code_t code,
               const char *fallback_message);
bool take_bytes(JNIEnv *env, jbyteArray source, std::vector<uint8_t> *out);
bool take_ints(JNIEnv *env, jintArray source, std::vector<uint32_t> *out);
jbyteArray to_byte_array(JNIEnv *env, const std::vector<uint8_t> &bytes);

class WireWriter final {
 public:
  void u8(uint8_t value);
  void u32(uint32_t value);
  void i32(int32_t value);
  void u64(uint64_t value);
  void fixed(const uint8_t *bytes, size_t length);
  void bytes(const uint8_t *bytes, size_t length);
  void text(const std::vector<uint8_t> &value);
  const std::vector<uint8_t> &data() const { return data_; }

 private:
  std::vector<uint8_t> data_;
};

void write_block(WireWriter *writer, const citizensdk_block_ref_t &block);
void write_execution(WireWriter *writer,
                     const citizensdk_execution_info_t &execution);
bool encode_result(citizensdk_result_handle_t result, uint64_t prepared_token,
                   WireWriter *writer,
                   citizensdk_prepared_wallet_handle_t *prepared, bool *qr_review, bool *inspection = nullptr);
bool encode_capabilities(citizensdk_handle_t handle, WireWriter *writer);
bool encode_watch(citizensdk_result_handle_t result, WireWriter *writer);

}  // namespace citizen::sdk::jni

#endif  // CITIZENSDK_JNI_SUPPORT_HPP
