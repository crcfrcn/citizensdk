/* 纯 C 安装消费者：只包含已安装 Host/Core 公开头，不借用 Host 内部 helper。 */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <citizen_sdk/citizensdk_host.h>

/* 仅从已安装公开头核对四项新增查询 ABI，不扩大 Host 门面职责。 */
_Static_assert(_Generic(&citizensdk_get_genesis_hash,
    citizensdk_error_code_t (*)(citizensdk_handle_t, uint8_t *): 1, default: 0),
    "genesis query signature");
_Static_assert(_Generic(&citizensdk_get_finalized_account_balances,
    citizensdk_error_code_t (*)(citizensdk_handle_t, const citizensdk_account_id_t *,
                               uint32_t, citizensdk_request_id_t *): 1, default: 0),
    "batch balance query signature");
_Static_assert(_Generic(&citizensdk_result_get_account_balance_count,
    citizensdk_error_code_t (*)(citizensdk_result_handle_t, uint32_t *): 1, default: 0),
    "batch balance count signature");
_Static_assert(_Generic(&citizensdk_result_get_account_balance_at,
    citizensdk_error_code_t (*)(citizensdk_result_handle_t, uint32_t,
                               citizensdk_account_balance_info_t *): 1, default: 0),
    "batch balance element signature");
_Static_assert(_Generic(&citizensdk_private_key_open,
    citizensdk_error_code_t (*)(citizensdk_handle_t, const citizensdk_account_id_t *,
        const citizensdk_private_key_receiver_v1_t *, uint64_t *, citizensdk_request_id_t *): 1, default: 0),
    "private key uses an owned receiver, not a window");
_Static_assert(_Generic(&citizensdk_host_open_qr_capture,
    citizensdk_error_code_t (*)(citizensdk_host_handle_t, uint32_t,
        const citizensdk_qr_capture_callbacks_v1_t *, uint64_t *): 1, default: 0),
    "QR capture exposes data and lifetime callbacks");
_Static_assert(_Generic(&citizensdk_wallet_state_get_diagnostic_cleanup_account,
    citizensdk_error_code_t (*)(citizensdk_result_handle_t, uint32_t, uint32_t,
        citizensdk_account_id_t *): 1, default: 0), "diagnostic cleanup targets are typed public accounts");
_Static_assert(CITIZENSDK_RESULT_ACCOUNT_BALANCES == 18, "batch balance result kind");

#ifdef NDEBUG
#error "CitizenSDK consumer checks must remain enabled in Release"
#endif

/* 不依赖 assert：即使更换调用器，验收判断也不能被优化为空。 */
#define CHECK(condition) do { if (!(condition)) { \
  fprintf(stderr, "CitizenSDK C consumer failed at line %d\n", __LINE__); \
  abort(); \
} } while (0)

struct completion {
  pthread_mutex_t lock;
  pthread_cond_t changed;
  citizensdk_request_id_t request;
  citizensdk_result_handle_t result;
  citizensdk_result_info_t info;
  uint64_t last_sequence;
  unsigned count;
};

static citizensdk_bytes_view_t view(const char *value) {
  citizensdk_bytes_view_t result = {(const uint8_t *)value, (uint64_t)strlen(value)};
  return result;
}

static void check_root(const char *path, const char *application_id) {
  CHECK(path != NULL && path[0] == '/' && path[1] != '\0');
  char *copy = strdup(path);
  CHECK(copy != NULL);
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  CHECK(current >= 0);
  char *state = NULL;
  for (char *part = strtok_r(copy, "/", &state); part != NULL;
       part = strtok_r(NULL, "/", &state)) {
    CHECK(strcmp(part, ".") != 0 && strcmp(part, "..") != 0);
    const int next = openat(current, part,
                            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    CHECK(next >= 0);
    CHECK(close(current) == 0);
    current = next;
  }
  struct stat status;
  CHECK(fstat(current, &status) == 0 && S_ISDIR(status.st_mode));
  CHECK(status.st_uid == geteuid() && (status.st_mode & 07777) == 0700);
  /* 独占空数据空间防止误读真实账户；不删除任何已有目录。 */
  CHECK(fstatat(current, application_id, &status, AT_SYMLINK_NOFOLLOW) == -1);
  CHECK(errno == ENOENT);
  CHECK(close(current) == 0);
  free(copy);
}

static void receive(void *context, const citizensdk_event_t *event) {
  struct completion *completion = (struct completion *)context;
  CHECK(event != NULL && event->struct_size >= sizeof(*event));
  CHECK(event->abi_version == CITIZENSDK_ABI_VERSION);
  CHECK(pthread_mutex_lock(&completion->lock) == 0);
  CHECK(event->sequence > completion->last_sequence);
  completion->last_sequence = event->sequence;
  if (event->event_type == CITIZENSDK_EVENT_REQUEST_COMPLETED) {
    CHECK(completion->count == 0 && event->request_id != 0 && event->result != 0);
    completion->info.struct_size = sizeof(completion->info);
    completion->info.abi_version = CITIZENSDK_ABI_VERSION;
    CHECK(citizensdk_result_get_info(event->result, &completion->info) == CITIZENSDK_OK);
    completion->request = event->request_id;
    /* C 回调拥有结果；保留至主线程验证 BUSY，再由主线程恰好释放一次。
     * 不保存借用 event 指针，也不在回调中同步操作 Host/Core 生命周期。 */
    completion->result = event->result;
    ++completion->count;
    CHECK(pthread_cond_broadcast(&completion->changed) == 0);
  } else {
    CHECK(event->result == 0);
  }
  CHECK(pthread_mutex_unlock(&completion->lock) == 0);
}

static void check_capabilities(citizensdk_handle_t sdk) {
  citizensdk_capability_snapshot_t snapshot = {0};
  snapshot.struct_size = sizeof(snapshot);
  snapshot.abi_version = CITIZENSDK_ABI_VERSION;
  CHECK(citizensdk_get_capabilities(sdk, &snapshot) == CITIZENSDK_OK);
  CHECK(snapshot.count == CITIZENSDK_CAPABILITY_COUNT);
  uint32_t names = 0;
  for (uint32_t index = 0; index < snapshot.count; ++index) {
    const citizensdk_capability_status_t *status = &snapshot.statuses[index];
    CHECK(status->name >= 1 && status->name <= CITIZENSDK_CAPABILITY_COUNT);
    const uint32_t bit = UINT32_C(1) << (status->name - 1);
    CHECK((names & bit) == 0);
    names |= bit;
    CHECK(status->supported <= 1 && status->available <= 1 &&
          status->enabled <= 1 && status->ready <= 1);
    CHECK(status->reason <= CITIZENSDK_CAPABILITY_REASON_STORAGE_UNAVAILABLE);
    CHECK(!status->ready || (status->supported && status->available &&
          status->enabled && status->reason == CITIZENSDK_CAPABILITY_REASON_NONE));
    if (status->name == CITIZENSDK_CAPABILITY_CHAIN_READ) CHECK(!status->ready);
    if (status->name == CITIZENSDK_CAPABILITY_HARDWARE_VAULT ||
        status->name == CITIZENSDK_CAPABILITY_LOCAL_SIGNING) CHECK(!status->ready);
  }
  CHECK(names == (UINT32_C(1) << CITIZENSDK_CAPABILITY_COUNT) - 1);
}

int main(int argc, char **argv) {
  CHECK(argc == 3);
  const char *application_id = "org.citizensdk.cconsumer";
  check_root(argv[1], application_id);
  CHECK(argv[2][0] == '/');
  CHECK(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
  CHECK(citizensdk_host_abi_version() == CITIZENSDK_HOST_ABI_VERSION);
  CHECK(citizensdk_create_options_size() == sizeof(citizensdk_create_options_t));
  CHECK(citizensdk_host_config_size() == sizeof(citizensdk_host_config_v1_t));
  citizensdk_host_handle_t host = 99;
  CHECK(citizensdk_host_create(NULL, &host) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  CHECK(host == 0);
  uint64_t error_size = 0;
  CHECK(citizensdk_host_last_error_copy(NULL, 0, &error_size) == CITIZENSDK_OK);
  CHECK(error_size > 0);  /* 只校验诊断长度，不输出错误正文或持久化机密。 */

  citizensdk_host_config_v1_t config = {0};
  config.struct_size = sizeof(config);
  config.abi_version = CITIZENSDK_HOST_ABI_VERSION;
  config.storage_root_utf8 = view(argv[1]);
  config.asset_root_utf8 = view(argv[2]);
  config.application_id_utf8 = view(application_id);
  config.enable_wallet = 0;  /* 链消费者不需要 TPM，也不建立钱包。 */
  config.reserved[0] = 1;
  CHECK(citizensdk_host_create(&config, &host) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  CHECK(host == 0);
  config.reserved[0] = 0;
  CHECK(citizensdk_host_create(&config, &host) == CITIZENSDK_OK && host != 0);
  citizensdk_handle_t sdk = 99;
  CHECK(citizensdk_host_sdk(host, &sdk) == CITIZENSDK_ERROR_NOT_READY && sdk == 0);
  citizensdk_host_vault_availability_t vault = 0;
  CHECK(citizensdk_host_vault_availability(host, &vault) == CITIZENSDK_OK);
  CHECK(vault == CITIZENSDK_HOST_VAULT_UNSUPPORTED);
  CHECK(citizensdk_host_create_sdk(host, &sdk) == CITIZENSDK_OK && sdk != 0);
  citizensdk_handle_t borrowed = 0;
  CHECK(citizensdk_host_sdk(host, &borrowed) == CITIZENSDK_OK && borrowed == sdk);
  citizensdk_lifecycle_t lifecycle = 0;
  /* Created 即可读取固定创世身份；前后哨兵验证输出恰为 32 字节。 */
  uint8_t genesis_hash[34] = {0};
  genesis_hash[0] = genesis_hash[33] = UINT8_C(0x5a);
  CHECK(citizensdk_get_genesis_hash(sdk, genesis_hash + 1) == CITIZENSDK_OK);
  CHECK(genesis_hash[0] == UINT8_C(0x5a) && genesis_hash[33] == UINT8_C(0x5a));
  unsigned genesis_nonzero = 0;
  for (unsigned index = 1; index <= 32; ++index) genesis_nonzero |= genesis_hash[index];
  CHECK(genesis_nonzero != 0);
  CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
  CHECK(lifecycle == CITIZENSDK_LIFECYCLE_CREATED);
  check_capabilities(sdk);

  struct completion completion = {0};
  CHECK(pthread_mutex_init(&completion.lock, NULL) == 0);
  pthread_condattr_t attributes;
  CHECK(pthread_condattr_init(&attributes) == 0);
  CHECK(pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) == 0);
  CHECK(pthread_cond_init(&completion.changed, &attributes) == 0);
  CHECK(pthread_condattr_destroy(&attributes) == 0);
  CHECK(citizensdk_host_set_event_callback(host, receive, &completion) == CITIZENSDK_OK);
  citizensdk_request_id_t request = 0;
  /* 先安置拥有回调的状态，再接受请求，允许 completion 早于 request 返回。 */
  CHECK(citizensdk_refresh_capabilities(sdk, &request) == CITIZENSDK_OK && request != 0);
  struct timespec deadline;
  CHECK(clock_gettime(CLOCK_MONOTONIC, &deadline) == 0);
  deadline.tv_sec += 30;
  CHECK(pthread_mutex_lock(&completion.lock) == 0);
  while (completion.count == 0) {
    CHECK(pthread_cond_timedwait(&completion.changed, &completion.lock, &deadline) == 0);
  }
  CHECK(completion.count == 1 && completion.request == request);
  CHECK(completion.info.error_code == CITIZENSDK_OK &&
        completion.info.kind == CITIZENSDK_RESULT_EMPTY);
  const citizensdk_result_handle_t result = completion.result;
  CHECK(pthread_mutex_unlock(&completion.lock) == 0);

  CHECK(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_BUSY);
  /* 首次 close 可能已开始单调收口；此后只释放结果并重试 destroy，
   * 不再注册 callback、发请求或把 teardown-only 句柄当可用会话。 */
  CHECK(citizensdk_result_release(result) == CITIZENSDK_OK);
  CHECK(citizensdk_result_release(result) == CITIZENSDK_ERROR_INVALID_HANDLE);
  citizensdk_error_code_t closed = CITIZENSDK_ERROR_BUSY;
  const struct timespec pause = {0, 1000000};
  for (unsigned attempt = 0; attempt < 5000 && closed == CITIZENSDK_ERROR_BUSY; ++attempt) {
    closed = citizensdk_host_destroy(host);
    if (closed == CITIZENSDK_ERROR_BUSY) (void)nanosleep(&pause, NULL);
  }
  CHECK(closed == CITIZENSDK_OK);
  CHECK(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_INVALID_HANDLE);
  CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_ERROR_INVALID_HANDLE);
  CHECK(completion.count == 1);
  CHECK(pthread_cond_destroy(&completion.changed) == 0);
  CHECK(pthread_mutex_destroy(&completion.lock) == 0);
  puts("CitizenSDK C consumer passed");
  return 0;
}
