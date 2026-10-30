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

class CitizenSdkHostBridge;
jobject read_result(JNIEnv *, CitizenSdkHostBridge *, uint64_t);
jobject read_capabilities(JNIEnv *, uint64_t);

} // namespace citizen::sdk::jni

#endif // CITIZENSDK_JNI_SUPPORT_HPP
