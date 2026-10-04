cmake_minimum_required(VERSION 3.24)

# 独立消费者只从本轮安装前缀取得公开头与双库；提前返回，绝不落入
# 下方 Host 内部合同测试的生产源码编译分支。
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(CitizenSDKConsumer LANGUAGES C CXX)
  include(CitizenSDKConsumer.cmake)
  return()
endif()

# Linux 合同测试直接编译与正式 Host 相同的生产源码；不维护测试专用实现。
find_package(Threads REQUIRED)

# 测试状态必须由调用方放进本次任务独占的源码外构建目录。
# 此处只消费一个已存在、绝对且非根的目录；测试 helper 会在运行时再次
# 逐级 no-follow 校验所有权和 0700 权限，并且绝不回退到 /tmp。
set(CITIZENSDK_TEST_WORK_DIR "" CACHE PATH
  "Required task-exclusive CitizenSDK test root outside the source tree")
if(CITIZENSDK_TEST_WORK_DIR STREQUAL "" OR
   NOT IS_ABSOLUTE "${CITIZENSDK_TEST_WORK_DIR}" OR
   CITIZENSDK_TEST_WORK_DIR STREQUAL "/" OR
   NOT IS_DIRECTORY "${CITIZENSDK_TEST_WORK_DIR}")
  message(FATAL_ERROR
    "CITIZENSDK_TEST_WORK_DIR must be an existing task-exclusive absolute directory")
endif()

# Flutter路径复用同一无UI适配层；钱包输入回归直接调用唯一Core。
# 运行态只链接同版Host/Core，不编译退役窗口校验器或下载测试框架。
if(TARGET citizen_sdk_plugin)
  set(CITIZENSDK_LINUX_FLUTTER_CONTRACT_TESTS
    citizen_sdk_flutter_codec_test
    citizen_sdk_flutter_sessions_test
    citizen_sdk_flutter_wallet_flow_test
    citizen_sdk_flutter_environment_test
    citizen_sdk_flutter_plugin_test
    citizen_sdk_flutter_secret_boundary_test
  )
  add_library(citizensdk_linux_flutter_test_support STATIC
    ${CITIZENSDK_FLUTTER_ADAPTER_SOURCES})
  target_compile_features(citizensdk_linux_flutter_test_support PUBLIC cxx_std_17)
  target_compile_definitions(citizensdk_linux_flutter_test_support PRIVATE FLUTTER_PLUGIN_IMPL)
  target_include_directories(citizensdk_linux_flutter_test_support PUBLIC
    "${CMAKE_CURRENT_LIST_DIR}/.."
    "${CMAKE_CURRENT_LIST_DIR}/../src")
  target_link_libraries(citizensdk_linux_flutter_test_support PUBLIC
    flutter CitizenSDK::Host Threads::Threads)
  target_compile_options(citizensdk_linux_flutter_test_support PRIVATE
    -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
    $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:-Werror>)
  foreach(test_name IN LISTS CITIZENSDK_LINUX_FLUTTER_CONTRACT_TESTS)
    add_executable(${test_name} "${test_name}.cc")
    target_link_libraries(${test_name} PRIVATE citizensdk_linux_flutter_test_support)
    target_compile_definitions(${test_name} PRIVATE
      CITIZENSDK_LINUX_TEST_SOURCE_DIR="${CMAKE_CURRENT_LIST_DIR}/..")
    target_compile_options(${test_name} PRIVATE
      -UNDEBUG -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
      $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:-Werror>)
    add_test(NAME CitizenSDK.Linux.${test_name} COMMAND ${test_name})
    set_tests_properties(CitizenSDK.Linux.${test_name} PROPERTIES
      TIMEOUT 30 LABELS "CitizenSDK;LinuxFlutter;Contract"
      ENVIRONMENT "CITIZENSDK_TEST_WORK_DIR=${CITIZENSDK_TEST_WORK_DIR}")
  endforeach()
  return()
endif()

set(CITIZENSDK_LINUX_HOST_TEST_SOURCES
  ../src/citizen_sdk_assets.cc
  ../src/citizen_sdk_host_api.cc
  ../src/citizen_sdk_host_bridge.cc
  ../src/citizen_sdk_host_record.cc
  ../src/citizen_sdk_input_limits.cc
  ../src/citizen_sdk_lifecycle.cc
  ../src/citizen_sdk_operation.cc
  ../src/citizen_sdk_public_store.cc
  ../src/citizen_sdk_record_key.cc
  ../src/citizen_sdk_secure_store.cc
  ../src/citizen_sdk_sensitive_buffer.cc
  ../src/citizen_sdk_secret_vault.cc
  ../src/citizen_sdk_sqlite.cc
  ../src/citizen_sdk_tpm2.cc
  ../src/citizen_sdk_user_auth.cc
  ../src/citizen_sdk_qr_camera.cc
)

add_library(citizensdk_linux_test_support STATIC
  ${CITIZENSDK_LINUX_HOST_TEST_SOURCES}
)
target_compile_features(citizensdk_linux_test_support PUBLIC cxx_std_17)
target_compile_definitions(citizensdk_linux_test_support PRIVATE
  _GNU_SOURCE=1
  CITIZENSDK_HOST_BUILDING=1
  CITIZENSDK_ENABLE_QR_CAPTURE=$<BOOL:${CITIZENSDK_ENABLE_QR_CAPTURE}>
  CITIZENSDK_HOST_VERSION="${PROJECT_VERSION}"
)
target_include_directories(citizensdk_linux_test_support
  PUBLIC
    "${CMAKE_CURRENT_LIST_DIR}/.."
    "${CMAKE_CURRENT_LIST_DIR}/../src"
    "${CITIZENSDK_CORE_INCLUDE_DIR}"
  PRIVATE
    "${CITIZENSDK_INTERNAL_INCLUDE_DIR}"
    "${CITIZENSDK_SQLITE_INCLUDE_DIR}"
    "${CITIZENSDK_OPENSSL_INCLUDE_DIR}"
    "${CITIZENSDK_TSS2_INCLUDE_DIR}"
)
target_link_libraries(citizensdk_linux_test_support PUBLIC
  CitizenSDK::Core
  CitizenSDK::QrImage
  "$<LINK_GROUP:RESCAN,${CITIZENSDK_SQLITE_ARCHIVE},${CITIZENSDK_CRYPTO_ARCHIVE},${CITIZENSDK_TSS2_ESYS_ARCHIVE},${CITIZENSDK_TSS2_MU_ARCHIVE},${CITIZENSDK_TSS2_SYS_ARCHIVE},${CITIZENSDK_TSS2_RC_ARCHIVE},${CITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE}>"
  PkgConfig::GLIB
  Threads::Threads
  ${CMAKE_DL_LIBS}
)
if(CITIZENSDK_ENABLE_QR_CAPTURE)
  target_link_libraries(citizensdk_linux_test_support PUBLIC PkgConfig::GTK3 PkgConfig::GSTREAMER)
endif()
target_compile_options(citizensdk_linux_test_support PRIVATE
  -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
  $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:-Werror>
)

set(CITIZENSDK_LINUX_CONTRACT_TESTS
  citizen_sdk_api_contract_test
  citizen_sdk_assets_test
  citizen_sdk_host_operation_test
  citizen_sdk_lifecycle_test
  citizen_sdk_public_store_test
  citizen_sdk_record_key_test
  citizen_sdk_secure_store_test
  citizen_sdk_sensitive_buffer_test
  citizen_sdk_secret_vault_test
  citizen_sdk_secret_boundary_test
  citizen_sdk_tpm2_test
  citizen_sdk_wallet_flow_test
)

foreach(test_name IN LISTS CITIZENSDK_LINUX_CONTRACT_TESTS)
  add_executable(${test_name} "${test_name}.cc")
  target_link_libraries(${test_name} PRIVATE citizensdk_linux_test_support)
  target_compile_features(${test_name} PRIVATE cxx_std_17)
  # 用例会直接包含 Host 内部合同头；第三方 include 仍只对测试目标可见，
  # 不会扩大已安装的 C/C++ 公开表面。
  target_include_directories(${test_name} PRIVATE
    "${CITIZENSDK_SQLITE_INCLUDE_DIR}"
    "${CITIZENSDK_OPENSSL_INCLUDE_DIR}"
    "${CITIZENSDK_TSS2_INCLUDE_DIR}"
  )
  target_compile_definitions(${test_name} PRIVATE
    CITIZENSDK_LINUX_TEST_SOURCE_DIR="${CMAKE_CURRENT_LIST_DIR}/.."
    CITIZENSDK_ENABLE_QR_CAPTURE=$<BOOL:${CITIZENSDK_ENABLE_QR_CAPTURE}>
  )
  target_compile_options(${test_name} PRIVATE
    # 主流程以 Release 构建 Host；合同测试必须显式撤销 CMake Release 的
    # `-DNDEBUG`，否则标准 assert 会被静默编译为空操作。
    -UNDEBUG
    -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
    $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:-Werror>
  )
  add_test(NAME CitizenSDK.Linux.${test_name} COMMAND ${test_name})
  set_tests_properties(CitizenSDK.Linux.${test_name} PROPERTIES
    TIMEOUT 30
    LABELS "CitizenSDK;LinuxHost;Contract"
    ENVIRONMENT "CITIZENSDK_TEST_WORK_DIR=${CITIZENSDK_TEST_WORK_DIR}"
  )
endforeach()
