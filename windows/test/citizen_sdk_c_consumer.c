/* 沿用 Linux 已安装消费者的公开生命周期合同，路径/等待改用 Windows API。
 * 纯 C 消费者只包含安装后的公开 Host/Core 头，不借用私有 helper。 */
#include <windows.h>
#include <strsafe.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

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

/* 不依赖 assert，Release 验收不能被预处理器静默删掉。 */
#define CHECK(condition) do { if (!(condition)) { \
  fprintf(stderr, "CitizenSDK C consumer failed at line %d\n", __LINE__); \
  abort(); \
} } while (0)

typedef struct completion {
  SRWLOCK lock;
  CONDITION_VARIABLE changed;
  citizensdk_request_id_t request;
  citizensdk_result_handle_t result;
  citizensdk_result_info_t info;
  uint64_t last_sequence;
  unsigned count;
} completion_t;

static citizensdk_bytes_view_t view(const char *value) {
  citizensdk_bytes_view_t result = {
      (const uint8_t *)value, (uint64_t)strlen(value)};
  return result;
}

static char *utf8(const wchar_t *value) {
  CHECK(value != NULL);
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
                                            -1, NULL, 0, NULL, NULL);
  CHECK(required > 1);
  char *result = (char *)malloc((size_t)required);
  CHECK(result != NULL);
  CHECK(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result,
                            required, NULL, NULL) == required);
  return result;
}

static void check_fresh_namespace(const wchar_t *root,
                                  const wchar_t *application_id) {
  CHECK(root != NULL && application_id != NULL && root[0] != L'\0');
  const size_t root_len = wcslen(root);
  const size_t app_len = wcslen(application_id);
  CHECK(root_len < 32700 && app_len != 0 && app_len < 128);
  wchar_t *path = (wchar_t *)malloc((root_len + app_len + 2) * sizeof(wchar_t));
  CHECK(path != NULL);
  memcpy(path, root, root_len * sizeof(wchar_t));
  size_t length = root_len;
  if (length != 0 && path[length - 1] != L'\\' && path[length - 1] != L'/') {
    path[length++] = L'\\';
  }
  memcpy(path + length, application_id, (app_len + 1) * sizeof(wchar_t));
  SetLastError(ERROR_SUCCESS);
  CHECK(GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES);
  const DWORD missing = GetLastError();
  CHECK(missing == ERROR_FILE_NOT_FOUND || missing == ERROR_PATH_NOT_FOUND);
  free(path);
  /* 真正的目录创建、SID、DACL、FileId 与 no-reparse 验证仍完全由公开 Host 完成。 */
}

static void full_path(const wchar_t *input, wchar_t *output, DWORD capacity) {
  CHECK(input != NULL && output != NULL && capacity > 1);
  const DWORD length = GetFullPathNameW(input, capacity, output, NULL);
  CHECK(length != 0 && length < capacity);
}

static void check_loaded_dll(const wchar_t *runtime, const wchar_t *name) {
  const HMODULE module = GetModuleHandleW(name);
  CHECK(module != NULL);
  wchar_t actual[32768];
  const DWORD actual_len = GetModuleFileNameW(module, actual, ARRAYSIZE(actual));
  CHECK(actual_len != 0 && actual_len < ARRAYSIZE(actual));
  wchar_t expected_input[32768];
  CHECK(SUCCEEDED(StringCchPrintfW(expected_input, ARRAYSIZE(expected_input),
                                   L"%ls\\%ls", runtime, name)));
  wchar_t expected[32768];
  full_path(expected_input, expected, ARRAYSIZE(expected));
  CHECK(CompareStringOrdinal(actual, -1, expected, -1, TRUE) == CSTR_EQUAL);
}

static void receive(void *context, const citizensdk_event_t *event) {
  completion_t *completion = (completion_t *)context;
  CHECK(completion != NULL && event != NULL && event->struct_size >= sizeof(*event));
  CHECK(event->abi_version == CITIZENSDK_ABI_VERSION);
  AcquireSRWLockExclusive(&completion->lock);
  CHECK(event->sequence > completion->last_sequence);
  completion->last_sequence = event->sequence;
  if (event->event_type == CITIZENSDK_EVENT_REQUEST_COMPLETED) {
    CHECK(completion->count == 0 && event->request_id != 0 && event->result != 0);
    completion->info.struct_size = sizeof(completion->info);
    completion->info.abi_version = CITIZENSDK_ABI_VERSION;
    CHECK(citizensdk_result_get_info(event->result, &completion->info) == CITIZENSDK_OK);
    completion->request = event->request_id;
    /* C 回调把结果所有权交给主线程；不保存借用 event，也不读取错误正文。 */
    completion->result = event->result;
    ++completion->count;
    WakeAllConditionVariable(&completion->changed);
  } else {
    CHECK(event->result == 0);
  }
  ReleaseSRWLockExclusive(&completion->lock);
}

static void prepare(completion_t *completion) {
  AcquireSRWLockExclusive(&completion->lock);
  completion->request = 0;
  completion->result = 0;
  memset(&completion->info, 0, sizeof(completion->info));
  completion->count = 0;
  ReleaseSRWLockExclusive(&completion->lock);
}

static citizensdk_request_id_t accept_request(
    citizensdk_handle_t sdk,
    citizensdk_error_code_t (*operation)(citizensdk_handle_t,
                                         citizensdk_request_id_t *)) {
  const ULONGLONG deadline = GetTickCount64() + UINT64_C(10000);
  for (;;) {
    citizensdk_request_id_t request = 0;
    const citizensdk_error_code_t code = operation(sdk, &request);
    if (code == CITIZENSDK_OK) {
      CHECK(request != 0);
      return request;
    }
    /* 上一个回调已通知但尚未返回时，独占请求可短暂 BUSY；失败不得分配 ID。 */
    CHECK(code == CITIZENSDK_ERROR_BUSY && request == 0 && GetTickCount64() < deadline);
    Sleep(1);
  }
}

static citizensdk_result_handle_t await_result(
    completion_t *completion, citizensdk_request_id_t request,
    citizensdk_error_code_t expected_error) {
  const ULONGLONG deadline = GetTickCount64() + UINT64_C(60000);
  AcquireSRWLockExclusive(&completion->lock);
  while (completion->count == 0) {
    const ULONGLONG now = GetTickCount64();
    CHECK(now < deadline);
    const ULONGLONG remaining = deadline - now;
    const DWORD timeout = remaining > UINT32_MAX ? UINT32_MAX : (DWORD)remaining;
    CHECK(SleepConditionVariableSRW(&completion->changed, &completion->lock,
                                    timeout, 0));
  }
  CHECK(completion->count == 1 && completion->request == request);
  CHECK(completion->info.error_code == expected_error);
  if (expected_error == CITIZENSDK_OK) {
    CHECK(completion->info.kind == CITIZENSDK_RESULT_EMPTY);
  }
  const citizensdk_result_handle_t result = completion->result;
  ReleaseSRWLockExclusive(&completion->lock);
  return result;
}

static void release_result(citizensdk_result_handle_t result) {
  CHECK(result != 0 && citizensdk_result_release(result) == CITIZENSDK_OK);
  CHECK(citizensdk_result_release(result) == CITIZENSDK_ERROR_INVALID_HANDLE);
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
    if (status->name == CITIZENSDK_CAPABILITY_HARDWARE_VAULT ||
        status->name == CITIZENSDK_CAPABILITY_LOCAL_SIGNING) CHECK(!status->ready);
  }
  CHECK(names == (UINT32_C(1) << CITIZENSDK_CAPABILITY_COUNT) - 1);
}

static citizensdk_error_code_t close_with_retry(citizensdk_host_handle_t host) {
  const ULONGLONG deadline = GetTickCount64() + UINT64_C(10000);
  citizensdk_error_code_t code = CITIZENSDK_ERROR_BUSY;
  while (code == CITIZENSDK_ERROR_BUSY && GetTickCount64() < deadline) {
    code = citizensdk_host_destroy(host);
    if (code == CITIZENSDK_ERROR_BUSY) Sleep(1);
  }
  return code;
}

int wmain(int argc, wchar_t **argv) {
  CHECK(argc == 4);
  const wchar_t *application_w = L"org.citizensdk.cconsumer";
  check_fresh_namespace(argv[1], application_w);
  check_loaded_dll(argv[3], L"citizensdk.dll");
  check_loaded_dll(argv[3], L"citizensdk_host.dll");
  char *storage = utf8(argv[1]);
  char *assets = utf8(argv[2]);
  const char *application = "org.citizensdk.cconsumer";

  CHECK(citizensdk_abi_version() == CITIZENSDK_ABI_VERSION);
  CHECK(citizensdk_host_abi_version() == CITIZENSDK_HOST_ABI_VERSION);
  CHECK(citizensdk_create_options_size() == sizeof(citizensdk_create_options_t));
  CHECK(citizensdk_host_config_size() == sizeof(citizensdk_host_config_v1_t));
  citizensdk_host_handle_t host = 99;
  CHECK(citizensdk_host_create(NULL, &host) == CITIZENSDK_ERROR_INVALID_ARGUMENT);
  CHECK(host == 0);
  uint64_t diagnostic_size = 0;
  CHECK(citizensdk_host_last_error_copy(NULL, 0, &diagnostic_size) == CITIZENSDK_OK);
  CHECK(diagnostic_size > 0);  /* 只看长度，不记录可能包含环境信息的诊断正文。 */

  citizensdk_host_config_v1_t config = {0};
  config.struct_size = sizeof(config);
  config.abi_version = CITIZENSDK_HOST_ABI_VERSION;
  config.storage_root_utf8 = view(storage);
  config.asset_root_utf8 = view(assets);
  config.application_id_utf8 = view(application);
  config.hwnd = NULL;
  config.enable_wallet = 0;
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

  completion_t completion = {SRWLOCK_INIT, CONDITION_VARIABLE_INIT, 0, 0, {0}, 0, 0};
  CHECK(citizensdk_host_set_event_callback(host, receive, &completion) == CITIZENSDK_OK);
  prepare(&completion);
  citizensdk_request_id_t request = accept_request(sdk, citizensdk_get_finalized_head);
  citizensdk_result_handle_t result =
      await_result(&completion, request, CITIZENSDK_ERROR_NOT_READY);
  release_result(result);

  prepare(&completion);
  request = accept_request(sdk, citizensdk_start);
  result = await_result(&completion, request, CITIZENSDK_OK);
  release_result(result);
  CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
  CHECK(lifecycle == CITIZENSDK_LIFECYCLE_RUNNING);
  check_capabilities(sdk);
  CHECK(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_BUSY);

  prepare(&completion);
  request = accept_request(sdk, citizensdk_stop);
  result = await_result(&completion, request, CITIZENSDK_OK);
  CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_OK);
  CHECK(lifecycle == CITIZENSDK_LIFECYCLE_STOPPED);
  /* Host-backed stop 的成功结果就是公开合同中的 durable checkpoint 完成点。 */
  CHECK(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_BUSY);
  release_result(result);
  CHECK(close_with_retry(host) == CITIZENSDK_OK);

  CHECK(citizensdk_host_destroy(host) == CITIZENSDK_ERROR_INVALID_HANDLE);
  CHECK(citizensdk_get_lifecycle(sdk, &lifecycle) == CITIZENSDK_ERROR_INVALID_HANDLE);
  free(assets);
  free(storage);
  puts("CitizenSDK C consumer passed");
  return 0;
}
