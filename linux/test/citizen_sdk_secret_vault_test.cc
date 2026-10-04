// 验证 Vault 只管理 generation KEK/随机 DEK，并在缺失能力时失败关闭。
#include <algorithm>
#include <chrono>
#include <future>
#include <stdexcept>
#include <vector>
#include <array>
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>

#include "citizen_sdk_secret_vault.hpp"
#include "citizen_sdk_test_support.hpp"

#ifndef CITIZENSDK_LINUX_TEST_SOURCE_DIR
#error "CITIZENSDK_LINUX_TEST_SOURCE_DIR must point at the Linux source root"
#endif
#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif


namespace {
// 仅使用合成凭据；不访问真实钱包和设备认证界面。
void headless_credential_contract() {
  using namespace citizen_sdk::linux;
  UserAuth auth;
  assert(!auth.available());
  assert(auth.authorize_add_accounts(0) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(auth.create_vault_password(41).code == CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED);
  assert(auth.unlock_vault_password(0).code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  struct Provider final {
    UserAuth *auth{};
    std::vector<uint8_t> bytes = std::vector<uint8_t>(12, 'a');
    uint64_t id{};
    uint32_t purpose{};
    unsigned cancellations{}, references{};
    bool provider_idle{true};
    bool hold{}, revoke{}, cancelled{}, throws{};
    std::promise<void> accepted;
    citizensdk_error_code_t response{};
  } provider;
  provider.auth = &auth;
  citizensdk_credential_provider_v1_t binding{
      sizeof(citizensdk_credential_provider_v1_t), 1, &provider,
      +[](void *context, const citizensdk_credential_challenge_v1_t *challenge) {
        auto &p = *static_cast<Provider *>(context);
        assert(challenge->struct_size == sizeof(*challenge) && challenge->abi_version == 1);
        assert(challenge->reserved == 0 && challenge->host_operation_id != 0);
        p.id = challenge->host_operation_id; p.purpose = challenge->key_purpose;
        if (p.throws) throw std::runtime_error("synthetic provider failure");
        if (p.hold) { p.accepted.set_value(); return; }
        const uint8_t nonnull_empty = 0;
        p.response = p.auth->respond(p.id, p.cancelled ? citizensdk_bytes_view_t{nullptr, 0}
            : citizensdk_bytes_view_t{p.bytes.empty() ? &nonnull_empty : p.bytes.data(),
                                     static_cast<uint64_t>(p.bytes.size())});
        if (p.revoke) assert(p.auth->cancel(p.id) == CITIZENSDK_OK);
      },
      +[](void *context, uint64_t id) {
        auto &p = *static_cast<Provider *>(context);
        assert(id == p.id); ++p.cancellations;
      },
      +[](void *context) { ++static_cast<Provider *>(context)->references; },
      +[](void *context) { --static_cast<Provider *>(context)->references; },
      +[](void *context) -> uint8_t {
        return static_cast<Provider *>(context)->provider_idle ? 1 : 0;
      }};
  auto malformed = binding;
  malformed.cancel = nullptr;
  assert(auth.configure(&malformed) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  assert(!auth.available());
  assert(auth.configure(&binding) == CITIZENSDK_OK && auth.available());
  assert(provider.references == 1);
  auto created = auth.create_vault_password(41);
  assert(provider.id == 41 && provider.purpose == 1);
  assert(created.code == CITIZENSDK_OK && created.password.size() == 12);
  provider.bytes[0] = 'b';
  assert(created.password.data()[0] == 'a'); // 回调返回后独立持有可擦除副本。
  created.password.clear();
  assert(auth.respond(41, {provider.bytes.data(), 12}) == CITIZENSDK_ERROR_INVALID_STATE);
  provider.bytes.assign(1024, 'a');
  auto unlocked = auth.unlock_vault_password(42);
  assert(provider.id == 42 && provider.purpose == 2);
  assert(unlocked.code == CITIZENSDK_OK && unlocked.password.size() == 1024);
  unlocked.password.clear();
  for (const auto length : {0, 11, 1025}) {
    provider.bytes.assign(static_cast<std::size_t>(length), 'a');
    provider.bytes.reserve(1); // 非NULL空输入不能冒充null取消。
    const auto invalid = auth.unlock_vault_password(43);
    assert(invalid.code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
    assert(provider.response == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  }
  provider.bytes.assign(12, 'a');
  provider.bytes[2] = 0xc0;
  assert(auth.unlock_vault_password(44).code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  provider.bytes[2] = 0;
  assert(auth.unlock_vault_password(45).code == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  provider.bytes[2] = 'a';
  provider.cancelled = true;
  assert(auth.unlock_vault_password(46).code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
  provider.cancelled = false;
  provider.revoke = true;
  auto revoked = auth.unlock_vault_password(47);
  assert(revoked.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED && revoked.password.empty());
  provider.revoke = false;
  provider.throws = true;
  assert(auth.unlock_vault_password(48).code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED);
  provider.throws = false;
  // Host隔离、真实请求号、取消和迟到回包不以UI是否显示为判断依据。
  provider.hold = true;
  auto accepted = provider.accepted.get_future();
  auto pending = std::async(std::launch::async, [&] { return auth.unlock_vault_password(49); });
  assert(accepted.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  assert(!auth.idle());
  assert(auth.configure(nullptr) == CITIZENSDK_ERROR_BUSY);
  assert(auth.unlock_vault_password(49).code == CITIZENSDK_ERROR_CONFLICT);
  UserAuth other;
  assert(other.respond(49, {provider.bytes.data(), 12}) == CITIZENSDK_ERROR_INVALID_STATE);
  auth.cancel_all();
  assert(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  auto stopped = pending.get();
  assert(stopped.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED && stopped.password.empty());
  assert(auth.respond(49, {provider.bytes.data(), 12}) == CITIZENSDK_ERROR_INVALID_STATE);
  assert(auth.idle() && provider.cancellations == 3);
  provider.provider_idle = false;
  assert(!auth.idle()); // 已取消Core等待，不等于提供者异步资源排空。
  assert(auth.configure(nullptr) == CITIZENSDK_ERROR_BUSY);
  provider.provider_idle = true;
  assert(auth.configure(nullptr) == CITIZENSDK_OK && !auth.available());
  assert(provider.references == 0);
}
}  // namespace

int main() {
  headless_credential_contract();
  using namespace citizen_sdk::linux;

  citizen_sdk::linux::test::TempDirectory temporary("secret-vault");
  const auto directory = temporary.path() / "state";
  {
    SecureStore store(directory);
    SecretVault vault(store);
    const auto availability = vault.availability();
    assert(availability == CITIZENSDK_HOST_VAULT_AVAILABLE ||
           availability ==
               CITIZENSDK_HOST_VAULT_NO_STRONG_USER_AUTHENTICATION ||
           availability == CITIZENSDK_HOST_VAULT_UNSUPPORTED ||
           availability == CITIZENSDK_HOST_VAULT_UNAVAILABLE);

    WalletKey invalid{};
    invalid.wallet_index = 1;
    std::array<uint8_t, 16> operation{};
    operation[0] = 1;
    bool wrong_wallet_rejected = false;
    try {
      vault.ensure_wallet_kek(1, invalid, operation);
    } catch (const HostError &error) {
      wrong_wallet_rejected =
          error.code() == CITIZENSDK_ERROR_INVALID_ARGUMENT;
    }
    assert(wrong_wallet_rejected);

    WalletKey missing{};
    missing.generation[0] = 2;
    assert(!vault.has_wallet_kek(missing));
    std::array<uint8_t, 32> output{};
    output.fill(0xa5);
    // 缺钥封装不得初始化generation；退休后同样不可复活。
    auto reject_wrap = [&] {
      bool rejected = false;
      try { (void)vault.wrap_dek(8, missing, operation, output.data()); }
      catch (const HostError &error) { rejected = error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED; }
      assert(rejected);
    };
    reject_wrap();
    bool add_rejected = false;
    try { vault.authorize_add_accounts(10, missing, operation); }
    catch (const HostError &error) { add_rejected = error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED; }
    assert(add_rejected && vault.idle());
    assert(!store.is_generation_active(missing));
    bool missing_rejected = false;
    try {
      vault.unwrap_dek(9, missing, Bytes{1, 2}, output.data());
    } catch (const HostError &error) {
      missing_rejected = error.code() == CITIZENSDK_ERROR_KEY_INVALIDATED;
    }
    assert(missing_rejected);
    assert(std::all_of(output.begin(), output.end(),
                       [](uint8_t byte) { return byte == 0; }));
    assert(vault.idle());

    vault.retire_wallet_kek(missing, operation);
    assert(!vault.has_wallet_kek(missing));
    assert(!store.ensure_generation(missing, operation));
    reject_wrap();
  }

  const std::string source_path =
      std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_secret_vault.cc";
  std::ifstream stream(source_path, std::ios::binary);
  assert(stream.good());
  const std::string source((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
  const auto provision = source.find("SecretVault::ensure_wallet_kek");
  const auto provision_lock = source.find("generation_lock_", provision);
  const auto generation_admission =
      source.find("secure_store_.ensure_generation", provision_lock);
  const auto conditional_insert =
      source.find("secure_store_.store_vault_object_if_owned", provision);
  const auto unwrap = source.find("SecretVault::unwrap_dek");
  const auto unwrap_lock = source.find("generation_lock_", unwrap);
  const auto prompt =
      source.find("user_auth_.unlock_vault_password(host_operation_id)", unwrap_lock);
  const auto post_prompt_check =
      source.find("secure_store_.vault_object_is_active(key, *object)", prompt);
  const auto decrypt = source.find("tpm_.decrypt_dek", post_prompt_check);
  const auto post_decrypt_check =
      source.find("secure_store_.vault_object_is_active(key, *object)",
                  decrypt);
  const auto clear_after_retire =
      source.find("secure_zero(plaintext_dek_out, 32)", post_decrypt_check);
  const auto retire = source.find("SecretVault::retire_wallet_kek");
  const auto retire_lock = source.find("generation_lock_", retire);
  const auto tombstone =
      source.find("secure_store_.retire_generation", retire_lock);
  const auto physical_delete =
      source.find("secure_store_.delete_vault_object", tombstone);
  assert(provision != std::string::npos &&
         provision_lock != std::string::npos &&
         generation_admission != std::string::npos &&
         conditional_insert != std::string::npos &&
         provision < provision_lock && provision_lock < generation_admission &&
         generation_admission < conditional_insert);
  assert(unwrap != std::string::npos && unwrap_lock != std::string::npos &&
         prompt != std::string::npos && post_prompt_check != std::string::npos &&
         decrypt != std::string::npos &&
         post_decrypt_check != std::string::npos &&
         clear_after_retire != std::string::npos && unwrap < unwrap_lock &&
         unwrap_lock < prompt && prompt < post_prompt_check &&
         post_prompt_check < decrypt && decrypt < post_decrypt_check &&
         post_decrypt_check < clear_after_retire);
  assert(retire != std::string::npos && retire_lock != std::string::npos &&
         tombstone != std::string::npos && physical_delete != std::string::npos &&
         retire < retire_lock && retire_lock < tombstone &&
         tombstone < physical_delete);

  const std::string bridge_path =
      std::string(CITIZENSDK_LINUX_TEST_SOURCE_DIR) +
      "/src/citizen_sdk_host_bridge.hpp";
  std::ifstream bridge_stream(bridge_path, std::ios::binary);
  assert(bridge_stream.good());
  const std::string bridge((std::istreambuf_iterator<char>(bridge_stream)),
                            std::istreambuf_iterator<char>());
  const auto service = bridge.find("auto service_call(Function function)");
  const auto lease = bridge.find("ServiceLease lease(*this)", service);
  const auto invoke = bridge.find("return function()", lease);
  assert(service != std::string::npos && lease != std::string::npos &&
         invoke != std::string::npos && service < lease && lease < invoke);
  assert(bridge.substr(service, invoke - service).find("lock_guard") ==
         std::string::npos);
  assert(bridge.find("host_.lifecycle_.begin_service()") != std::string::npos);
  assert(bridge.find("~ServiceLease() { host_.lifecycle_.finish_service(); }") !=
         std::string::npos);
  return 0;
}
