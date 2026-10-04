// 验证 Linux TPM 错误层分类、OAEP-SHA256、加密 HMAC 会话和失败清零合同。
#include <algorithm>
#include <array>
#include <cassert>
#include <fstream>
#include <iterator>
#include <string>
#include <tss2/tss2_tpm2_types.h>

#include "citizen_sdk_tpm2.hpp"

#ifndef CITIZENSDK_LINUX_TEST_SOURCE_DIR
#error "CITIZENSDK_LINUX_TEST_SOURCE_DIR must point at the Linux source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

int main() {
  using namespace citizen_sdk::linux;

  // Exercise the same pure classifier used by production check(), without a
  // TPM device. Only TPM/RESMGR_TPM may interpret format-one selectors; an
  // identically shaped software-layer payload must preserve its fallback.
  constexpr citizensdk_error_code_t fallback = CITIZENSDK_ERROR_INTEGRITY;
  const auto success = map_tpm2_error(TSS2_RC_SUCCESS, fallback);
  assert(success.code == CITIZENSDK_OK && !success.dictionary_attack_lockout);
  for (const TSS2_RC layer : {TSS2_TPM_RC_LAYER, TSS2_RESMGR_TPM_RC_LAYER}) {
    for (const TPM2_RC authentication : {TPM2_RC_BAD_AUTH, TPM2_RC_AUTH_FAIL}) {
      for (const TPM2_RC selector : {TPM2_RC_H, TPM2_RC_H | TPM2_RC_2,
                                     TPM2_RC_S | TPM2_RC_3,
                                     TPM2_RC_P | TPM2_RC_F}) {
        const auto result = map_tpm2_error(layer | authentication | selector,
                                           fallback);
        assert(result.code == CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED);
        assert(!result.dictionary_attack_lockout);
      }
    }
    for (const TPM2_RC invalidated : {TPM2_RC_HANDLE,
                                      TPM2_RC_HANDLE | TPM2_RC_1,
                                      TPM2_RC_REFERENCE_H0}) {
      const auto result = map_tpm2_error(layer | invalidated, fallback);
      assert(result.code == CITIZENSDK_ERROR_KEY_INVALIDATED);
      assert(!result.dictionary_attack_lockout);
    }
    const auto lockout = map_tpm2_error(layer | TPM2_RC_LOCKOUT, fallback);
    assert(lockout.code == CITIZENSDK_ERROR_UNAVAILABLE);
    assert(lockout.dictionary_attack_lockout);
    const auto unknown = map_tpm2_error(layer | TPM2_RC_FAILURE, fallback);
    assert(unknown.code == fallback && !unknown.dictionary_attack_lockout);
  }
  for (const TSS2_RC layer : {TSS2_FEATURE_RC_LAYER, TSS2_ESAPI_RC_LAYER,
                              TSS2_SYS_RC_LAYER, TSS2_MU_RC_LAYER,
                              TSS2_TCTI_RC_LAYER, TSS2_RESMGR_RC_LAYER,
                              TSS2_RC_LAYER(0xff)}) {
    for (const TPM2_RC shaped_payload : {TPM2_RC_BAD_AUTH | TPM2_RC_S | TPM2_RC_1,
                                         TPM2_RC_AUTH_FAIL | TPM2_RC_P | TPM2_RC_2,
                                         TPM2_RC_HANDLE | TPM2_RC_3,
                                         TPM2_RC_REFERENCE_H0, TPM2_RC_LOCKOUT}) {
      const auto result = map_tpm2_error(layer | shaped_payload, fallback);
      assert(result.code == fallback && !result.dictionary_attack_lockout);
    }
  }
  const auto transport = map_tpm2_error(TSS2_TCTI_RC_IO_ERROR, fallback);
  assert(transport.code == fallback && !transport.dictionary_attack_lockout);
  const auto reserved = map_tpm2_error(UINT32_C(0x01000000) | TPM2_RC_BAD_AUTH,
                                       fallback);
  assert(reserved.code == fallback && !reserved.dictionary_attack_lockout);

  const auto availability = Tpm2().availability();
  assert(availability == TpmAvailability::kAvailable ||
         availability == TpmAvailability::kUnsupported ||
         availability == TpmAvailability::kUnavailable);

  SensitiveBuffer empty_password;
  bool empty_password_rejected = false;
  try {
    (void)Tpm2().create_key(empty_password);
  } catch (const HostError &error) {
    empty_password_rejected =
        error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(empty_password_rejected);

  std::array<uint8_t, 32> output{};
  output.fill(0xa5);
  bool malformed_rejected = false;
  try {
    Tpm2().decrypt_dek(VaultObject{}, Bytes{}, empty_password, output.data());
  } catch (const HostError &error) {
    malformed_rejected = error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  assert(malformed_rejected);
  assert(std::all_of(output.begin(), output.end(),
                     [](uint8_t byte) { return byte == 0; }));

  const std::string source_path =
      std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_tpm2.cc";
  std::ifstream stream(source_path, std::ios::binary);
  assert(stream.good());
  const std::string source((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
  for (const char *required : {"TPM2_SE_HMAC", "TPMA_SESSION_DECRYPT",
                               "TPMA_SESSION_ENCRYPT", "TPM2_ALG_OAEP",
                               "TPM2_ALG_SHA256", "TPM2_ALG_AES",
                               "TPM2_ALG_CFB", "TPMA_OBJECT_FIXEDTPM",
                               "TPMA_OBJECT_FIXEDPARENT",
                               "validate_public_template",
                               "value.type == contract.type",
                               "value.nameAlg == contract.nameAlg",
                               "value.objectAttributes == contract.objectAttributes",
                               "value.authPolicy.size == 0",
                               "value.parameters.rsaDetail.symmetric.algorithm",
                               "value.parameters.rsaDetail.symmetric.keyBits.aes",
                               "value.parameters.rsaDetail.symmetric.mode.aes",
                               "value.parameters.rsaDetail.scheme.scheme",
                               "value.parameters.rsaDetail.keyBits",
                               "value.parameters.rsaDetail.exponent",
                               "value.unique.rsa.size == 256",
                               "TPM2_CAP_TPM_PROPERTIES",
                               "TPM2_PT_PERMANENT",
                               "TPM2_PT_STARTUP_CLEAR",
                               "TPM2_PT_LOCKOUT_COUNTER",
                               "TPM2_PT_MAX_AUTH_FAIL",
                               "TPM2_PT_LOCKOUT_INTERVAL",
                               "TPM2_PT_LOCKOUT_RECOVERY",
                               "kOwnerAuthSet",
                               "kPermanentInLockout",
                               "kStorageHierarchyEnabled",
                               "Esys_TestParms",
                               "RSA-2048/AES-128-CFB",
                               "RSA-2048/OAEP-SHA256",
                               "PKCS5_PBKDF2_HMAC", "600000",
                               "EVP_sha256()", "Tss2_Tcti_Device_Init",
                               "/dev/tpmrm0", "/dev/tpm0"}) {
    assert(source.find(required) != std::string::npos);
  }
  assert(source.find("Esys_EvictControl") == std::string::npos);
  assert(source.find("TPM2_SE_POLICY") == std::string::npos);
  assert(source.find("TPM2_CAP_ALGS") == std::string::npos);
  const auto first_parameter_probe = source.find("Esys_TestParms");
  const auto second_parameter_probe = source.find(
      "Esys_TestParms", first_parameter_probe + 1);
  assert(first_parameter_probe != std::string::npos &&
         second_parameter_probe != std::string::npos &&
         first_parameter_probe < second_parameter_probe);
  const auto unmarshal = source.find("TPM2B_PUBLIC unmarshal_public");
  const auto validate = source.find(
      "validate_public_template(value, child_template(), true", unmarshal);
  const auto load_child = source.find("ESYS_TR load_child", validate);
  const auto load = source.find("Esys_Load", load_child);
  assert(unmarshal != std::string::npos && validate != std::string::npos &&
         load_child != std::string::npos && load != std::string::npos &&
         unmarshal < validate && validate < load_child && load_child < load);
  const auto availability_function =
      source.find("TpmAvailability Tpm2::availability");
  const auto security_state =
      source.find("require_tpm_security_state(context.get())",
                  availability_function);
  const auto available_return =
      source.find("TpmAvailability::kAvailable", security_state);
  assert(availability_function != std::string::npos &&
         security_state != std::string::npos &&
         available_return != std::string::npos &&
         availability_function < security_state &&
         security_state < available_return);

  const std::string auth_path =
      std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_user_auth.cc";
  std::ifstream auth_stream(auth_path, std::ios::binary);
  assert(auth_stream.good());
  const std::string auth_source(
      (std::istreambuf_iterator<char>(auth_stream)),
      std::istreambuf_iterator<char>());
  for (const char *required : {"std::chrono::seconds(5)",
                               "std::chrono::minutes(5)",
                               "CITIZENSDK_ERROR_TIMEOUT",
                               "state->abandoned = true",
                               "attach_idle(state, retire_prompt)",
                               "clear_controls(state)",
                               "void dialog_destroyed(",
                               "complete_prompt(state, CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED)",
                               "state->ready.notify_all()"}) {
    assert(auth_source.find(required) != std::string::npos);
  }
  return 0;
}
