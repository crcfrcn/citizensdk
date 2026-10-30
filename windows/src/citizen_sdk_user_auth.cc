#include "citizen_sdk_user_auth.hpp"

#include <utility>
#include <chrono>
#include <thread>
#include <windows.h>
#include <winbio.h>
#include "citizen_sdk_directory.hpp"
#include "input.hpp"

namespace citizen_sdk::windows {
namespace {
// 凭据是实际UTF-8字节，不是授权布尔值；拒绝截断、过长、代理项及非最短编码。
// 此处只校验设备金库凭据边界，不复制Rust的BIP39派生密码规则。
bool valid_credential(citizensdk_bytes_view_t value) noexcept {
  if (value.data == nullptr || value.len < 12 ||
      value.len > input_limits::kMaximumUnlockPasswordBytes) return false;
  for (uint64_t i = 0; i < value.len;) {
    const uint8_t first = value.data[i++];
    if (first == 0) return false;
    if (first < 0x80) continue;
    uint32_t code = 0, minimum = 0;
    unsigned count = 0;
    if (first >= 0xc2 && first <= 0xdf) { code = first & 31; count = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { code = first & 15; count = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { code = first & 7; count = 3; minimum = 0x10000; }
    else return false;
    if (value.len - i < count) return false;
    while (count-- != 0) {
      const uint8_t next = value.data[i++];
      if ((next & 0xc0) != 0x80) return false;
      code = (code << 6) | (next & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
}  // namespace

citizensdk_error_code_t UserAuth::configure(const citizensdk_credential_provider_v1_t *provider) {
  if (provider != nullptr && (provider->struct_size != sizeof(*provider) ||
      provider->abi_version != CITIZENSDK_ABI_VERSION || provider->request == nullptr || provider->cancel == nullptr ||
      provider->retain == nullptr || provider->release == nullptr || provider->idle == nullptr))
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  std::shared_ptr<Provider> previous;
  {
    std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
    std::lock_guard<std::mutex> guard(lock_);
    prune_biometrics_locked();
    if ((!pending_.empty() || !biometric_.empty()) || (provider_ && provider_->value.idle(provider_->value.context) != 1))
      return CITIZENSDK_ERROR_BUSY;
    auto next = provider == nullptr ? std::shared_ptr<Provider>() : std::make_shared<Provider>(*provider);
    previous = std::move(provider_);
    provider_ = std::move(next);
  }
  // context的释放不在凭据锁下，且所有快照共同持有它至最后一个回调退出。
  previous.reset();
  return CITIZENSDK_OK;
}

bool UserAuth::available() const noexcept {
  try { std::lock_guard<std::mutex> guard(lock_); return provider_ != nullptr; }
  catch (...) { return false; }
}
bool UserAuth::idle() const noexcept {
  try {
    std::shared_ptr<Provider> provider;
    {
      std::lock_guard<std::mutex> guard(lock_);
      prune_biometrics_locked();
      if ((!pending_.empty() || !biometric_.empty())) return false;
      provider = provider_;
    }
    // 不能持有callback_lock_：request可能同步回Host回包，
    // 而关闭线程正持Host锁查询idle；反向取锁会相互等待。
    return !provider || provider->value.idle(provider->value.context) == 1;
  } catch (...) { return false; }
}

// WinBioWait是官方回调排空屏障；每个会话最多一个回收线程，不阻塞UI或释放未知context。
void UserAuth::close_biometric(const std::shared_ptr<Biometric> &state) {
  std::uintptr_t session=0;
  {
    std::lock_guard<std::mutex> guard(state->mutex);
    if(state->session==0 || state->closed || state->close_accepted || state->draining)return;
    state->draining=true;state->close_completed=false;session=state->session;
  }
  try {
    // 重试只在原回收线程及回调引用已经离开后接纳，沿同一状态复用真实会话。
    if(state->worker.joinable())state->worker.join();
    state->worker=std::thread([state,session]{
      // 不按假定的CANCEL操作枚举/通知次数判断排空；使用同一WBF会话的官方Wait。
      const HRESULT waited=::WinBioWait(static_cast<WINBIO_SESSION_HANDLE>(session));
      {
        std::lock_guard<std::mutex> guard(state->mutex);
        state->callbacks_drained=SUCCEEDED(waited);
        if(FAILED(waited)){
          state->draining=false;state->close_completed=true;state->ready.notify_all();return;
        }
        state->close_accepted=true;
      }
      const HRESULT code=::WinBioCloseSession(static_cast<WINBIO_SESSION_HANDLE>(session));
      {
        std::lock_guard<std::mutex> guard(state->mutex);state->draining=false;
        if(FAILED(code)){state->close_accepted=false;state->close_completed=true;}
      }
      state->ready.notify_all();
    });
  } catch (...) {
    std::lock_guard<std::mutex> guard(state->mutex);
    state->draining=false;state->close_completed=true;state->ready.notify_all();
  }
}

// WBF只验证当前调用用户SID；不接受其他用户的指纹、不回退为PIN或凭据密码。
citizensdk_error_code_t UserAuth::authorize_add_accounts(uint64_t host_operation_id,
    const std::function<bool(const std::atomic_bool &)> &foreground) {
  if(host_operation_id==0||!foreground)return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  auto state=std::make_shared<Biometric>();
  {
    std::lock_guard<std::mutex> guard(lock_);prune_biometrics_locked();
    // 上一会话排空前不接受另一生物认证，避免失败会话无限积累或复用成功授权。
    if(!biometric_.empty())return CITIZENSDK_ERROR_BUSY;
    biometric_.emplace(host_operation_id,state);
  }
  struct Registration {
    UserAuth *owner;
    ~Registration(){std::lock_guard<std::mutex> guard(owner->lock_);owner->prune_biometrics_locked();}
  } registration{this};
  // UI检查也属于本次已登记操作；取消在WBF接纳前到达时不能再弹出生物认证。
  const bool allowed=foreground(state->cancelled);
  if(state->cancelled.load())return CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
  if(!allowed)return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  WINBIO_IDENTITY identity{};
  auto sid=current_user_sid();
  if(sid.size()>sizeof(identity.Value.AccountSid.Data) ||
      !::CopySid(sizeof(identity.Value.AccountSid.Data),identity.Value.AccountSid.Data,sid.data()))
    return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  identity.Type=WINBIO_ID_TYPE_SID;identity.Value.AccountSid.Size=static_cast<ULONG>(sid.size());
  WINBIO_SESSION_HANDLE session=0;
  const HRESULT opened=::WinBioAsyncOpenSession(WINBIO_TYPE_FINGERPRINT,WINBIO_POOL_SYSTEM,
      WINBIO_FLAG_DEFAULT,nullptr,0,nullptr,WINBIO_ASYNC_NOTIFY_CALLBACK,nullptr,0,
      [](PWINBIO_ASYNC_RESULT value){
        // map和本回调共同拥有同一状态；迟到回调不会访问已返回的栈或UserAuth对象。
        auto callback=static_cast<Biometric *>(value->UserData)->shared_from_this();
        {
          std::lock_guard<std::mutex> guard(callback->mutex);
          if(value->Operation==WINBIO_OPERATION_VERIFY){callback->matched=SUCCEEDED(value->ApiStatus)&&value->Parameters.Verify.Match!=FALSE;callback->verified=true;}
          else if(value->Operation==WINBIO_OPERATION_CLOSE){callback->closed=SUCCEEDED(value->ApiStatus);callback->close_completed=true;callback->close_accepted=false;}
        }
        ::WinBioFree(value);callback->ready.notify_all();
      },state.get(),FALSE,&session);
  if(FAILED(opened))return CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
  {std::lock_guard<std::mutex> guard(state->mutex);state->session=static_cast<std::uintptr_t>(session);}
  const HRESULT started=state->cancelled.load()?E_ABORT:
      ::WinBioVerify(session,&identity,WINBIO_SUBTYPE_ANY,nullptr,nullptr,nullptr);
  bool revoked=state->cancelled.load();
  {
    std::unique_lock<std::mutex> guard(state->mutex);state->verify_accepted=SUCCEEDED(started);
    if(SUCCEEDED(started)){
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(60);
      while(!state->verified&&!state->cancelled.load()&&std::chrono::steady_clock::now()<deadline)
        state->ready.wait_for(guard,std::chrono::milliseconds(25));
      revoked=state->cancelled.load()||!state->verified;
    }
  }
  if(revoked)(void)::WinBioCancel(session);
  close_biometric(state);
  std::unique_lock<std::mutex> guard(state->mutex);
  const bool completed=state->ready.wait_for(guard,std::chrono::seconds(30),[&]{
    return state->drained() || (state->close_completed&&!state->closed);
  });
  if(!completed||!state->drained())return CITIZENSDK_ERROR_UNAVAILABLE;
  if(revoked||state->cancelled.load())return CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
  return SUCCEEDED(started)&&state->verified&&state->matched?CITIZENSDK_OK:CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED;
}

AuthenticationResult UserAuth::create_vault_password(uint64_t host_operation_id) {
  return request(1, host_operation_id);
}
AuthenticationResult UserAuth::unlock_vault_password(uint64_t host_operation_id) {
  return request(2, host_operation_id);
}

AuthenticationResult UserAuth::request(uint32_t key_purpose, uint64_t host_operation_id) {
  if (host_operation_id == 0) return {CITIZENSDK_ERROR_INVALID_ARGUMENT, {}};
  auto pending = std::make_shared<Pending>();
  {
    std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
    std::shared_ptr<Provider> provider;
    {
      std::lock_guard<std::mutex> guard(lock_);
      if (!provider_) return {CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED, {}};
      if (!pending_.emplace(host_operation_id, pending).second)
        return {CITIZENSDK_ERROR_CONFLICT, {}};
      provider = provider_;
    }
    const citizensdk_credential_challenge_v1_t challenge{
        sizeof(citizensdk_credential_challenge_v1_t), CITIZENSDK_ABI_VERSION, host_operation_id, key_purpose, 0};
    try { provider->value.request(provider->value.context, &challenge); }
    catch (...) {
      // 异常不能留下等待者或已经同步交付的凭据。
      cancel(host_operation_id);
    }
  }
  std::unique_lock<std::mutex> guard(lock_);
  pending->ready.wait(guard, [&] { return pending->done; });
  AuthenticationResult result = std::move(pending->result);
  pending_.erase(host_operation_id);
  return result;
}

citizensdk_error_code_t UserAuth::respond(
    uint64_t host_operation_id, citizensdk_bytes_view_t credential) {
  std::lock_guard<std::mutex> guard(lock_);
  const auto found = pending_.find(host_operation_id);
  if (found == pending_.end() || found->second->done) return CITIZENSDK_ERROR_INVALID_STATE;
  auto &pending = *found->second;
  const bool cancelled = credential.data == nullptr && credential.len == 0;
  if (!cancelled && !valid_credential(credential)) {
    pending.result.code = CITIZENSDK_ERROR_INVALID_ARGUMENT;
  } else if (cancelled) {
    pending.result.code = CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
  } else {
    try {
      pending.result.password = SensitiveBuffer(credential.data, static_cast<std::size_t>(credential.len));
      pending.result.code = CITIZENSDK_OK;
    } catch (...) { pending.result.code = CITIZENSDK_ERROR_INTERNAL; }
  }
  pending.done = true;
  pending.ready.notify_all();
  return pending.result.code == CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED
      ? CITIZENSDK_OK : pending.result.code;
}

citizensdk_error_code_t UserAuth::cancel(uint64_t host_operation_id) {
  std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
  std::shared_ptr<Provider> provider;
  {
    std::lock_guard<std::mutex> guard(lock_);
    prune_biometrics_locked();
    if (const auto biometric = biometric_.find(host_operation_id); biometric != biometric_.end()) {
      biometric->second->cancelled.store(true);
      return CITIZENSDK_OK;
    }
    const auto found = pending_.find(host_operation_id);
    if (found == pending_.end()) return CITIZENSDK_ERROR_INVALID_STATE;
    // 撤销优先于尚未被工作线程领取的成功回包；迟到/重复回包不能恢复它。
    found->second->result.password.clear();
    found->second->result.code = CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED;
    found->second->done = true;
    found->second->ready.notify_all();
    provider = provider_;
  }
  try { if (provider) provider->value.cancel(provider->value.context, host_operation_id); }
  catch (...) {}  // 宿主UI取消异常不得重新开放凭据交付。
  return CITIZENSDK_OK;
}

void UserAuth::cancel_all() {
  std::lock_guard<std::recursive_mutex> callbacks(callback_lock_);
  std::vector<uint64_t> ids;
  std::vector<std::shared_ptr<Biometric>> retired;
  {
    std::lock_guard<std::mutex> guard(lock_);
    ids.reserve(pending_.size());
    for (const auto &entry : pending_) ids.push_back(entry.first);
    prune_biometrics_locked();
    for (const auto &entry : biometric_) {
      entry.second->cancelled.store(true);
      // 只有认证函数已返回且无回调借用时才重试关闭，不与VERIFY派发竞态。
      if(entry.second.use_count()==1)retired.push_back(entry.second);
    }
  }
  for (const auto id : ids) (void)cancel(id);
  for(const auto &state:retired)close_biometric(state);
}

}  // namespace citizen_sdk::windows
