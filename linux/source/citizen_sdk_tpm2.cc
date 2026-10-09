#include "citizen_sdk_tpm2.hpp"

#include <algorithm>
#include <cstring>
#include <memory>
#include <utility>
#include <vector>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <sys/stat.h>
#include <tss2/tss2_esys.h>
#include <tss2/tss2_mu.h>
#include <tss2/tss2_rc.h>
#include <tss2/tss2_tcti_device.h>
#include "citizen_sdk_host_record.hpp"

namespace citizen_sdk::linux {

TpmErrorMapping map_tpm2_error(uint32_t response,
                              citizensdk_error_code_t mapped) noexcept {
  if (response == TSS2_RC_SUCCESS) return {CITIZENSDK_OK, false};

  // TPM2-TSS 4.1.3 defines the layer in bits 16..23 in tss2_common.h.
  // Only raw TPM and resource-manager-forwarded TPM responses carry TPM
  // format-one selectors. ESAPI/SYS/MU/TCTI/RESMGR errors belong to different
  // numeric domains, even when their low bits resemble a TPM response.
  const TSS2_RC layer = response & TSS2_RC_LAYER_MASK;
  if (layer != TSS2_TPM_RC_LAYER && layer != TSS2_RESMGR_TPM_RC_LAYER) {
    return {mapped, false};
  }
  TPM2_RC base = response & ~TSS2_RC_LAYER_MASK;
  if ((base & UINT32_C(0xffff0000)) != 0) return {mapped, false};
  if ((base & TPM2_RC_FMT1) != 0) {
    // tss2_tpm2_types.h encodes the handle/session/parameter selectors outside
    // the six-bit format-one error number. Preserve the format bit itself.
    base &= static_cast<TPM2_RC>(TPM2_RC_FMT1 | UINT32_C(0x3f));
  }
  if (base == TPM2_RC_BAD_AUTH || base == TPM2_RC_AUTH_FAIL) {
    return {CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, false};
  }
  if (base == TPM2_RC_LOCKOUT) {
    return {CITIZENSDK_ERROR_UNAVAILABLE, true};
  }
  if (base == TPM2_RC_HANDLE || base == TPM2_RC_REFERENCE_H0) {
    return {CITIZENSDK_ERROR_KEY_INVALIDATED, false};
  }
  return {mapped, false};
}

namespace {

template <typename Function>
class ScopeExit final {
 public:
  explicit ScopeExit(Function function) : function_(std::move(function)) {}
  ScopeExit(const ScopeExit &) = delete;
  ~ScopeExit() noexcept { function_(); }
 private:
  Function function_;
};

template <typename Function>
ScopeExit<Function> on_exit(Function function) {
  return ScopeExit<Function>(std::move(function));
}

struct EsysDeleter final {
  template <typename T> void operator()(T *value) const noexcept { Esys_Free(value); }
};
template <typename T> using EsysPointer = std::unique_ptr<T, EsysDeleter>;

class EsysHandle final {
 public:
  EsysHandle() = default;
  EsysHandle(ESYS_CONTEXT *context, ESYS_TR handle)
      : context_(context), handle_(handle) {}
  EsysHandle(const EsysHandle &) = delete;
  EsysHandle &operator=(const EsysHandle &) = delete;
  EsysHandle(EsysHandle &&other) noexcept
      : context_(other.context_), handle_(other.handle_) { other.handle_ = ESYS_TR_NONE; }
  ~EsysHandle() { if (handle_ != ESYS_TR_NONE) Esys_FlushContext(context_, handle_); }
  ESYS_TR get() const noexcept { return handle_; }
  ESYS_TR release() noexcept { const ESYS_TR value = handle_; handle_ = ESYS_TR_NONE; return value; }
 private:
  ESYS_CONTEXT *context_{};
  ESYS_TR handle_{ESYS_TR_NONE};
};

class TpmContext final {
 public:
  TpmContext() {
    const char *device = nullptr;
    struct stat status {};
    if (::lstat("/dev/tpmrm0", &status) == 0 && S_ISCHR(status.st_mode)) {
      device = "/dev/tpmrm0";
    } else if (::lstat("/dev/tpm0", &status) == 0 && S_ISCHR(status.st_mode)) {
      device = "/dev/tpm0";
    } else {
      throw HostError(CITIZENSDK_ERROR_UNSUPPORTED,
                      "TPM 2.0 device is not present");
    }
    std::size_t bytes = 0;
    TSS2_RC code = Tss2_Tcti_Device_Init(nullptr, &bytes, device);
    if (code != TSS2_RC_SUCCESS || bytes == 0) {
      throw HostError(CITIZENSDK_ERROR_UNAVAILABLE,
                      "TPM 2.0 device transport is unavailable");
    }
    storage_.resize(bytes);
    tcti_ = reinterpret_cast<TSS2_TCTI_CONTEXT *>(storage_.data());
    code = Tss2_Tcti_Device_Init(tcti_, &bytes, device);
    if (code != TSS2_RC_SUCCESS) {
      tcti_ = nullptr;
      throw HostError(CITIZENSDK_ERROR_UNAVAILABLE,
                      "TPM 2.0 device transport initialization failed");
    }
    tcti_initialized_ = true;
    if (Esys_Initialize(&esys_, tcti_, nullptr) != TSS2_RC_SUCCESS) {
      if (esys_ != nullptr) Esys_Finalize(&esys_);
      esys_ = nullptr;
      Tss2_Tcti_Finalize(tcti_);
      tcti_initialized_ = false;
      tcti_ = nullptr;
      throw HostError(CITIZENSDK_ERROR_UNAVAILABLE,
                      "TPM 2.0 ESAPI initialization failed");
    }
    esys_initialized_ = true;
  }
  TpmContext(const TpmContext &) = delete;
  TpmContext &operator=(const TpmContext &) = delete;
  ~TpmContext() {
    if (esys_initialized_) Esys_Finalize(&esys_);
    if (tcti_initialized_) Tss2_Tcti_Finalize(tcti_);
    secure_zero(storage_.data(), storage_.size());
  }
  ESYS_CONTEXT *get() const noexcept { return esys_; }

 private:
  std::vector<uint8_t> storage_;
  TSS2_TCTI_CONTEXT *tcti_{};
  ESYS_CONTEXT *esys_{};
  bool tcti_initialized_{false};
  bool esys_initialized_{false};
};

void check(TSS2_RC code, citizensdk_error_code_t mapped, const char *message) {
  if (code == TSS2_RC_SUCCESS) return;
  const TpmErrorMapping result = map_tpm2_error(code, mapped);
  throw HostError(result.code, result.dictionary_attack_lockout
                                  ? "TPM dictionary-attack lockout is active"
                                  : message);
}

TPM2B_PUBLIC primary_template() {
  TPM2B_PUBLIC value{};
  value.publicArea.type = TPM2_ALG_RSA;
  value.publicArea.nameAlg = TPM2_ALG_SHA256;
  value.publicArea.objectAttributes =
      TPMA_OBJECT_RESTRICTED | TPMA_OBJECT_DECRYPT | TPMA_OBJECT_FIXEDTPM |
      TPMA_OBJECT_FIXEDPARENT | TPMA_OBJECT_SENSITIVEDATAORIGIN |
      TPMA_OBJECT_USERWITHAUTH;
  value.publicArea.parameters.rsaDetail.symmetric.algorithm = TPM2_ALG_AES;
  value.publicArea.parameters.rsaDetail.symmetric.keyBits.aes = 128;
  value.publicArea.parameters.rsaDetail.symmetric.mode.aes = TPM2_ALG_CFB;
  value.publicArea.parameters.rsaDetail.scheme.scheme = TPM2_ALG_NULL;
  value.publicArea.parameters.rsaDetail.keyBits = 2048;
  value.publicArea.parameters.rsaDetail.exponent = 0;
  return value;
}

TPM2B_PUBLIC child_template() {
  TPM2B_PUBLIC value{};
  value.publicArea.type = TPM2_ALG_RSA;
  value.publicArea.nameAlg = TPM2_ALG_SHA256;
  value.publicArea.objectAttributes =
      TPMA_OBJECT_DECRYPT | TPMA_OBJECT_FIXEDTPM | TPMA_OBJECT_FIXEDPARENT |
      TPMA_OBJECT_SENSITIVEDATAORIGIN | TPMA_OBJECT_USERWITHAUTH;
  value.publicArea.parameters.rsaDetail.symmetric.algorithm = TPM2_ALG_NULL;
  value.publicArea.parameters.rsaDetail.scheme.scheme = TPM2_ALG_NULL;
  value.publicArea.parameters.rsaDetail.keyBits = 2048;
  value.publicArea.parameters.rsaDetail.exponent = 0;
  return value;
}

void validate_public_template(const TPM2B_PUBLIC &actual,
                              const TPM2B_PUBLIC &expected,
                              bool require_unique,
                              citizensdk_error_code_t code,
                              const char *message) {
  const TPMT_PUBLIC &value = actual.publicArea;
  const TPMT_PUBLIC &contract = expected.publicArea;
  require(actual.size > 0 && actual.size <= sizeof(actual.publicArea) &&
              value.type == contract.type &&
              value.nameAlg == contract.nameAlg &&
              value.objectAttributes == contract.objectAttributes &&
              value.authPolicy.size == 0 &&
              value.parameters.rsaDetail.symmetric.algorithm ==
                  contract.parameters.rsaDetail.symmetric.algorithm &&
              value.parameters.rsaDetail.symmetric.keyBits.aes ==
                  contract.parameters.rsaDetail.symmetric.keyBits.aes &&
              value.parameters.rsaDetail.symmetric.mode.aes ==
                  contract.parameters.rsaDetail.symmetric.mode.aes &&
              value.parameters.rsaDetail.scheme.scheme ==
                  contract.parameters.rsaDetail.scheme.scheme &&
              value.parameters.rsaDetail.keyBits ==
                  contract.parameters.rsaDetail.keyBits &&
              value.parameters.rsaDetail.exponent ==
                  contract.parameters.rsaDetail.exponent &&
              value.unique.rsa.size <= sizeof(value.unique.rsa.buffer) &&
              (!require_unique || value.unique.rsa.size == 256),
          code, message);
}

uint32_t read_tpm_property(ESYS_CONTEXT *context, uint32_t property) {
  TPMS_CAPABILITY_DATA *capability = nullptr;
  TPMI_YES_NO more = TPM2_NO;
  const TSS2_RC result = Esys_GetCapability(
      context, ESYS_TR_NONE, ESYS_TR_NONE, ESYS_TR_NONE,
      TPM2_CAP_TPM_PROPERTIES, property, 1, &more, &capability);
  EsysPointer<TPMS_CAPABILITY_DATA> owner(capability);
  check(result, CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM security properties could not be queried");
  require(capability != nullptr &&
              capability->data.tpmProperties.count == 1 &&
              capability->data.tpmProperties.count <=
                  sizeof(capability->data.tpmProperties.tpmProperty) /
                      sizeof(capability->data.tpmProperties.tpmProperty[0]) &&
              capability->data.tpmProperties.tpmProperty[0].property == property,
          CITIZENSDK_ERROR_INTEGRITY,
          "TPM security property response is malformed");
  return capability->data.tpmProperties.tpmProperty[0].value;
}

void require_tpm_security_state(ESYS_CONTEXT *context) {
  // TPM 2.0 Library Specification, TPMA_PERMANENT.ownerAuthSet (bit 0).
  // CitizenSDK deliberately uses an empty owner authorization when creating
  // its transient primary. A platform-managed non-empty owner auth therefore
  // cannot satisfy this Host implementation and must not be reported ready.
  constexpr uint32_t kOwnerAuthSet = uint32_t{1} << 0;
  // TPM 2.0 Library Specification, TPMA_PERMANENT.inLockout (bit 9).
  constexpr uint32_t kPermanentInLockout = uint32_t{1} << 9;
  // TPM 2.0 Library Specification, TPMA_STARTUP_CLEAR.shEnable (bit 1).
  constexpr uint32_t kStorageHierarchyEnabled = uint32_t{1} << 1;
  const uint32_t permanent = read_tpm_property(context, TPM2_PT_PERMANENT);
  const uint32_t startup_clear =
      read_tpm_property(context, TPM2_PT_STARTUP_CLEAR);
  const uint32_t failures = read_tpm_property(context, TPM2_PT_LOCKOUT_COUNTER);
  const uint32_t maximum = read_tpm_property(context, TPM2_PT_MAX_AUTH_FAIL);
  const uint32_t interval = read_tpm_property(context, TPM2_PT_LOCKOUT_INTERVAL);
  const uint32_t recovery = read_tpm_property(context, TPM2_PT_LOCKOUT_RECOVERY);
  require((permanent & kOwnerAuthSet) == 0 &&
              (permanent & kPermanentInLockout) == 0 &&
              (startup_clear & kStorageHierarchyEnabled) != 0 && maximum > 0 &&
              failures < maximum && interval > 0 && recovery > 0,
          CITIZENSDK_ERROR_UNAVAILABLE,
          "TPM owner authorization, storage hierarchy, or dictionary-attack state is incompatible");

  const TPM2B_PUBLIC primary = primary_template();
  TPMT_PUBLIC_PARMS primary_parameters{};
  primary_parameters.type = TPM2_ALG_RSA;
  primary_parameters.parameters.rsaDetail =
      primary.publicArea.parameters.rsaDetail;
  check(Esys_TestParms(context, ESYS_TR_NONE, ESYS_TR_NONE, ESYS_TR_NONE,
                       &primary_parameters),
        CITIZENSDK_ERROR_UNSUPPORTED,
        "TPM does not support the required RSA-2048/AES-128-CFB primary");

  const TPM2B_PUBLIC child = child_template();
  TPMT_PUBLIC_PARMS oaep_parameters{};
  oaep_parameters.type = TPM2_ALG_RSA;
  oaep_parameters.parameters.rsaDetail =
      child.publicArea.parameters.rsaDetail;
  oaep_parameters.parameters.rsaDetail.scheme.scheme = TPM2_ALG_OAEP;
  oaep_parameters.parameters.rsaDetail.scheme.details.oaep.hashAlg =
      TPM2_ALG_SHA256;
  check(Esys_TestParms(context, ESYS_TR_NONE, ESYS_TR_NONE, ESYS_TR_NONE,
                       &oaep_parameters),
        CITIZENSDK_ERROR_UNSUPPORTED,
        "TPM does not support the required RSA-2048/OAEP-SHA256 wrapping parameters");
}

ESYS_TR create_primary(ESYS_CONTEXT *context) {
  TPM2B_SENSITIVE_CREATE sensitive{};
  TPM2B_PUBLIC public_area = primary_template();
  TPM2B_DATA outside{};
  TPML_PCR_SELECTION pcr{};
  ESYS_TR handle = ESYS_TR_NONE;
  TPM2B_PUBLIC *created_public = nullptr;
  TPM2B_CREATION_DATA *creation = nullptr;
  TPM2B_DIGEST *hash = nullptr;
  TPMT_TK_CREATION *ticket = nullptr;
  // Owner authorization is deliberately empty. ESYS_TR_PASSWORD here carries
  // no password or wallet material; every command that carries child auth or
  // secret parameters uses the salted encrypted HMAC session below.
  const TSS2_RC code = Esys_CreatePrimary(
      context, ESYS_TR_RH_OWNER, ESYS_TR_PASSWORD, ESYS_TR_NONE, ESYS_TR_NONE,
      &sensitive, &public_area, &outside, &pcr, &handle, &created_public,
      &creation, &hash, &ticket);
  EsysPointer<TPM2B_PUBLIC> created_public_owner(created_public);
  EsysPointer<TPM2B_CREATION_DATA> creation_owner(creation);
  EsysPointer<TPM2B_DIGEST> hash_owner(hash);
  EsysPointer<TPMT_TK_CREATION> ticket_owner(ticket);
  EsysHandle handle_owner(context, handle);
  check(code,
        CITIZENSDK_ERROR_UNAVAILABLE, "TPM primary-key creation failed");
  require(handle != ESYS_TR_NONE && created_public != nullptr &&
              created_public->size > 0 &&
              created_public->size <= sizeof(created_public->publicArea) &&
              creation != nullptr && hash != nullptr && ticket != nullptr,
          CITIZENSDK_ERROR_INTEGRITY,
          "TPM primary-key creation returned incomplete output");
  validate_public_template(*created_public, public_area, true,
                           CITIZENSDK_ERROR_INTEGRITY,
                           "TPM primary-key template differs from contract");
  return handle_owner.release();
}

ESYS_TR start_encrypted_session(ESYS_CONTEXT *context, ESYS_TR primary) {
  TPM2B_NONCE nonce{};
  nonce.size = 32;
  if (RAND_bytes(nonce.buffer, static_cast<int>(nonce.size)) != 1) {
    throw HostError(CITIZENSDK_ERROR_INTERNAL,
                    "CitizenSDK session nonce generation failed");
  }
  TPMT_SYM_DEF symmetric{};
  symmetric.algorithm = TPM2_ALG_AES;
  symmetric.keyBits.aes = 128;
  symmetric.mode.aes = TPM2_ALG_CFB;
  ESYS_TR session = ESYS_TR_NONE;
  const TSS2_RC start_code = Esys_StartAuthSession(context, primary,
                              ESYS_TR_NONE, ESYS_TR_NONE,
                              ESYS_TR_NONE, ESYS_TR_NONE, &nonce,
                              TPM2_SE_HMAC, &symmetric, TPM2_ALG_SHA256,
                              &session);
  EsysHandle session_owner(context, session);
  check(start_code,
        CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM encrypted authorization session could not start");
  require(session != ESYS_TR_NONE, CITIZENSDK_ERROR_INTEGRITY,
          "TPM encrypted authorization session returned no handle");
  check(Esys_TRSess_SetAttributes(
            context, session,
            TPMA_SESSION_CONTINUESESSION | TPMA_SESSION_DECRYPT |
                TPMA_SESSION_ENCRYPT,
            TPMA_SESSION_CONTINUESESSION | TPMA_SESSION_DECRYPT |
                TPMA_SESSION_ENCRYPT),
        CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM encrypted authorization session could not be configured");
  return session_owner.release();
}

template <typename T>
Bytes marshal(const T &value,
              TSS2_RC (*function)(const T *, uint8_t *, std::size_t,
                                  std::size_t *)) {
  Bytes bytes(sizeof(T) + 16);
  std::size_t offset = 0;
  check(function(&value, bytes.data(), bytes.size(), &offset),
        CITIZENSDK_ERROR_INTERNAL, "TPM object serialization failed");
  bytes.resize(offset);
  return bytes;
}

TPM2B_PUBLIC unmarshal_public(const Bytes &bytes) {
  TPM2B_PUBLIC value{};
  std::size_t offset = 0;
  check(Tss2_MU_TPM2B_PUBLIC_Unmarshal(bytes.data(), bytes.size(), &offset,
                                      &value),
        CITIZENSDK_ERROR_KEY_INVALIDATED, "TPM public object is malformed");
  require(offset == bytes.size(), CITIZENSDK_ERROR_KEY_INVALIDATED,
          "TPM public object contains trailing data");
  validate_public_template(value, child_template(), true,
                           CITIZENSDK_ERROR_KEY_INVALIDATED,
                           "TPM wallet-key public template differs from contract");
  return value;
}

TPM2B_PRIVATE unmarshal_private(const Bytes &bytes) {
  TPM2B_PRIVATE value{};
  std::size_t offset = 0;
  check(Tss2_MU_TPM2B_PRIVATE_Unmarshal(bytes.data(), bytes.size(), &offset,
                                       &value),
        CITIZENSDK_ERROR_KEY_INVALIDATED, "TPM private object is malformed");
  require(offset == bytes.size() && value.size > 0 &&
              value.size <= sizeof(value.buffer),
          CITIZENSDK_ERROR_KEY_INVALIDATED,
          "TPM private object length or trailing data is invalid");
  return value;
}

ESYS_TR load_child(ESYS_CONTEXT *context, ESYS_TR primary, ESYS_TR session,
                   const VaultObject &object) {
  TPM2B_PUBLIC public_blob = unmarshal_public(object.public_blob);
  TPM2B_PRIVATE private_blob = unmarshal_private(object.private_blob);
  ESYS_TR child = ESYS_TR_NONE;
  const TSS2_RC load_code = Esys_Load(context, primary, session, ESYS_TR_NONE,
                  ESYS_TR_NONE, &private_blob, &public_blob, &child);
  EsysHandle child_owner(context, child);
  check(load_code,
        CITIZENSDK_ERROR_KEY_INVALIDATED, "TPM wallet key could not be loaded");
  require(child != ESYS_TR_NONE, CITIZENSDK_ERROR_KEY_INVALIDATED,
          "TPM wallet key load returned no object handle");
  TPM2B_NAME *name = nullptr;
  const TSS2_RC name_code = Esys_TR_GetName(context, child, &name);
  EsysPointer<TPM2B_NAME> name_owner(name);
  check(name_code,
        CITIZENSDK_ERROR_KEY_INVALIDATED, "TPM wallet key name is unavailable");
  require(name != nullptr && name->size > 0 &&
              name->size <= sizeof(name->name),
          CITIZENSDK_ERROR_KEY_INVALIDATED,
          "TPM wallet key name output is empty");
  const bool equal = name != nullptr && object.name.size() == name->size &&
      std::equal(object.name.begin(), object.name.end(), name->name);
  if (!equal) {
    throw HostError(CITIZENSDK_ERROR_KEY_INVALIDATED,
                    "TPM wallet key identity does not match secure state");
  }
  return child_owner.release();
}

}  // namespace

TpmAvailability Tpm2::availability() const noexcept {
  try {
    TpmContext context;
    // Security-state checks include TPM2_TestParms for the exact primary and
    // OAEP parameter sets. That command is the authoritative readiness probe;
    // a partial/paginated algorithm-name enumeration cannot prove support for
    // the required RSA key size, symmetric mode, and OAEP hash combination.
    require_tpm_security_state(context.get());
    return TpmAvailability::kAvailable;
  } catch (const HostError &error) {
    return error.code() == CITIZENSDK_ERROR_UNSUPPORTED
               ? TpmAvailability::kUnsupported
               : TpmAvailability::kUnavailable;
  } catch (...) {
    return TpmAvailability::kUnavailable;
  }
}

SensitiveBuffer Tpm2::derive_auth(const SensitiveBuffer &password,
                                  const Bytes &salt) {
  require(!password.empty() && salt.size() == 16,
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "TPM wallet authentication input is malformed");
  SensitiveBuffer auth(32);
  if (PKCS5_PBKDF2_HMAC(
          reinterpret_cast<const char *>(password.data()),
          static_cast<int>(password.size()), salt.data(),
          static_cast<int>(salt.size()), 600000, EVP_sha256(),
          static_cast<int>(auth.size()), auth.data()) != 1) {
    throw HostError(CITIZENSDK_ERROR_INTERNAL,
                    "TPM wallet authentication derivation failed");
  }
  return auth;
}

VaultObject Tpm2::create_key(const SensitiveBuffer &password) const {
  Bytes salt(16);
  if (RAND_bytes(salt.data(), static_cast<int>(salt.size())) != 1) {
    throw HostError(CITIZENSDK_ERROR_INTERNAL,
                    "TPM wallet authentication salt generation failed");
  }
  SensitiveBuffer auth = derive_auth(password, salt);
  TpmContext context;
  require_tpm_security_state(context.get());
  EsysHandle primary(context.get(), create_primary(context.get()));
  EsysHandle session(context.get(),
                     start_encrypted_session(context.get(), primary.get()));
  TPM2B_SENSITIVE_CREATE sensitive{};
  auto clear_sensitive = on_exit([&] {
    secure_zero(&sensitive, sizeof(sensitive));
  });
  sensitive.sensitive.userAuth.size = static_cast<uint16_t>(auth.size());
  std::memcpy(sensitive.sensitive.userAuth.buffer, auth.data(), auth.size());
  TPM2B_PUBLIC public_template = child_template();
  TPM2B_DATA outside{};
  TPML_PCR_SELECTION pcr{};
  TPM2B_PRIVATE *private_blob = nullptr;
  TPM2B_PUBLIC *public_blob = nullptr;
  TPM2B_CREATION_DATA *creation = nullptr;
  TPM2B_DIGEST *hash = nullptr;
  TPMT_TK_CREATION *ticket = nullptr;
  const TSS2_RC create_code = Esys_Create(
      context.get(), primary.get(), session.get(), ESYS_TR_NONE,
      ESYS_TR_NONE, &sensitive, &public_template, &outside, &pcr,
      &private_blob, &public_blob, &creation, &hash, &ticket);
  EsysPointer<TPM2B_PRIVATE> private_owner(private_blob);
  EsysPointer<TPM2B_PUBLIC> public_owner(public_blob);
  EsysPointer<TPM2B_CREATION_DATA> creation_owner(creation);
  EsysPointer<TPM2B_DIGEST> hash_owner(hash);
  EsysPointer<TPMT_TK_CREATION> ticket_owner(ticket);
  check(create_code, CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM wallet key creation failed");
  require(private_blob != nullptr && private_blob->size > 0 &&
              private_blob->size <= sizeof(private_blob->buffer) &&
              public_blob != nullptr && public_blob->size > 0 &&
              public_blob->size <= sizeof(public_blob->publicArea) &&
              creation != nullptr && hash != nullptr && ticket != nullptr,
          CITIZENSDK_ERROR_INTEGRITY,
          "TPM wallet key creation returned incomplete output");
  validate_public_template(*public_blob, public_template, true,
                           CITIZENSDK_ERROR_INTEGRITY,
                           "TPM wallet-key template differs from contract");
  const Bytes private_bytes =
      marshal(*private_blob, Tss2_MU_TPM2B_PRIVATE_Marshal);
  const Bytes public_bytes =
      marshal(*public_blob, Tss2_MU_TPM2B_PUBLIC_Marshal);
  ESYS_TR child = ESYS_TR_NONE;
  const TSS2_RC load_code = Esys_Load(
      context.get(), primary.get(), session.get(), ESYS_TR_NONE,
      ESYS_TR_NONE, private_blob, public_blob, &child);
  EsysHandle child_owner(context.get(), child);
  check(load_code, CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM wallet key verification failed");
  require(child != ESYS_TR_NONE, CITIZENSDK_ERROR_INTEGRITY,
          "TPM wallet key verification returned no object handle");
  TPM2B_NAME *name = nullptr;
  const TSS2_RC name_code = Esys_TR_GetName(context.get(), child, &name);
  EsysPointer<TPM2B_NAME> name_owner(name);
  check(name_code, CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM wallet key name is unavailable");
  require(name != nullptr && name->size == 34 &&
              name->size <= sizeof(name->name),
          CITIZENSDK_ERROR_INTEGRITY,
          "TPM wallet key name output is not a SHA-256 object name");
  Bytes name_bytes(name->name, name->name + name->size);
  return {public_bytes, private_bytes, name_bytes, salt};
}

bool Tpm2::validate_key(const VaultObject &object) const {
  TpmContext context;
  require_tpm_security_state(context.get());
  EsysHandle primary(context.get(), create_primary(context.get()));
  EsysHandle session(context.get(),
                     start_encrypted_session(context.get(), primary.get()));
  EsysHandle child(context.get(),
                   load_child(context.get(), primary.get(), session.get(), object));
  return child.get() != ESYS_TR_NONE;
}

Bytes Tpm2::encrypt_dek(const VaultObject &object,
                        const uint8_t plaintext_dek[32]) const {
  require(plaintext_dek != nullptr, CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "TPM plaintext DEK is missing");
  TpmContext context;
  require_tpm_security_state(context.get());
  EsysHandle primary(context.get(), create_primary(context.get()));
  EsysHandle session(context.get(),
                     start_encrypted_session(context.get(), primary.get()));
  EsysHandle child(context.get(),
                   load_child(context.get(), primary.get(), session.get(), object));
  TPM2B_PUBLIC_KEY_RSA message{};
  auto clear_message = on_exit([&] {
    secure_zero(&message, sizeof(message));
  });
  message.size = 32;
  std::memcpy(message.buffer, plaintext_dek, 32);
  TPMT_RSA_DECRYPT scheme{};
  scheme.scheme = TPM2_ALG_OAEP;
  scheme.details.oaep.hashAlg = TPM2_ALG_SHA256;
  TPM2B_DATA label{};
  TPM2B_PUBLIC_KEY_RSA *cipher = nullptr;
  const TSS2_RC encrypt_code = Esys_RSA_Encrypt(
      context.get(), child.get(), session.get(), ESYS_TR_NONE, ESYS_TR_NONE,
      &message, &scheme, &label, &cipher);
  EsysPointer<TPM2B_PUBLIC_KEY_RSA> cipher_owner(cipher);
  check(encrypt_code, CITIZENSDK_ERROR_UNAVAILABLE,
        "TPM wallet DEK wrapping failed");
  require(cipher != nullptr && cipher->size > 0 &&
              cipher->size <= sizeof(cipher->buffer),
          CITIZENSDK_ERROR_INTEGRITY,
          "TPM wallet DEK wrapping returned malformed output");
  Bytes result(cipher->buffer, cipher->buffer + cipher->size);
  return result;
}

void Tpm2::decrypt_dek(const VaultObject &object, const Bytes &wrapped_dek,
                       const SensitiveBuffer &password,
                       uint8_t plaintext_dek_out[32]) const {
  if (plaintext_dek_out != nullptr) secure_zero(plaintext_dek_out, 32);
  require(plaintext_dek_out != nullptr && !wrapped_dek.empty() &&
              wrapped_dek.size() <=
                  sizeof(((TPM2B_PUBLIC_KEY_RSA *)nullptr)->buffer),
          CITIZENSDK_ERROR_INVALID_ARGUMENT,
          "TPM wrapped DEK is malformed");
  SensitiveBuffer auth = derive_auth(password, object.auth_salt);
  TpmContext context;
  require_tpm_security_state(context.get());
  EsysHandle primary(context.get(), create_primary(context.get()));
  try {
    EsysHandle session(context.get(),
                       start_encrypted_session(context.get(), primary.get()));
    EsysHandle child(context.get(),
                     load_child(context.get(), primary.get(), session.get(), object));
    TPM2B_AUTH authorization{};
    auto clear_authorization = on_exit([&] {
      secure_zero(&authorization, sizeof(authorization));
    });
    authorization.size = static_cast<uint16_t>(auth.size());
    std::memcpy(authorization.buffer, auth.data(), auth.size());
    check(Esys_TR_SetAuth(context.get(), child.get(), &authorization),
          CITIZENSDK_ERROR_UNAVAILABLE,
          "TPM wallet key authorization could not be installed");
    auto clear_esys_authorization = on_exit([&] {
      TPM2B_AUTH empty{};
      (void)Esys_TR_SetAuth(context.get(), child.get(), &empty);
      secure_zero(&empty, sizeof(empty));
    });
    TPM2B_PUBLIC_KEY_RSA cipher{};
    auto clear_cipher = on_exit([&] { secure_zero(&cipher, sizeof(cipher)); });
    cipher.size = static_cast<uint16_t>(wrapped_dek.size());
    std::memcpy(cipher.buffer, wrapped_dek.data(), wrapped_dek.size());
    TPMT_RSA_DECRYPT scheme{};
    scheme.scheme = TPM2_ALG_OAEP;
    scheme.details.oaep.hashAlg = TPM2_ALG_SHA256;
    TPM2B_DATA label{};
    TPM2B_PUBLIC_KEY_RSA *message = nullptr;
    const TSS2_RC decrypt_code = Esys_RSA_Decrypt(
        context.get(), child.get(), session.get(), ESYS_TR_NONE, ESYS_TR_NONE,
        &cipher, &scheme, &label, &message);
    auto clear_decrypted = on_exit([&] {
      if (message != nullptr) {
        secure_zero(message, sizeof(*message));
        Esys_Free(message);
      }
    });
    check(decrypt_code,
          CITIZENSDK_ERROR_KEY_INVALIDATED,
          "TPM wallet DEK unwrapping failed");
    if (message == nullptr || message->size != 32) {
      throw HostError(CITIZENSDK_ERROR_INTEGRITY,
                      "TPM unwrapped DEK length is invalid");
    }
    std::memcpy(plaintext_dek_out, message->buffer, 32);
  } catch (...) {
    secure_zero(plaintext_dek_out, 32);
    throw;
  }
}

}  // namespace citizen_sdk::linux
