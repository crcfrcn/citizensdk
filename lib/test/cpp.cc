// 验证请求路由、Host operation 身份和同步早到 completion 的无损准入门。
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <condition_variable>
#include <fstream>
#include <iterator>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "input.hpp"
#include "operation.hpp"

#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

namespace {

constexpr std::size_t kConcurrentCompletions = 96;

void run_completion_wave(citizen_sdk::CompletionAdmission &admission) {
  std::mutex gate_lock;
  std::condition_variable gate_ready;
  std::size_t ready = 0;
  bool proceed = false;
  std::atomic<std::size_t> completed{0};
  std::vector<std::thread> workers;
  workers.reserve(kConcurrentCompletions);

  admission.begin();
  for (std::size_t index = 0; index < kConcurrentCompletions; ++index) {
    workers.emplace_back([&, index] {
      {
        std::unique_lock<std::mutex> guard(gate_lock);
        ++ready;
        gate_ready.notify_all();
        gate_ready.wait(guard, [&] { return proceed; });
      }
      const auto request = static_cast<citizensdk_request_id_t>(index + 1);
      admission.await_route(request);
      completed.fetch_add(1, std::memory_order_release);
    });
  }
  {
    std::unique_lock<std::mutex> guard(gate_lock);
    gate_ready.wait(guard, [&] { return ready == kConcurrentCompletions; });
    proceed = true;
  }
  gate_ready.notify_all();

  // begin() 尚未发布时，所有参与者已经抵达等待边界且无一能够完成。
  assert(completed.load(std::memory_order_acquire) == 0);
  admission.publish_route();
  for (auto &worker : workers)
    worker.join();
  assert(completed.load(std::memory_order_acquire) == kConcurrentCompletions);
  assert(admission.idle());
}

} // namespace

int routing() {
  using citizen_sdk::CompletionAdmission;
  using citizen_sdk::HostError;
  using citizen_sdk::OperationTracker;
  using citizen_sdk::RequestRouter;

  OperationTracker operations;
  assert(!operations.accept(0));
  assert(operations.accept(7));
  assert(!operations.accept(7));
  assert(!operations.empty());
  operations.finish(7);
  operations.finish(7);
  assert(operations.empty());

  // request 与 host operation 使用独立身份；错身份或另一认证的完成
  // 不能消耗当前认证租约，取消后的晚完成只退休它自身的真实操作。
  assert(operations.accept(71) && operations.accept(72));
  operations.finish(9);
  operations.finish(72);
  assert(!operations.empty());
  assert(!operations.accept(71));
  operations.finish(71);
  assert(operations.empty());

  RequestRouter router;
  int completions = 0;
  citizensdk_result_handle_t delivered = 0;
  router.prime([&](citizensdk_result_handle_t result) {
    ++completions;
    delivered = result;
  });
  bool duplicate_rejected = false;
  try {
    router.prime([](citizensdk_result_handle_t) {});
  } catch (const HostError &error) {
    duplicate_rejected = error.code() == CITIZENSDK_ERROR_CONFLICT;
  }
  assert(duplicate_rejected);

  citizensdk_event_t unrelated{};
  unrelated.event_type = CITIZENSDK_EVENT_CAPABILITIES_CHANGED;
  unrelated.request_id = 9;
  assert(!router.take(unrelated));
  assert(completions == 0);

  router.bind(9);
  citizensdk_event_t crossed{};
  crossed.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
  crossed.request_id = 10;
  crossed.result = 12;
  assert(!router.take(crossed));

  citizensdk_event_t completion{};
  completion.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
  completion.request_id = 9;
  completion.result = 11;
  auto handler = router.take(completion);
  assert(static_cast<bool>(handler));
  // 移交本身必须清空路由，不能等 callback 执行或局部 handler 析构才释放。
  assert(router.empty());
  handler(completion.result);
  assert(!router.take(completion));
  assert(completions == 1);
  assert(delivered == 11);
  assert(router.empty());
  router.prime([](citizensdk_result_handle_t) {});
  router.cancel_primed();
  assert(router.empty());

  // 回调重入可立即提交下一请求；旧 completion 不能消费新路由。
  router.prime([&](citizensdk_result_handle_t result) {
    assert(router.empty());
    ++completions;
    delivered = result;
    router.prime([&](citizensdk_result_handle_t next_result) {
      assert(router.empty());
      ++completions;
      delivered = next_result;
    });
    router.bind(11);
  });
  router.bind(10);
  auto second = router.take(crossed);
  assert(static_cast<bool>(second) && router.empty());
  second(crossed.result);
  assert(completions == 2 && delivered == 12);
  assert(!router.empty());
  assert(!router.take(completion) && !router.take(crossed));
  citizensdk_event_t next = completion;
  next.request_id = 11;
  next.result = 13;
  auto third = router.take(next);
  assert(static_cast<bool>(third) && router.empty());
  third(next.result);
  assert(completions == 3 && delivered == 13);
  assert(!router.take(next) && router.empty());

  // 无UI资源不能共用一个旧窗口槽：多请求乱序结束仍逐个移交，失败预约不清旧请求。
  int resource_completions = 0;
  for (uint64_t id = 100; id < 196; ++id) {
    router.prime([&, id](citizensdk_result_handle_t result) {
      assert(result == id + 1000);
      ++resource_completions;
    });
    router.bind(id);
  }
  router.prime([](citizensdk_result_handle_t) {});
  router.cancel_primed();
  assert(!router.empty());
  for (uint64_t id = 196; id-- > 100;) {
    citizensdk_event_t event{};
    event.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
    event.request_id = id;
    event.result = id + 1000;
    auto owned = router.take(event);
    assert(static_cast<bool>(owned));
    assert(!router.take(event));
    owned(event.result);
  }
  assert(resource_completions == 96 && router.empty());

  // 关闭发取消但不能伪造完成；取消回调允许重入只读状态，证明不持有路由锁。
  int cancellations = 0;
  router.prime([](citizensdk_result_handle_t) {},
               [&] {
                 ++cancellations;
                 assert(!router.empty());
               });
  router.bind(300);
  router.cancel_all();
  assert(cancellations == 1 && !router.empty());
  citizensdk_event_t cancelled{};
  cancelled.event_type = CITIZENSDK_EVENT_REQUEST_COMPLETED;
  cancelled.request_id = 300;
  auto cancellation_terminal = router.take(cancelled);
  assert(static_cast<bool>(cancellation_terminal) && router.empty());
  router.cancel_all();
  assert(cancellations == 1);

  // 96 个并发等待者明确超过旧固定 64 槽边界。准入门不缓存 result，
  // route 发布后每个 completion 都继续，且门可回到完整 idle 状态。
  CompletionAdmission admission;
  assert(admission.idle());
  run_completion_wave(admission);

  return 0;
}

// 验证平台敏感缓冲区不可复制、移动后单一所有权并可显式清零。
#include <array>
#include <cassert>
#include <type_traits>
#include <utility>

#include "secret.hpp"

#ifdef NDEBUG
#error "CitizenSDK Linux contract assertions must remain enabled"
#endif

int sensitive() {
  using citizen_sdk::secure_zero;
  using citizen_sdk::SensitiveBuffer;

  static_assert(!std::is_copy_constructible_v<SensitiveBuffer>);
  static_assert(!std::is_copy_assignable_v<SensitiveBuffer>);
  static_assert(std::is_nothrow_move_constructible_v<SensitiveBuffer>);
  static_assert(std::is_nothrow_move_assignable_v<SensitiveBuffer>);

  std::array<uint8_t, 32> bytes{};
  bytes.fill(0xa5);
  SensitiveBuffer first(bytes.data(), bytes.size());
  assert(first.size() == bytes.size());
  assert(first.data()[0] == 0xa5);

  SensitiveBuffer second(std::move(first));
  assert(first.empty());
  assert(second.size() == bytes.size());
  second.clear();
  assert(second.empty());

  secure_zero(bytes.data(), bytes.size());
  for (const auto byte : bytes)
    assert(byte == 0);
  return 0;
}

#include "sqlite.hpp"
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <random>
#include <stdexcept>

// 三处测试入口共用工作根读取；Windows副本由RAII释放，缺失或空值均失败。
std::string work() {
#if defined(_WIN32)
  char *copy = nullptr;
  const auto code = _dupenv_s(&copy, nullptr, "CITIZENSDK_TEST_WORK_DIR");
  const std::unique_ptr<char, decltype(&std::free)> owned(copy, &std::free);
  if (code != 0)
    throw std::runtime_error("CitizenSDK test work root read failed");
  const char *value = owned.get();
#else
  const char *value = std::getenv("CITIZENSDK_TEST_WORK_DIR");
#endif
  if (value == nullptr || *value == '\0')
    throw std::runtime_error("CitizenSDK test work root is required");
  return value;
}

// 实际SQLite验证共享资源适配，不模拟任何生产文件安全/VFS结论。
class Connection final {
public:
  Connection(const std::filesystem::path &directory, const char *name) {
    std::filesystem::create_directory(directory);
    const auto file = (directory / name).u8string();
    assert(sqlite3_open(file.c_str(), &db_) == SQLITE_OK);
  }
  ~Connection() { close(); }
  void close() {
    if (db_) {
      assert(sqlite3_close(db_) == SQLITE_OK);
      db_ = nullptr;
    }
  }
  template <class F>
  auto run(F f) -> decltype(f(static_cast<sqlite3 *>(nullptr))) {
    return f(db_);
  }
  void check() { assert(db_); }

private:
  sqlite3 *db_{};
};
struct ResourceTest {
  citizensdk_store_v1_t config;
  int64_t value{-1};
};
citizensdk_bytes_view_t sql(const char *value) {
  return {reinterpret_cast<const uint8_t *>(value), std::strlen(value)};
}
citizensdk_error_code_t row(void *context, const citizensdk_sql_value_t *cells,
                            uint64_t count) {
  assert(count == 1 && cells && cells[0].kind == 1);
  static_cast<ResourceTest *>(context)->value = cells[0].integer;
  return 0;
}
citizensdk_error_code_t resource_job(void *context) {
  auto &test = *static_cast<ResourceTest *>(context);
  const auto &db = test.config;
  uint64_t changes = 0;
  assert(db.execute(db.context, sql("CREATE TABLE resource(value INTEGER)"),
                    nullptr, 0, &changes) == 0);
  assert(db.begin(db.context) == 0);
  citizensdk_sql_value_t value{};
  value.kind = 1;
  value.integer = 17;
  assert(db.execute(db.context, sql("INSERT INTO resource VALUES(?)"), &value,
                    1, &changes) == 0);
  assert(db.end(db.context, 0) == 0);
  assert(db.query(db.context, sql("SELECT count(*) FROM resource"), nullptr, 0,
                  1, 1024, row, &test) == 0);
  assert(test.value == 0);
  assert(db.query(db.context, sql("SELECT 1"), nullptr, 0, 0, 1024, row,
                  &test) == CITIZENSDK_ERROR_STORAGE);
  assert(db.execute(db.context, sql("SELECT * FROM missing"), nullptr, 0,
                    &changes) == CITIZENSDK_ERROR_STORAGE);
  return 0;
}
citizensdk_error_code_t unfinished(void *context) {
  auto &db = static_cast<ResourceTest *>(context)->config;
  assert(db.begin(db.context) == 0);
  return CITIZENSDK_ERROR_STORAGE;
}
citizensdk_error_code_t forbidden(void *) {
  assert(false);
  return 0;
}
int resource() {
  const auto base = work();
  const auto directory = std::filesystem::u8path(base) /
                         ("cpp-" + std::to_string(std::random_device{}()));
  {
    citizen_sdk::Database<Connection, citizen_sdk::HostError> db(directory);
    ResourceTest test{db.config()};
    assert(!std::filesystem::exists(directory));
    assert(test.config.run(test.config.context, resource_job, &test) == 0);
    assert(test.config.run(test.config.context, unfinished, &test) ==
           CITIZENSDK_ERROR_STORAGE);
    assert(test.config.run(test.config.context, forbidden, nullptr) ==
           CITIZENSDK_ERROR_STORAGE);
  }
  std::filesystem::remove_all(directory);
  return 0;
}
int metadata() {
  const auto base = work();
  const auto directory = std::filesystem::u8path(base) /
                         ("vault-" + std::to_string(std::random_device{}()));
  {
    citizen_sdk::Database<Connection, citizen_sdk::HostError> db(directory,
                                                                 true);
    auto config = db.config();
    citizen_sdk::VaultStore store(config);
    citizen_sdk::WalletKey key{};
    key.generation.fill(7);
    std::array<uint8_t, 16> owner{};
    owner.fill(1);
    auto other = owner;
    other[0] = 2;
    assert(!store.is_generation_active(key));
    assert(store.ensure_generation(key, owner));
    assert(!store.ensure_generation(key, other));
    assert(store.generation_owned_by(key, owner));
    assert(store.vault_generations().size() == 1);
    store.retire_generation(key, other);
    assert(!store.is_generation_active(key));
    assert(!store.ensure_generation(key, owner));
    assert(store.vault_generations().size() == 1);
  }
  {
    citizen_sdk::Database<Connection, citizen_sdk::HostError> db(directory,
                                                                 true);
    citizen_sdk::VaultStore store(db.config());
    citizen_sdk::WalletKey key{};
    key.generation.fill(7);
    std::array<uint8_t, 16> owner{};
    owner.fill(1);
    assert(!store.ensure_generation(key, owner));
  }
  std::filesystem::remove_all(directory);
  return 0;
}
// 复用Windows所有者的同一平台无关状态合同，Apple/Linux不伪造WinBio API。
#define CITIZENSDK_WBF_STATE_ONLY
#include "../../windows/tests/citizen_sdk_user_auth_test.cc"
#undef CITIZENSDK_WBF_STATE_ONLY
int main() {
  return citizen_sdk::windows::UserAuthTest::ownership() || routing() ||
         sensitive() || resource() || metadata();
}

// Dart接入只替代本轮物理金库/等待点；SQL、钱包、签名、事件和取消全部执行正式Core。
namespace {
using FixtureKey = std::pair<uint32_t, std::array<uint8_t, 16>>;
FixtureKey fixture_key(citizensdk_host_wallet_key_ref_v1_t value) {
  FixtureKey key{value.wallet_index, {}};
  std::copy_n(value.generation.bytes, 16, key.second.begin());
  return key;
}
struct FixtureDek {
  FixtureKey key;
  std::array<uint8_t, 32> bytes{};
  ~FixtureDek() {
    volatile uint8_t *p = bytes.data();
    for (size_t i = 0; i < bytes.size(); ++i)
      p[i] = 0;
  }
};
struct FixtureStatus {
  uint64_t id;
  FixtureKey key;
  void *context;
  citizensdk_host_status_completion_v1_t complete;
};
struct FfiFixture {
  std::unique_ptr<citizen_sdk::Database<Connection, citizen_sdk::HostError>>
      secure;
  citizensdk_host_secret_vault_v1_t vault{};
  citizensdk_handle_t handle{};
  std::filesystem::path directory;
  std::mutex lock;
  int mode{};
  uint64_t next_wrap{1};
  std::set<FixtureKey> keys;
  std::map<std::vector<uint8_t>, std::unique_ptr<FixtureDek>> wrapped;
  std::optional<FixtureStatus> pending;
};
std::mutex ffi_fixture_lock;
std::map<uint64_t, std::unique_ptr<FfiFixture>> ffi_fixtures;
void fixture_event(void *, const citizensdk_event_t *event) {
  assert(event->result == 0);
}
void fixture_complete(uint64_t id, int32_t code, void *context,
                      citizensdk_host_status_completion_v1_t complete) {
  citizensdk_host_status_result_v1_t value{};
  value.struct_size = sizeof(value);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  value.host_operation_id = id;
  value.error_code = code;
  complete(context, &value);
}
int32_t fixture_availability(
    void *raw, uint64_t id, void *context,
    citizensdk_host_vault_availability_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  citizensdk_host_vault_availability_result_v1_t value{};
  value.struct_size = sizeof(value);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  value.host_operation_id = id;
  {
    std::lock_guard<std::mutex> g(f.lock);
    value.availability = f.mode ? CITIZENSDK_HOST_VAULT_AVAILABLE
                                : CITIZENSDK_HOST_VAULT_UNAVAILABLE;
  }
  complete(context, &value);
  return 0;
}
int32_t fixture_status(void *raw, uint64_t id,
                       citizensdk_host_wallet_key_ref_v1_t key,
                       citizensdk_host_id128_t, void *context,
                       citizensdk_host_status_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  {
    std::lock_guard<std::mutex> g(f.lock);
    if (f.mode == 0 || f.mode == 2)
      return CITIZENSDK_ERROR_UNAVAILABLE;
    if (f.mode == 3) {
      if (f.pending)
        return CITIZENSDK_ERROR_BUSY;
      f.pending = FixtureStatus{id, fixture_key(key), context, complete};
      return 0;
    }
    f.keys.insert(fixture_key(key));
  }
  fixture_complete(id, 0, context, complete);
  return 0;
}
int32_t fixture_has(void *raw, uint64_t id,
                    citizensdk_host_wallet_key_ref_v1_t key, void *context,
                    citizensdk_host_bool_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  citizensdk_host_bool_result_v1_t value{};
  value.struct_size = sizeof(value);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  value.host_operation_id = id;
  {
    std::lock_guard<std::mutex> g(f.lock);
    if (!f.mode)
      return CITIZENSDK_ERROR_UNAVAILABLE;
    value.value = f.keys.count(fixture_key(key)) ? 1 : 0;
  }
  complete(context, &value);
  return 0;
}
int32_t fixture_any(void *raw, uint64_t id, uint32_t index, void *context,
                    citizensdk_host_bool_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  citizensdk_host_bool_result_v1_t value{};
  value.struct_size = sizeof(value);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  value.host_operation_id = id;
  {
    std::lock_guard<std::mutex> g(f.lock);
    value.value =
        std::any_of(f.keys.begin(), f.keys.end(),
                    [index](const auto &key) { return key.first == index; })
            ? 1
            : 0;
  }
  complete(context, &value);
  return 0;
}
int32_t fixture_wrap(void *raw, uint64_t id,
                     citizensdk_host_wallet_key_ref_v1_t key,
                     citizensdk_host_id128_t, citizensdk_bytes_view_t plaintext,
                     void *context,
                     citizensdk_host_bytes_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  std::vector<uint8_t> token(8);
  {
    std::lock_guard<std::mutex> g(f.lock);
    if (!f.mode)
      return CITIZENSDK_ERROR_UNAVAILABLE;
    if (plaintext.len != 32 || !plaintext.data ||
        !f.keys.count(fixture_key(key)))
      return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    const auto number = f.next_wrap++;
    for (size_t i = 0; i < 8; ++i)
      token[i] = static_cast<uint8_t>(number >> (8 * i));
    auto value = std::make_unique<FixtureDek>();
    value->key = fixture_key(key);
    std::copy_n(plaintext.data, 32, value->bytes.begin());
    f.wrapped.emplace(token, std::move(value));
  }
  citizensdk_host_bytes_result_v1_t value{};
  value.struct_size = sizeof(value);
  value.abi_version = CITIZENSDK_ABI_VERSION;
  value.host_operation_id = id;
  value.kind = CITIZENSDK_HOST_BYTES_WRAPPED_DEK;
  value.bytes = {token.data(), token.size()};
  complete(context, &value);
  return 0;
}
int32_t fixture_unwrap(void *raw, uint64_t id,
                       citizensdk_host_wallet_key_ref_v1_t key,
                       citizensdk_bytes_view_t wrapped,
                       citizensdk_mutable_bytes_view_t output, void *context,
                       citizensdk_host_status_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  {
    std::lock_guard<std::mutex> g(f.lock);
    if (!f.mode)
      return CITIZENSDK_ERROR_UNAVAILABLE;
    if (!wrapped.data || wrapped.len != 8 || !output.data || output.len != 32)
      return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    const auto found =
        f.wrapped.find(std::vector<uint8_t>(wrapped.data, wrapped.data + 8));
    if (found == f.wrapped.end() || found->second->key != fixture_key(key))
      return CITIZENSDK_ERROR_KEY_INVALIDATED;
    std::copy_n(found->second->bytes.begin(), 32, output.data);
  }
  fixture_complete(id, 0, context, complete);
  return 0;
}
int32_t fixture_retire(void *raw, uint64_t id,
                       citizensdk_host_wallet_key_ref_v1_t key,
                       citizensdk_host_id128_t, void *context,
                       citizensdk_host_status_completion_v1_t complete) {
  auto &f = *static_cast<FfiFixture *>(raw);
  {
    std::lock_guard<std::mutex> g(f.lock);
    f.keys.erase(fixture_key(key));
    for (auto it = f.wrapped.begin(); it != f.wrapped.end();) {
      if (it->second->key == fixture_key(key))
        it = f.wrapped.erase(it);
      else
        ++it;
    }
  }
  fixture_complete(id, 0, context, complete);
  return 0;
}
} // namespace
#if defined(_WIN32)
#define CITIZENSDK_TEST_EXPORT __declspec(dllexport)
#else
#define CITIZENSDK_TEST_EXPORT __attribute__((visibility("default")))
#endif
extern "C" CITIZENSDK_TEST_EXPORT
    uint64_t citizensdk_test_open(uint32_t modules) {
  try {
    auto fixture = std::make_unique<FfiFixture>();
    const auto base = work();
    fixture->directory = std::filesystem::path(base) /
                         ("ffi-" + std::to_string(std::random_device{}()));
    citizensdk_stores_v1_t stores{};
    stores.struct_size = sizeof(stores);
    stores.abi_version = CITIZENSDK_ABI_VERSION;
    citizensdk_store_v1_t config{};
    if (modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING)) {
      fixture->secure = std::make_unique<
          citizen_sdk::Database<Connection, citizen_sdk::HostError>>(
          fixture->directory, true);
      config = fixture->secure->config();
      stores.secure_store = &config;
      fixture->vault = {sizeof(fixture->vault),
                        CITIZENSDK_ABI_VERSION,
                        fixture.get(),
                        fixture_availability,
                        fixture_status,
                        fixture_has,
                        fixture_wrap,
                        fixture_unwrap,
                        fixture_retire,
                        fixture_status,
                        fixture_any};
      stores.secret_vault = &fixture->vault;
    }
    citizensdk_create_options_t options{};
    options.struct_size = sizeof(options);
    options.abi_version = CITIZENSDK_ABI_VERSION;
    if (citizensdk_create(&options, modules, &stores, &fixture->handle))
      return 0;
    if (citizensdk_set_event_callback(fixture->handle, fixture_event,
                                      nullptr)) {
      citizensdk_destroy(fixture->handle);
      return 0;
    }
    const auto handle = fixture->handle;
    std::lock_guard<std::mutex> guard(ffi_fixture_lock);
    ffi_fixtures.emplace(handle, std::move(fixture));
    return handle;
  } catch (...) {
    return 0;
  }
}
extern "C" CITIZENSDK_TEST_EXPORT int32_t
citizensdk_test_close(uint64_t handle) {
  std::lock_guard<std::mutex> guard(ffi_fixture_lock);
  auto found = ffi_fixtures.find(handle);
  if (found == ffi_fixtures.end())
    return 2;
  auto code = citizensdk_set_event_callback(handle, nullptr, nullptr);
  if (code)
    return code;
  code = citizensdk_destroy(handle);
  if (code)
    return code;
  const auto directory = found->second->directory;
  ffi_fixtures.erase(found);
  std::filesystem::remove_all(directory);
  return 0;
}

// 模式只控制有限物理夹具：0不可用、1可用、2确保密钥失败、3确保密钥等待真实终态。
extern "C" CITIZENSDK_TEST_EXPORT int32_t citizensdk_test_vault(uint64_t handle,
                                                                int32_t mode) {
  std::lock_guard<std::mutex> guard(ffi_fixture_lock);
  auto found = ffi_fixtures.find(handle);
  if (found == ffi_fixtures.end() || mode < 0 || mode > 3)
    return 1;
  std::lock_guard<std::mutex> g(found->second->lock);
  found->second->mode = mode;
  return 0;
}
extern "C" CITIZENSDK_TEST_EXPORT int32_t
citizensdk_test_vault_pending(uint64_t handle) {
  std::lock_guard<std::mutex> guard(ffi_fixture_lock);
  auto found = ffi_fixtures.find(handle);
  if (found == ffi_fixtures.end())
    return 0;
  std::lock_guard<std::mutex> g(found->second->lock);
  return found->second->pending ? 1 : 0;
}
extern "C" CITIZENSDK_TEST_EXPORT int32_t
citizensdk_test_vault_complete(uint64_t handle, int32_t code) {
  std::lock_guard<std::mutex> guard(ffi_fixture_lock);
  auto found = ffi_fixtures.find(handle);
  if (found == ffi_fixtures.end())
    return 2;
  std::optional<FixtureStatus> pending;
  {
    auto &f = *found->second;
    std::lock_guard<std::mutex> g(f.lock);
    pending = std::move(f.pending);
    f.pending.reset();
    if (pending && code == 0)
      f.keys.insert(pending->key);
  }
  if (!pending)
    return 7;
  fixture_complete(pending->id, code, pending->context, pending->complete);
  return 0;
}
