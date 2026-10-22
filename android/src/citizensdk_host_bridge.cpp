#include "citizensdk_host_bridge.hpp"

#include <cstring>
#include <limits>
#include <utility>

#include "citizensdk_jni_support.hpp"
#include "citizensdk_internal.h"

namespace citizen::sdk::jni {
namespace {

constexpr int32_t kOk = CITIZENSDK_OK;
constexpr int32_t kInternal = CITIZENSDK_ERROR_INTERNAL;

struct ScopedEnv {
  JavaVM *vm;
  JNIEnv *env = nullptr;
  bool attached = false;

  explicit ScopedEnv(JavaVM *value) : vm(value) {
    const jint state = vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
    if (state == JNI_EDETACHED &&
        vm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
      attached = true;
    }
  }
  ~ScopedEnv() {
    if (attached) vm->DetachCurrentThread();
  }
};

citizensdk_bytes_view_t view(const std::vector<uint8_t> &bytes) {
  return {bytes.empty() ? nullptr : bytes.data(),
          static_cast<uint64_t>(bytes.size())};
}

jbyteArray java_bytes(JNIEnv *env, const uint8_t *data, size_t length) {
  if (length > static_cast<size_t>(std::numeric_limits<jsize>::max())) return nullptr;
  jbyteArray result = env->NewByteArray(static_cast<jsize>(length));
  if (result != nullptr && length != 0) {
    env->SetByteArrayRegion(result, 0, static_cast<jsize>(length),
                            reinterpret_cast<const jbyte *>(data));
  }
  return result;
}

jbyteArray java_id(JNIEnv *env, const citizensdk_host_id128_t &id) {
  return java_bytes(env, id.bytes, sizeof(id.bytes));
}



int32_t exception_code(JNIEnv *env) {
  if (!env->ExceptionCheck()) return kInternal;
  jthrowable failure = env->ExceptionOccurred();
  env->ExceptionClear();
  int32_t code = kInternal;
  jclass sqlite_error=env->FindClass("android/database/sqlite/SQLiteException");
  if(sqlite_error && env->IsInstanceOf(failure,sqlite_error)){env->DeleteLocalRef(sqlite_error);env->DeleteLocalRef(failure);return CITIZENSDK_ERROR_STORAGE;}
  if(sqlite_error)env->DeleteLocalRef(sqlite_error);
  if(env->ExceptionCheck())env->ExceptionClear();
  // 密文Core投影抛公开SDK异常，设备金库抛VaultFailure；共享错误提取，绝不把异常映射成OK。
  const char *classes[] = {"org/citizen/sdk/internal/CitizenSdkHardwareVault$VaultFailure",
                          "org/citizen/sdk/CitizenSdkException"};
  for (const char *name : classes) {
    jclass type = env->FindClass(name);
    const bool match = !env->ExceptionCheck() && type && env->IsInstanceOf(failure, type);
    if (match) {
      jmethodID getter = env->GetMethodID(type, "getCode", "()Lorg/citizen/sdk/CitizenSdkErrorCode;");
      jobject value = getter ? env->CallObjectMethod(failure, getter) : nullptr;
      if (!env->ExceptionCheck() && value) {
        jclass value_type = env->GetObjectClass(value);
        jmethodID number = value_type ? env->GetMethodID(value_type, "getValue", "()I") : nullptr;
        if (number) code = env->CallIntMethod(value, number);
        if (value_type) env->DeleteLocalRef(value_type);
        env->DeleteLocalRef(value);
      }
    }
    if (env->ExceptionCheck()) { env->ExceptionClear(); code = kInternal; }
    if (type) env->DeleteLocalRef(type);
    if (match) break;
  }
  if (failure) env->DeleteLocalRef(failure);
  return code >= 1 && code <= CITIZENSDK_ERROR_CANCELLED ? code : kInternal;
}

void complete_status(uint64_t operation_id, void *sdk_context,
                     citizensdk_host_status_completion_v1_t completion,
                     int32_t code) {
  if (completion == nullptr) return;
  citizensdk_host_status_result_v1_t result{};
  result.struct_size = sizeof(result);
  result.abi_version = CITIZENSDK_ABI_VERSION;
  result.host_operation_id = operation_id;
  result.error_code = code;
  completion(sdk_context, &result);
}

void complete_bool(uint64_t operation_id, void *sdk_context,
                   citizensdk_host_bool_completion_v1_t completion,
                   int32_t code, bool value) {
  if (completion == nullptr) return;
  citizensdk_host_bool_result_v1_t result{};
  result.struct_size = sizeof(result);
  result.abi_version = CITIZENSDK_ABI_VERSION;
  result.host_operation_id = operation_id;
  result.error_code = code;
  result.value = code == kOk && value ? 1 : 0;
  completion(sdk_context, &result);
}

int32_t vault_availability(
    void *context, uint64_t operation_id, void *sdk_context,
    citizensdk_host_vault_availability_completion_v1_t completion) {
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  ScopedEnv scoped(bridge->vm());
  if (scoped.env == nullptr) return kInternal;
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  jmethodID id = env->GetMethodID(type, "vaultAvailability", "()I");
  jint availability = id == nullptr
                          ? CITIZENSDK_HOST_VAULT_UNAVAILABLE
                          : env->CallIntMethod(bridge->host_services(), id);
  env->DeleteLocalRef(type);
  if (env->ExceptionCheck()) return exception_code(env);
  citizensdk_host_vault_availability_result_v1_t result{};
  result.struct_size = sizeof(result);
  result.abi_version = CITIZENSDK_ABI_VERSION;
  result.host_operation_id = operation_id;
  result.error_code = kOk;
  result.availability = static_cast<uint32_t>(availability);
  completion(sdk_context, &result);
  return kOk;
}

int32_t vault_status_call(CitizenSdkHostBridge *bridge, const char *method,
                          uint64_t operation_id,
                          citizensdk_host_wallet_key_ref_v1_t wallet,
                          citizensdk_host_id128_t operation,
                          void *sdk_context,
                          citizensdk_host_status_completion_v1_t completion) {
  ScopedEnv scoped(bridge->vm());
  if (scoped.env == nullptr) return kInternal;
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  jmethodID id = env->GetMethodID(type, method, "(I[B[B)I");
  jbyteArray generation = java_id(env, wallet.generation);
  jbyteArray operation_id_bytes = java_id(env, operation);
  jint code = id == nullptr || generation == nullptr || operation_id_bytes == nullptr
                  ? kInternal
                  : env->CallIntMethod(bridge->host_services(), id,
                                       static_cast<jint>(wallet.wallet_index),
                                       generation, operation_id_bytes);
  env->DeleteLocalRef(type);
  if (generation != nullptr) env->DeleteLocalRef(generation);
  if (operation_id_bytes != nullptr) env->DeleteLocalRef(operation_id_bytes);
  if (env->ExceptionCheck()) return exception_code(env);
  complete_status(operation_id, sdk_context, completion, code);
  return kOk;
}

int32_t vault_ensure(void *context, uint64_t operation_id,
                     citizensdk_host_wallet_key_ref_v1_t wallet,
                     citizensdk_host_id128_t provisioning, void *sdk_context,
                     citizensdk_host_status_completion_v1_t completion) {
  return vault_status_call(static_cast<CitizenSdkHostBridge *>(context),
                           "ensureWalletKek", operation_id, wallet,
                           provisioning, sdk_context, completion);
}

int32_t vault_has(void *context, uint64_t operation_id,
                  citizensdk_host_wallet_key_ref_v1_t wallet,
                  void *sdk_context,
                  citizensdk_host_bool_completion_v1_t completion) {
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  ScopedEnv scoped(bridge->vm());
  if (scoped.env == nullptr) return kInternal;
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  jmethodID id = env->GetMethodID(type, "hasWalletKek", "(I[B)Z");
  jbyteArray generation = java_id(env, wallet.generation);
  jboolean value = id == nullptr || generation == nullptr
                       ? JNI_FALSE
                       : env->CallBooleanMethod(bridge->host_services(), id,
                                                static_cast<jint>(wallet.wallet_index),
                                                generation);
  env->DeleteLocalRef(type);
  if (generation != nullptr) env->DeleteLocalRef(generation);
  if (env->ExceptionCheck()) return exception_code(env);
  complete_bool(operation_id, sdk_context, completion, kOk, value == JNI_TRUE);
  return kOk;
}

int32_t account_secret_presence(void *context, uint64_t operation_id, citizensdk_account_id_t account,
    void *sdk_context, citizensdk_host_bool_completion_v1_t completion) {
  if (!context || !completion) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  ScopedEnv scoped(bridge->vm());
  if (!scoped.env) return kInternal;
  auto *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  if (!type) return exception_code(env);
  jmethodID method = env->GetMethodID(type, "hasAccountSecret", "([B)Z");
  if (!method) { env->DeleteLocalRef(type); return exception_code(env); }
  auto bytes = java_bytes(env, account.bytes, 32);
  if (!bytes) { env->DeleteLocalRef(type); return exception_code(env); }
  const auto present = env->CallBooleanMethod(bridge->host_services(), method, bytes);
  env->DeleteLocalRef(bytes); env->DeleteLocalRef(type);
  if (env->ExceptionCheck()) return exception_code(env);
  complete_bool(operation_id, sdk_context, completion, kOk, present == JNI_TRUE);
  return kOk;
}
int32_t wallet_key_presence(void *context, uint64_t operation_id, uint32_t wallet_index,
    void *sdk_context, citizensdk_host_bool_completion_v1_t completion) {
  if (!context || !completion) return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  ScopedEnv scoped(bridge->vm());
  if (!scoped.env) return kInternal;
  auto *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  if (!type) return exception_code(env);
  jmethodID method = env->GetMethodID(type, "hasAnyWalletKey", "(I)Z");
  if (!method) { env->DeleteLocalRef(type); return exception_code(env); }
  const auto present = env->CallBooleanMethod(bridge->host_services(), method, static_cast<jint>(wallet_index));
  env->DeleteLocalRef(type);
  if (env->ExceptionCheck()) return exception_code(env);
  complete_bool(operation_id, sdk_context, completion, kOk, present == JNI_TRUE);
  return kOk;
}

int32_t vault_wrap(void *context, uint64_t operation_id,
                   citizensdk_host_wallet_key_ref_v1_t wallet,
                   citizensdk_host_id128_t provisioning,
                   citizensdk_bytes_view_t plaintext_dek, void *sdk_context,
                   citizensdk_host_bytes_completion_v1_t completion) {
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  if (plaintext_dek.data == nullptr || plaintext_dek.len != CITIZENSDK_HOST_DEK_BYTES) {
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  ScopedEnv scoped(bridge->vm());
  if (scoped.env == nullptr) return kInternal;
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  jmethodID id = env->GetMethodID(
      type, "wrapDek", "(I[B[BLjava/nio/ByteBuffer;)[B");
  jbyteArray generation = java_id(env, wallet.generation);
  jbyteArray operation = java_id(env, provisioning);
  jobject direct = env->NewDirectByteBuffer(
      const_cast<uint8_t *>(plaintext_dek.data),
      static_cast<jlong>(plaintext_dek.len));
  jbyteArray wrapped = id == nullptr || generation == nullptr ||
                               operation == nullptr || direct == nullptr
                           ? nullptr
                           : static_cast<jbyteArray>(env->CallObjectMethod(
                                 bridge->host_services(), id,
                                 static_cast<jint>(wallet.wallet_index),
                                 generation, operation, direct));
  env->DeleteLocalRef(type);
  if (generation != nullptr) env->DeleteLocalRef(generation);
  if (operation != nullptr) env->DeleteLocalRef(operation);
  if (direct != nullptr) env->DeleteLocalRef(direct);
  if (env->ExceptionCheck() || wrapped == nullptr) {
    if (wrapped != nullptr) env->DeleteLocalRef(wrapped);
    return exception_code(env);
  }
  jbyte *raw = env->GetByteArrayElements(wrapped, nullptr);
  if (raw == nullptr) {
    env->DeleteLocalRef(wrapped);
    return kInternal;
  }
  citizensdk_host_bytes_result_v1_t result{};
  result.struct_size = sizeof(result);
  result.abi_version = CITIZENSDK_ABI_VERSION;
  result.host_operation_id = operation_id;
  result.error_code = kOk;
  result.kind = CITIZENSDK_HOST_BYTES_WRAPPED_DEK;
  result.bytes = {reinterpret_cast<const uint8_t *>(raw),
                  static_cast<uint64_t>(env->GetArrayLength(wrapped))};
  completion(sdk_context, &result);
  env->ReleaseByteArrayElements(wrapped, raw, JNI_ABORT);
  env->DeleteLocalRef(wrapped);
  return kOk;
}

int32_t vault_unwrap(void *context, uint64_t operation_id,
                     citizensdk_host_wallet_key_ref_v1_t wallet,
                     citizensdk_bytes_view_t wrapped_dek,
                     citizensdk_mutable_bytes_view_t plaintext_dek_out,
                     void *sdk_context,
                     citizensdk_host_status_completion_v1_t completion) {
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  if (wrapped_dek.data == nullptr || wrapped_dek.len == 0 ||
      plaintext_dek_out.data == nullptr ||
      plaintext_dek_out.len != CITIZENSDK_HOST_DEK_BYTES) {
    return CITIZENSDK_ERROR_INVALID_ARGUMENT;
  }
  bridge->remember_vault_status(operation_id, sdk_context, completion);
  ScopedEnv scoped(bridge->vm());
  if (scoped.env == nullptr) {
    bridge->reject_vault_status(operation_id);
    return kInternal;
  }
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  jmethodID id = env->GetMethodID(
      type, "unwrapDek", "(JJI[B[BLjava/nio/ByteBuffer;)I");
  jbyteArray generation = java_id(env, wallet.generation);
  jbyteArray wrapped = java_bytes(env, wrapped_dek.data,
                                  static_cast<size_t>(wrapped_dek.len));
  jobject direct = env->NewDirectByteBuffer(
      plaintext_dek_out.data, static_cast<jlong>(plaintext_dek_out.len));
  jint code = id == nullptr || generation == nullptr || wrapped == nullptr ||
                      direct == nullptr
                  ? kInternal
                  : env->CallIntMethod(
                        bridge->host_services(), id,
                        static_cast<jlong>(reinterpret_cast<intptr_t>(bridge)),
                        static_cast<jlong>(operation_id),
                        static_cast<jint>(wallet.wallet_index), generation,
                        wrapped, direct);
  env->DeleteLocalRef(type);
  if (generation != nullptr) env->DeleteLocalRef(generation);
  if (wrapped != nullptr) env->DeleteLocalRef(wrapped);
  if (direct != nullptr) env->DeleteLocalRef(direct);
  if (env->ExceptionCheck()) code = exception_code(env);
  if (code != kOk) bridge->reject_vault_status(operation_id);
  return code;
}

// 独立认证没有秘密缓冲；仍由同一操作注册表保持SDK完成回调的生命周期。
int32_t vault_authorize_add_accounts(void *context, uint64_t operation_id,
    citizensdk_host_wallet_key_ref_v1_t wallet, citizensdk_host_id128_t provisioning,
    void *sdk_context, citizensdk_host_status_completion_v1_t completion) {
  auto *bridge = static_cast<CitizenSdkHostBridge *>(context);
  bridge->remember_vault_status(operation_id, sdk_context, completion);
  ScopedEnv scoped(bridge->vm());
  if (scoped.env == nullptr) { bridge->reject_vault_status(operation_id); return kInternal; }
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(bridge->host_services());
  jmethodID id = env->GetMethodID(type, "authorizeAddAccounts", "(JJI[B[B)I");
  jbyteArray generation = java_id(env, wallet.generation);
  jbyteArray operation = java_id(env, provisioning);
  jint code = id == nullptr || generation == nullptr || operation == nullptr ? kInternal :
      env->CallIntMethod(bridge->host_services(), id,
          static_cast<jlong>(reinterpret_cast<intptr_t>(bridge)), static_cast<jlong>(operation_id),
          static_cast<jint>(wallet.wallet_index), generation, operation);
  env->DeleteLocalRef(type);
  if (generation != nullptr) env->DeleteLocalRef(generation);
  if (operation != nullptr) env->DeleteLocalRef(operation);
  if (env->ExceptionCheck()) code = exception_code(env);
  if (code != kOk) bridge->reject_vault_status(operation_id);
  return code;
}

int32_t vault_retire(void *context, uint64_t operation_id,
                     citizensdk_host_wallet_key_ref_v1_t wallet,
                     citizensdk_host_id128_t cleanup, void *sdk_context,
                     citizensdk_host_status_completion_v1_t completion) {
  return vault_status_call(static_cast<CitizenSdkHostBridge *>(context),
                           "retireWalletKek", operation_id, wallet, cleanup,
                           sdk_context, completion);
}


// 外层run保持JVM附着和Kotlin连接锁，所有嵌套SQL在同一Rust请求线程完成。
struct DatabaseFrame {
  ScopedEnv scoped;
  bool valid;
  explicit DatabaseFrame(DatabaseContext *db):scoped(db->vm),valid(scoped.env && scoped.env->PushLocalFrame(128)==JNI_OK){}
  ~DatabaseFrame(){if(valid)scoped.env->PopLocalFrame(nullptr);}
};
jmethodID database_method(JNIEnv *env,DatabaseContext *db,const char *name,const char *signature){
  jclass type=env->GetObjectClass(db->host);
  if(!type)return nullptr;auto id=env->GetMethodID(type,name,signature);env->DeleteLocalRef(type);return id;
}
jstring database_text(JNIEnv *env,const uint8_t *bytes,uint64_t size){
  if(size>33554432 || (size && !bytes))return nullptr;
  jclass type=env->FindClass("java/lang/String");if(!type)return nullptr;
  auto ctor=env->GetMethodID(type,"<init>","([BLjava/lang/String;)V");
  auto data=java_bytes(env,bytes,static_cast<size_t>(size));auto charset=env->NewStringUTF("UTF-8");
  auto value=ctor&&data&&charset?static_cast<jstring>(env->NewObject(type,ctor,data,charset)):nullptr;
  if(data)env->DeleteLocalRef(data);if(charset)env->DeleteLocalRef(charset);env->DeleteLocalRef(type);return value;
}
jobjectArray database_values(JNIEnv *env,const citizensdk_sql_value_t *values,uint64_t count){
  if(count>16 || (count && !values))return nullptr;
  jclass object=env->FindClass("java/lang/Object"),number=env->FindClass("java/lang/Long");
  if(!object||!number)return nullptr;
  auto ctor=env->GetMethodID(number,"<init>","(J)V");auto result=env->NewObjectArray(static_cast<jsize>(count),object,nullptr);
  if(!ctor||!result)return nullptr;
  for(uint64_t i=0;i<count;++i){const auto &cell=values[i];if(cell.reserved)return nullptr;jobject value=nullptr;
    switch(cell.kind){case 0:break;case 1:value=env->NewObject(number,ctor,static_cast<jlong>(cell.integer));break;
      case 2:value=database_text(env,cell.bytes.data,cell.bytes.len);break;
      case 3:if(cell.bytes.len>33554432||(cell.bytes.len&&!cell.bytes.data))return nullptr;value=java_bytes(env,cell.bytes.data,static_cast<size_t>(cell.bytes.len));break;
      default:return nullptr;}
    if((cell.kind!=0&&!value)||env->ExceptionCheck())return nullptr;
    env->SetObjectArrayElement(result,static_cast<jsize>(i),value);if(value)env->DeleteLocalRef(value);
  }return result;
}
int32_t database_status(DatabaseContext *db,JNIEnv *env,const char *name){
  auto id=database_method(env,db,name,"(Z)I");if(!id)return exception_code(env);
  const auto code=env->CallIntMethod(db->host,id,db->secure?JNI_TRUE:JNI_FALSE);return env->ExceptionCheck()?exception_code(env):code;
}
int32_t database_run(void *context,citizensdk_store_job_t job,void *job_context) noexcept {
  try{if(!context||!job)return CITIZENSDK_ERROR_INVALID_ARGUMENT;auto *db=static_cast<DatabaseContext*>(context);DatabaseFrame frame(db);
    if(!frame.valid)return kInternal;auto *env=frame.scoped.env;
    auto lock_id=database_method(env,db,"databaseLock","(Z)I"),unlock_id=database_method(env,db,"databaseUnlock","(Z)I");
    if(!lock_id||!unlock_id||env->ExceptionCheck())return exception_code(env);
    auto code=env->CallIntMethod(db->host,lock_id,db->secure?JNI_TRUE:JNI_FALSE);
    if(env->ExceptionCheck())return exception_code(env);if(code!=kOk)return code;
    code=job(job_context);auto unlock=env->CallIntMethod(db->host,unlock_id,db->secure?JNI_TRUE:JNI_FALSE);
    if(env->ExceptionCheck())unlock=exception_code(env);return code==kOk?unlock:code;
  }catch(...){return kInternal;}
}
int32_t database_execute(void *context,citizensdk_bytes_view_t sql,const citizensdk_sql_value_t *values,uint64_t count,uint64_t *changes) noexcept {
  try{if(!context||!changes||sql.len>65536)return CITIZENSDK_ERROR_INVALID_ARGUMENT;auto *db=static_cast<DatabaseContext*>(context);DatabaseFrame frame(db);
    if(!frame.valid)return kInternal;auto *env=frame.scoped.env;
    auto text=database_text(env,sql.data,sql.len);auto args=database_values(env,values,count);
    auto id=database_method(env,db,"databaseExecute","(ZLjava/lang/String;[Ljava/lang/Object;)J");
    if(!text||!args||!id)return exception_code(env);auto value=env->CallLongMethod(db->host,id,db->secure?JNI_TRUE:JNI_FALSE,text,args);
    if(env->ExceptionCheck())return exception_code(env);if(value<0)return CITIZENSDK_ERROR_STORAGE;*changes=static_cast<uint64_t>(value);return kOk;
  }catch(...){return kInternal;}
}
int32_t database_query(void *context,citizensdk_bytes_view_t sql,const citizensdk_sql_value_t *values,uint64_t count,uint64_t maximum,uint64_t budget,citizensdk_store_row_t receive,void *row_context) noexcept {
  try{if(!context||!receive||sql.len>65536||maximum>65537||budget>33554432)return CITIZENSDK_ERROR_INVALID_ARGUMENT;
    auto *db=static_cast<DatabaseContext*>(context);DatabaseFrame frame(db);if(!frame.valid)return kInternal;auto *env=frame.scoped.env;
    auto text=database_text(env,sql.data,sql.len);auto args=database_values(env,values,count);
    auto method=database_method(env,db,"databaseCursor","(ZLjava/lang/String;[Ljava/lang/Object;)Landroid/database/Cursor;");
    jclass cursor_type=env->FindClass("android/database/Cursor"),string_type=env->FindClass("java/lang/String");
    if(!text||!args||!method||!cursor_type||!string_type)return exception_code(env);
    // 取得游标前解析所有方法，包括close，任何退出都必须释放游标。
    auto columns_id=env->GetMethodID(cursor_type,"getColumnCount","()I"),next_id=env->GetMethodID(cursor_type,"moveToNext","()Z"),type_id=env->GetMethodID(cursor_type,"getType","(I)I"),integer_id=env->GetMethodID(cursor_type,"getLong","(I)J"),text_id=env->GetMethodID(cursor_type,"getString","(I)Ljava/lang/String;"),blob_id=env->GetMethodID(cursor_type,"getBlob","(I)[B"),close_id=env->GetMethodID(cursor_type,"close","()V"),bytes_id=env->GetMethodID(string_type,"getBytes","(Ljava/lang/String;)[B");
    auto charset=env->NewStringUTF("UTF-8");
    if(!columns_id||!next_id||!type_id||!integer_id||!text_id||!blob_id||!close_id||!bytes_id||!charset||env->ExceptionCheck())return exception_code(env);
    auto cursor=env->CallObjectMethod(db->host,method,db->secure?JNI_TRUE:JNI_FALSE,text,args);
    if(env->ExceptionCheck())return exception_code(env);if(!cursor)return kInternal;
    int32_t result=kInternal;
    {
      struct Close {JNIEnv *env;jobject cursor;jmethodID id;int32_t &code;~Close(){env->CallVoidMethod(cursor,id);if(env->ExceptionCheck()){const auto failure=exception_code(env);if(code==kOk)code=failure;}}} close{env,cursor,close_id,result};
      try { result=[&]()->int32_t {
        const auto n=env->CallIntMethod(cursor,columns_id);if(env->ExceptionCheck())return exception_code(env);if(n<0||n>64)return CITIZENSDK_ERROR_STORAGE;
        uint64_t rows=0;
        while(true){const auto next=env->CallBooleanMethod(cursor,next_id);if(env->ExceptionCheck())return exception_code(env);if(next!=JNI_TRUE)break;
          if(++rows>maximum)return CITIZENSDK_ERROR_STORAGE;if(env->PushLocalFrame(128)!=JNI_OK)return exception_code(env);
          struct Pop {JNIEnv *env;~Pop(){env->PopLocalFrame(nullptr);}} pop{env};
          uint64_t remaining=budget;std::vector<citizensdk_sql_value_t> cells(static_cast<size_t>(n));std::vector<std::vector<uint8_t>> bytes(static_cast<size_t>(n));
          for(jint column=0;column<n;++column){auto &cell=cells[static_cast<size_t>(column)];const auto kind=env->CallIntMethod(cursor,type_id,column);
            if(env->ExceptionCheck())return exception_code(env);
            if(kind==0)cell.kind=0;
            else if(kind==1){cell.kind=1;cell.integer=env->CallLongMethod(cursor,integer_id,column);}
            else{jbyteArray data=nullptr;
              if(kind==3){cell.kind=2;auto value=env->CallObjectMethod(cursor,text_id,column);if(env->ExceptionCheck())return exception_code(env);if(!value)return CITIZENSDK_ERROR_STORAGE;data=static_cast<jbyteArray>(env->CallObjectMethod(value,bytes_id,charset));}
              else if(kind==4){cell.kind=3;data=static_cast<jbyteArray>(env->CallObjectMethod(cursor,blob_id,column));}else return CITIZENSDK_ERROR_STORAGE;
              if(env->ExceptionCheck())return exception_code(env);if(!data)return CITIZENSDK_ERROR_STORAGE;
              const auto length=env->GetArrayLength(data);if(length<0||static_cast<uint64_t>(length)>remaining)return CITIZENSDK_ERROR_STORAGE;remaining-=static_cast<uint64_t>(length);
              auto &copy=bytes[static_cast<size_t>(column)];copy.resize(static_cast<size_t>(length));if(length)env->GetByteArrayRegion(data,0,length,reinterpret_cast<jbyte*>(copy.data()));cell.bytes=view(copy);
            }if(env->ExceptionCheck())return exception_code(env);
          }
          const auto code=receive(row_context,cells.data(),cells.size());if(code!=kOk)return code;
        }return kOk;
      }(); }catch(...){result=kInternal;}
    }return result;
  }catch(...){return kInternal;}
}
int32_t database_begin(void *context) noexcept {try{auto *db=static_cast<DatabaseContext*>(context);DatabaseFrame frame(db);return frame.valid?database_status(db,frame.scoped.env,"databaseBegin"):kInternal;}catch(...){return kInternal;}}
int32_t database_end(void *context,uint8_t commit) noexcept {try{if(commit>1)return CITIZENSDK_ERROR_INVALID_ARGUMENT;auto *db=static_cast<DatabaseContext*>(context);DatabaseFrame frame(db);if(!frame.valid)return kInternal;auto *env=frame.scoped.env;auto id=database_method(env,db,"databaseEnd","(ZZ)I");if(!id)return exception_code(env);const auto result=env->CallIntMethod(db->host,id,db->secure?JNI_TRUE:JNI_FALSE,commit?JNI_TRUE:JNI_FALSE);return env->ExceptionCheck()?exception_code(env):result;}catch(...){return kInternal;}}
int32_t database_wal(void *context) noexcept {try{auto *db=static_cast<DatabaseContext*>(context);DatabaseFrame frame(db);return frame.valid?database_status(db,frame.scoped.env,"databaseWal"):kInternal;}catch(...){return kInternal;}}
citizensdk_store_v1_t database_config(DatabaseContext &db){return {sizeof(citizensdk_store_v1_t),1,&db,database_run,database_execute,database_query,database_begin,database_end,database_wal};}
bool id_bytes(JNIEnv *env,jbyteArray value,void *out,jsize length){if(!value||env->GetArrayLength(value)!=length)return false;env->GetByteArrayRegion(value,0,length,static_cast<jbyte*>(out));return !env->ExceptionCheck();}

void event_callback(void *context, const citizensdk_event_t *event) {
  if (context != nullptr && event != nullptr) {
    static_cast<CitizenSdkHostBridge *>(context)->dispatch_event(*event);
  }
}

}  // namespace

jboolean store_generation(JNIEnv *env,jclass,jobject host,jint action,jint index,jbyteArray generation,jbyteArray operation){
  try{DatabaseContext db{};env->GetJavaVM(&db.vm);db.host=host;db.secure=true;auto resource=database_config(db);
    citizensdk_host_wallet_key_ref_v1_t key{};key.struct_size=sizeof(key);key.abi_version=1;key.wallet_index=static_cast<uint32_t>(index);citizensdk_host_id128_t op{};uint8_t value=0;
    if(!id_bytes(env,generation,key.generation.bytes,16)||!id_bytes(env,operation,op.bytes,16)){throw_sdk(env,CITIZENSDK_ERROR_INVALID_ARGUMENT,"vault identity length differs");return JNI_FALSE;}
    const auto code=citizensdk_store_generation(&resource,static_cast<uint32_t>(action),&key,&op,&value);if(code!=kOk){throw_sdk(env,code,"Rust vault state failed");return JNI_FALSE;}return value?JNI_TRUE:JNI_FALSE;
  }catch(...){throw_sdk(env,kInternal,"vault state failed");return JNI_FALSE;}
}
jbyteArray store_generations(JNIEnv *env,jclass,jobject host){
  try{DatabaseContext db{};env->GetJavaVM(&db.vm);db.host=host;db.secure=true;auto resource=database_config(db);std::vector<citizensdk_host_wallet_key_ref_v1_t> keys(65536);uint64_t count=0;
    const auto code=citizensdk_store_generations(&resource,keys.data(),keys.size(),&count);if(code!=kOk){throw_sdk(env,code,"Rust vault enumeration failed");return nullptr;}if(count>keys.size()){throw_sdk(env,CITIZENSDK_ERROR_INTEGRITY,"vault count differs");return nullptr;}
    std::vector<uint8_t> bytes;bytes.reserve(static_cast<size_t>(count)*20);for(size_t i=0;i<static_cast<size_t>(count);++i){auto index=keys[i].wallet_index;for(unsigned shift=0;shift<32;shift+=8)bytes.push_back(static_cast<uint8_t>(index>>shift));bytes.insert(bytes.end(),std::begin(keys[i].generation.bytes),std::end(keys[i].generation.bytes));}return java_bytes(env,bytes.data(),bytes.size());
  }catch(...){throw_sdk(env,kInternal,"vault enumeration failed");return nullptr;}
}
jboolean store_has_secret(JNIEnv *env,jclass,jobject host,jbyteArray account){
  try{DatabaseContext db{};env->GetJavaVM(&db.vm);db.host=host;db.secure=true;auto resource=database_config(db);citizensdk_account_id_t id{};uint8_t value=0;
    if(!id_bytes(env,account,id.bytes,32)){throw_sdk(env,CITIZENSDK_ERROR_INVALID_ARGUMENT,"account length differs");return JNI_FALSE;}
    const auto code=citizensdk_store_has_secret(&resource,&id,&value);if(code!=kOk){throw_sdk(env,code,"Rust secret presence failed");return JNI_FALSE;}return value?JNI_TRUE:JNI_FALSE;
  }catch(...){throw_sdk(env,kInternal,"secret presence failed");return JNI_FALSE;}
}

CitizenSdkHostBridge::CitizenSdkHostBridge(JavaVM *vm, JNIEnv *env,
                                           jobject host_services)
    : vm_(vm), host_services_(env->NewGlobalRef(host_services)) {
  public_context_={vm_,host_services_,false};secure_context_={vm_,host_services_,true};
  database_=database_config(public_context_);secure_database_=database_config(secure_context_);

  vault_.struct_size = sizeof(vault_);
  vault_.abi_version = CITIZENSDK_ABI_VERSION;
  vault_.context = this;
  vault_.availability = vault_availability;
  vault_.ensure_wallet_kek = vault_ensure;
  vault_.has_wallet_kek = vault_has;
  vault_.wrap_dek = vault_wrap;
  vault_.unwrap_dek = vault_unwrap;
  vault_.retire_wallet_kek = vault_retire;
  vault_.authorize_add_accounts = vault_authorize_add_accounts;


}

CitizenSdkHostBridge::~CitizenSdkHostBridge() {
  ScopedEnv scoped(vm_);
  if (scoped.env != nullptr) {
    if (native_owner_ != nullptr) scoped.env->DeleteGlobalRef(native_owner_);
    if (host_services_ != nullptr) scoped.env->DeleteGlobalRef(host_services_);
  }
}

bool CitizenSdkHostBridge::create(JNIEnv *env,
                                  const std::vector<uint8_t> &manifest,
                                  const std::vector<uint8_t> &chain_spec,
                                  const std::vector<uint8_t> &sync_state, uint32_t modules) {
  citizensdk_create_options_t options{};
  options.struct_size = sizeof(options);
  options.abi_version = CITIZENSDK_ABI_VERSION;
  options.asset_manifest = view(manifest);
  options.chain_spec = view(chain_spec);
  options.light_sync_state = view(sync_state);
  static constexpr uint8_t kName[] = "CitizenSDK";
  static constexpr uint8_t kVersion[] = "1.0.0";
  options.system_name = {kName, sizeof(kName) - 1};
  options.system_version = {kVersion, sizeof(kVersion) - 1};
  // 只投影所选资源组；模块依赖和编译能力统一由 Rust 校验。
  const bool secrets = (modules & (CITIZENSDK_MODULE_WALLET | CITIZENSDK_MODULE_SIGNING)) != 0;
  const bool public_database = (modules & (CITIZENSDK_MODULE_CHAIN | CITIZENSDK_MODULE_HISTORY)) != 0;
  const citizensdk_stores_v1_t stores{sizeof(citizensdk_stores_v1_t),1,public_database?&database_:nullptr,secrets?&secure_database_:nullptr,secrets?&vault_:nullptr};
  int32_t code=citizensdk_create_with_store(&options,modules,&stores,&handle_);
  if (code == kOk && secrets) {
    const citizensdk_host_secret_presence_v1_t provider{sizeof(citizensdk_host_secret_presence_v1_t),
        CITIZENSDK_ABI_VERSION, this, account_secret_presence, wallet_key_presence};
    code = citizensdk_set_secret_presence_provider(handle_, &provider);
  }
  if (code != kOk) {
    throw_sdk(env, code, "CitizenSDK Core creation failed");
    return false;
  }
  return true;
}

bool CitizenSdkHostBridge::bind(JNIEnv *env, jobject native_owner) {
  if (native_owner_ != nullptr) {
    throw_sdk(env, CITIZENSDK_ERROR_INVALID_STATE,
              "CitizenSDK native callback is already bound");
    return false;
  }
  native_owner_ = env->NewGlobalRef(native_owner);
  if (native_owner_ == nullptr) return false;
  int32_t code = citizensdk_set_event_callback(handle_, event_callback, this);
  callback_bound_ = code == kOk;
  if (code == kOk) {
    code = citizensdk_subscribe_capability_changes(handle_);
    capability_subscribed_ = code == kOk;
  }
  if (code != kOk) {
    if (callback_bound_ &&
        citizensdk_set_event_callback(handle_, nullptr, nullptr) == kOk) {
      callback_bound_ = false;
    }
    if (!callback_bound_) {
      env->DeleteGlobalRef(native_owner_);
      native_owner_ = nullptr;
    }
    throw_sdk(env, code, "CitizenSDK callback binding failed");
    return false;
  }
  return true;
}

bool CitizenSdkHostBridge::destroy(JNIEnv *env) {
  {
    std::lock_guard<std::mutex> lock(inspection_mutex_);
    if (!inspection_requests_.empty()) {
      throw_sdk(env, CITIZENSDK_ERROR_BUSY, "钱包检查请求尚未排空"); return false;
    }
    // SDK关闭也回收未被上层领取的检查结果，避免丢失页面引用后永久BUSY。
    for (auto it = wallet_inspections_.begin(); it != wallet_inspections_.end();) {
      const auto code = citizensdk_result_release(*it);
      if (code != kOk) { throw_sdk(env, code, "钱包检查资源释放失败"); return false; }
      it = wallet_inspections_.erase(it);
    }
  }
  {
    std::lock_guard<std::mutex> lock(qr_mutex_);
    if (!qr_reviews_.empty()) {
      throw_sdk(env, CITIZENSDK_ERROR_BUSY, "CitizenSDK QR review is still owned by its window");
      return false;
    }
  }
  {
    std::lock_guard<std::mutex> lock(vault_status_mutex_);
    if (!vault_status_operations_.empty()) {
      throw_sdk(env, CITIZENSDK_ERROR_BUSY,
                "CitizenSDK hardware authentication is still pending");
      return false;
    }
  }
  while (true) {
    uint64_t token = 0;
    citizensdk_prepared_wallet_handle_t prepared = 0;
    {
      std::lock_guard<std::mutex> lock(prepared_mutex_);
      if (prepared_.empty()) break;
      token = prepared_.begin()->first;
      prepared = prepared_.begin()->second;
    }
    const int32_t code = citizensdk_prepared_wallet_release(handle_, prepared);
    if (code != kOk) {
      throw_sdk(env, code, "CitizenSDK prepared wallet is busy");
      return false;
    }
    std::lock_guard<std::mutex> lock(prepared_mutex_);
    const auto found = prepared_.find(token);
    if (found != prepared_.end() && found->second == prepared) {
      prepared_.erase(found);
    }
  }
  if (native_owner_ != nullptr) {
    if (capability_subscribed_) {
      const int32_t code = citizensdk_unsubscribe_capability_changes(handle_);
      if (code != kOk) {
        throw_sdk(env, code, "CitizenSDK capability monitor is busy");
        return false;
      }
      capability_subscribed_ = false;
    }
    if (callback_bound_) {
      const int32_t code = citizensdk_set_event_callback(handle_, nullptr, nullptr);
      if (code != kOk) {
        throw_sdk(env, code, "CitizenSDK callback could not be cleared");
        return false;
      }
      callback_bound_ = false;
    }
  }
  const int32_t code = citizensdk_destroy(handle_);
  if (code != kOk) {
    throw_sdk(env, code, "CitizenSDK destruction failed");
    return false;
  }
  handle_ = 0;
  if (native_owner_ != nullptr) {
    env->DeleteGlobalRef(native_owner_);
    native_owner_ = nullptr;
  }
  return true;
}

uint64_t CitizenSdkHostBridge::allocate_prepared_token() {
  uint64_t current = next_prepared_.load();
  while (current != 0 && current != std::numeric_limits<uint64_t>::max()) {
    if (next_prepared_.compare_exchange_weak(current, current + 1)) return current;
  }
  return 0;
}

void CitizenSdkHostBridge::remember_prepared(
    uint64_t token, citizensdk_prepared_wallet_handle_t handle) {
  std::lock_guard<std::mutex> lock(prepared_mutex_);
  prepared_.emplace(token, handle);
}

bool CitizenSdkHostBridge::prepared(
    uint64_t token, citizensdk_prepared_wallet_handle_t *out) const {
  std::lock_guard<std::mutex> lock(prepared_mutex_);
  const auto found = prepared_.find(token);
  if (found == prepared_.end()) return false;
  *out = found->second;
  return true;
}

bool CitizenSdkHostBridge::forget_prepared(
    uint64_t token, citizensdk_prepared_wallet_handle_t *out) {
  std::lock_guard<std::mutex> lock(prepared_mutex_);
  const auto found = prepared_.find(token);
  if (found == prepared_.end()) return false;
  *out = found->second;
  prepared_.erase(found);
  return true;
}

void CitizenSdkHostBridge::remember_vault_status(
    uint64_t operation_id, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion) {
  std::lock_guard<std::mutex> lock(vault_status_mutex_);
  vault_status_operations_.emplace(operation_id, PendingVaultStatus{sdk_context, completion});
}

bool CitizenSdkHostBridge::reject_vault_status(uint64_t operation_id) {
  std::lock_guard<std::mutex> lock(vault_status_mutex_);
  return vault_status_operations_.erase(operation_id) == 1;
}

void CitizenSdkHostBridge::complete_vault_status(uint64_t operation_id,
                                           int32_t error_code) {
  PendingVaultStatus pending{};
  {
    std::lock_guard<std::mutex> lock(vault_status_mutex_);
    const auto found = vault_status_operations_.find(operation_id);
    if (found == vault_status_operations_.end()) return;
    pending = found->second;
    vault_status_operations_.erase(found);
  }
  complete_status(operation_id, pending.sdk_context, pending.completion,
                  error_code);
}

int32_t CitizenSdkHostBridge::inspect_wallets(citizensdk_request_id_t *out) {
  // 与真实请求接纳共锁，完成回调不能早于标记登记；不分配第二请求编号。
  std::lock_guard<std::mutex> lock(inspection_mutex_);
  if (inspection_requests_.size() + wallet_inspections_.size() >= 64) return CITIZENSDK_ERROR_QUEUE_FULL;
  const auto code = citizensdk_get_wallet_state(handle_, out);
  if (code == kOk) inspection_requests_.insert(*out);
  return code;
}

bool CitizenSdkHostBridge::has_wallet_inspection(uint64_t result) const {
  std::lock_guard<std::mutex> lock(inspection_mutex_);
  return wallet_inspections_.count(result) != 0;
}

int32_t CitizenSdkHostBridge::release_wallet_inspection(uint64_t result) {
  std::lock_guard<std::mutex> lock(inspection_mutex_);
  if (wallet_inspections_.count(result) == 0) return CITIZENSDK_ERROR_NOT_FOUND;
  const auto code = citizensdk_result_release(result);
  if (code == kOk) wallet_inspections_.erase(result);
  return code;
}

bool CitizenSdkHostBridge::has_qr_review(uint64_t result) const {
  std::lock_guard<std::mutex> lock(qr_mutex_);
  return qr_reviews_.count(result) != 0;
}

void CitizenSdkHostBridge::release_qr_review(uint64_t result) {
  bool owned;
  { std::lock_guard<std::mutex> lock(qr_mutex_); owned = qr_reviews_.erase(result) != 0; }
  if (owned) citizensdk_result_release(result);
}

void CitizenSdkHostBridge::dispatch_event(const citizensdk_event_t &event) {
  if (native_owner_ == nullptr) return;
  ScopedEnv scoped(vm_);
  if (scoped.env == nullptr) return;
  JNIEnv *env = scoped.env;
  jclass type = env->GetObjectClass(native_owner_);
  if (event.event_type == CITIZENSDK_EVENT_REQUEST_COMPLETED) {
    auto result_info = citizensdk_result_info_t{};
    result_info.struct_size = sizeof(result_info);
    result_info.abi_version = CITIZENSDK_ABI_VERSION;
    const bool is_prepared =
        citizensdk_result_get_info(event.result, &result_info) == kOk &&
        result_info.error_code == kOk &&
        result_info.kind == CITIZENSDK_RESULT_PREPARED_WALLET;
    bool inspection = false;
    {
      std::lock_guard<std::mutex> lock(inspection_mutex_);
      const bool requested = inspection_requests_.erase(event.request_id) != 0;
      inspection = requested && result_info.error_code == kOk &&
          result_info.kind == CITIZENSDK_RESULT_WALLET_STATE;
      if (inspection) wallet_inspections_.insert(event.result);
    }
    const uint64_t token = is_prepared ? allocate_prepared_token() : 0;
    citizensdk_prepared_wallet_handle_t prepared_handle = 0;
    bool qr_review = false;
    WireWriter writer;
    const bool requested_inspection = inspection;
    const bool encoded = encode_result(event.result, token, &writer,
                                       &prepared_handle, &qr_review, &inspection);
    if (requested_inspection && !inspection) {
      // 编码可能返回合法错误信封；其中没有资源号，不得保留无法交付的Core结果。
      std::lock_guard<std::mutex> lock(inspection_mutex_);
      wallet_inspections_.erase(event.result);
    }
    // 审阅结果本身是 Core 一次性凭证；不能按普通 JSON 结果提前释放。
    if (qr_review && encoded) {
      std::lock_guard<std::mutex> lock(qr_mutex_);
      qr_reviews_.insert(event.result);
    } else if (!inspection) { citizensdk_result_release(event.result); }
    if (!encoded) {
      if (inspection) (void)release_wallet_inspection(event.result);
      env->DeleteLocalRef(type);
      return;
    }
    if (prepared_handle != 0) {
      if (token == 0) {
        citizensdk_prepared_wallet_release(handle_, prepared_handle);
      } else {
        remember_prepared(token, prepared_handle);
      }
    }
    jmethodID method = env->GetMethodID(type, "onNativeRequestCompleted", "(J[B)Z");
    jbyteArray bytes = to_byte_array(env, writer.data());
    jboolean accepted = JNI_FALSE;
    if (method != nullptr && bytes != nullptr) {
      accepted = env->CallBooleanMethod(native_owner_, method,
                          static_cast<jlong>(event.request_id), bytes);
    }
    if (qr_review && (accepted != JNI_TRUE || env->ExceptionCheck())) release_qr_review(event.result);
    if (inspection && (accepted != JNI_TRUE || env->ExceptionCheck())) (void)release_wallet_inspection(event.result);
    if (bytes != nullptr) env->DeleteLocalRef(bytes);
  } else if (event.event_type == CITIZENSDK_EVENT_WATCH_UPDATE) {
    WireWriter writer;
    const bool encoded = encode_watch(event.result, &writer);
    citizensdk_result_release(event.result);
    if (encoded) {
      jmethodID method = env->GetMethodID(type, "onNativeWatch", "(JJ[B)V");
      jbyteArray bytes = to_byte_array(env, writer.data());
      if (method != nullptr && bytes != nullptr) {
        env->CallVoidMethod(native_owner_, method,
                            static_cast<jlong>(event.request_id),
                            static_cast<jlong>(event.sequence), bytes);
      }
      if (bytes != nullptr) env->DeleteLocalRef(bytes);
    }
  } else if (event.event_type == CITIZENSDK_EVENT_CAPABILITIES_CHANGED) {
    WireWriter writer;
    if (encode_capabilities(handle_, &writer)) {
      jmethodID method = env->GetMethodID(type, "onNativeCapabilities", "(J[B)V");
      jbyteArray bytes = to_byte_array(env, writer.data());
      if (method != nullptr && bytes != nullptr) {
        env->CallVoidMethod(native_owner_, method,
                            static_cast<jlong>(event.sequence), bytes);
      }
      if (bytes != nullptr) env->DeleteLocalRef(bytes);
    }
  } else if (event.event_type == CITIZENSDK_EVENT_HISTORY_CHANGED &&
             event.request_id == 0 && event.result == 0 &&
             event.capability_revision == 0 && event.reserved == 0) {
    jmethodID method = env->GetMethodID(type, "onNativeHistoryChanged", "(J)V");
    if (method != nullptr) env->CallVoidMethod(native_owner_, method, static_cast<jlong>(event.sequence));
  } else if (event.event_type == CITIZENSDK_EVENT_WALLET_CHANGED &&
             event.request_id == 0 && event.result == 0 &&
             event.capability_revision == 0 && event.reserved == 0) {
    jmethodID method = env->GetMethodID(type, "onNativeWalletChanged", "(J)V");
    if (method != nullptr) env->CallVoidMethod(native_owner_, method, static_cast<jlong>(event.sequence));
  } else if (event.event_type == CITIZENSDK_EVENT_FINALIZED_BLOCK_CHANGED) {
    if (event.request_id == 0 && event.result != 0 &&
        event.capability_revision == 0 && event.reserved == 0) {
      WireWriter writer;
      citizensdk_prepared_wallet_handle_t prepared = 0;
      bool qr_review = false;
      const bool encoded = encode_result(event.result, 0, &writer, &prepared, &qr_review);
      citizensdk_result_release(event.result);
      if (encoded && prepared == 0 && !qr_review) {
        jmethodID method = env->GetMethodID(type, "onNativeFinalizedBlockChanged", "(J[B)V");
        jbyteArray bytes = to_byte_array(env, writer.data());
        if (method != nullptr && bytes != nullptr) {
          env->CallVoidMethod(native_owner_, method,
                              static_cast<jlong>(event.sequence), bytes);
        }
        if (bytes != nullptr) env->DeleteLocalRef(bytes);
      }
    } else if (event.result != 0) {
      citizensdk_result_release(event.result);
    }
  } else if (event.event_type == CITIZENSDK_EVENT_LIFECYCLE_CHANGED) {
    citizensdk_lifecycle_t lifecycle = 0;
    if (citizensdk_get_lifecycle(handle_, &lifecycle) == kOk) {
      jmethodID method = env->GetMethodID(type, "onNativeLifecycle", "(JI)V");
      if (method != nullptr) {
        env->CallVoidMethod(native_owner_, method,
                            static_cast<jlong>(event.sequence),
                            static_cast<jint>(lifecycle));
      }
    }
  }
  if (env->ExceptionCheck()) env->ExceptionClear();
  env->DeleteLocalRef(type);
}

}  // namespace citizen::sdk::jni
