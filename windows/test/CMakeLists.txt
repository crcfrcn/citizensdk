cmake_minimum_required(VERSION 3.24)

# 独立安装消费者提前返回：不得落入下方重新编译 Host 的合同测试分支。
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(CitizenSDKConsumer LANGUAGES C CXX)
  include(CitizenSDKConsumer.cmake)
  return()
endif()

# 只编译正式 Host 源码，不复制测试专用的存储、钱包或 CNG 实现。
set(CITIZENSDK_TEST_WORK_DIR "" CACHE PATH "Task-exclusive central Windows test state root")
if(CITIZENSDK_TEST_WORK_DIR STREQUAL "" OR
   NOT IS_ABSOLUTE "${CITIZENSDK_TEST_WORK_DIR}" OR
   CITIZENSDK_TEST_WORK_DIR MATCHES "^[A-Za-z]:[/\\\\]?$" OR
   (EXISTS "${CITIZENSDK_TEST_WORK_DIR}" AND NOT IS_DIRECTORY "${CITIZENSDK_TEST_WORK_DIR}"))
  message(FATAL_ERROR "CITIZENSDK_TEST_WORK_DIR must name a task-exclusive absolute directory")
endif()
# Flutter 测试编译适配层及钱包真实纯参数校验器，运行态连接安装的
# Host/Core，不重建核心；原生 14 项仍走下方分支。
if(TARGET citizen_sdk_plugin)
  set(CITIZENSDK_WINDOWS_FLUTTER_CONTRACT_TESTS
    citizen_sdk_flutter_codec_test
    citizen_sdk_flutter_environment_test
    citizen_sdk_flutter_sessions_test
    citizen_sdk_flutter_wallet_flow_test
    citizen_sdk_flutter_plugin_test
    citizen_sdk_flutter_secret_boundary_test)
  add_library(citizensdk_windows_flutter_test_support STATIC
    ${CITIZENSDK_FLUTTER_ADAPTER_SOURCES})
  citizensdk_configure_flutter_target(citizensdk_windows_flutter_test_support)
  # 仅测试夹具读取 SID/DACL；生产插件不增加这项测试专用依赖。
  target_link_libraries(citizensdk_windows_flutter_test_support PUBLIC advapi32)
  foreach(test_name IN LISTS CITIZENSDK_WINDOWS_FLUTTER_CONTRACT_TESTS)
    add_executable(${test_name} "${test_name}.cc")
    citizensdk_configure_flutter_target(${test_name})
    target_link_libraries(${test_name} PRIVATE citizensdk_windows_flutter_test_support)
    target_compile_definitions(${test_name} PRIVATE
      CITIZENSDK_WINDOWS_TEST_SOURCE_DIR="${CMAKE_CURRENT_LIST_DIR}/..")
    # 合同断言不能被 Release 的 NDEBUG 删除。
    target_compile_options(${test_name} PRIVATE /UNDEBUG)
    foreach(_library CitizenSDK::Core CitizenSDK::Host)
      add_custom_command(TARGET ${test_name} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:${_library}>" "$<TARGET_FILE_DIR:${test_name}>")
    endforeach()
    # 官方 flutter 是 INTERFACE target，DLL 路径来自 Flutter 的固定导出变量。
    add_custom_command(TARGET ${test_name} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${FLUTTER_LIBRARY}" "$<TARGET_FILE_DIR:${test_name}>")
    add_test(NAME CitizenSDK.Windows.${test_name} COMMAND ${test_name})
    set_tests_properties(CitizenSDK.Windows.${test_name} PROPERTIES TIMEOUT 60
      LABELS "CitizenSDK;WindowsFlutter;Contract"
      ENVIRONMENT "CITIZENSDK_TEST_WORK_DIR=${CITIZENSDK_TEST_WORK_DIR}")
  endforeach()
  return()
endif()

# 最终目录由测试使用的生产 Directory 创建并验证 SID/DACL，不使用 CMake mkdir。
set(_host_sources)
foreach(_source IN LISTS CITIZENSDK_HOST_SOURCES)
  list(APPEND _host_sources "${CMAKE_CURRENT_LIST_DIR}/../${_source}")
endforeach()
add_library(citizensdk_windows_test_support STATIC ${_host_sources})
target_compile_features(citizensdk_windows_test_support PUBLIC cxx_std_17)
target_compile_definitions(citizensdk_windows_test_support PUBLIC
  WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE _WIN32_WINNT=0x0A00 CITIZENSDK_HOST_BUILDING=1)
target_compile_definitions(citizensdk_windows_test_support PRIVATE CITIZENSDK_HOST_VERSION="${PROJECT_VERSION}")
target_include_directories(citizensdk_windows_test_support PUBLIC
  "${CMAKE_CURRENT_LIST_DIR}/.." "${CMAKE_CURRENT_LIST_DIR}/../src"
  "${CITIZENSDK_CORE_INCLUDE_DIR}" "${CITIZENSDK_SQLITE_INCLUDE_DIR}"
  PRIVATE "${CITIZENSDK_INTERNAL_INCLUDE_DIR}")
target_compile_options(citizensdk_windows_test_support PRIVATE /W4 /permissive- /utf-8 /EHsc
  $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:/WX>)
target_link_libraries(citizensdk_windows_test_support PUBLIC CitizenSDK::Core CitizenSDK::QrImage
  "${CITIZENSDK_SQLITE_ARCHIVE}" ncrypt bcrypt tbs advapi32 user32 gdi32 comctl32 ntdll wtsapi32 mfplat mfreadwrite mfuuid ole32 windowscodecs)

set(CITIZENSDK_WINDOWS_CONTRACT_TESTS
  citizen_sdk_api_contract_test
  citizen_sdk_assets_test
  citizen_sdk_host_operation_test
  citizen_sdk_lifecycle_test
  citizen_sdk_directory_test
  citizen_sdk_public_store_test
  citizen_sdk_record_key_test
  citizen_sdk_secure_store_test
  citizen_sdk_sensitive_buffer_test
  citizen_sdk_secret_vault_test
  citizen_sdk_secret_boundary_test
  citizen_sdk_cng_test
  citizen_sdk_user_auth_test
  citizen_sdk_wallet_flow_test)
foreach(test_name IN LISTS CITIZENSDK_WINDOWS_CONTRACT_TESTS)
  add_executable(${test_name} "${test_name}.cc")
  target_link_libraries(${test_name} PRIVATE citizensdk_windows_test_support)
  target_compile_definitions(${test_name} PRIVATE
    CITIZENSDK_WINDOWS_TEST_SOURCE_DIR="${CMAKE_CURRENT_LIST_DIR}/..")
  # Release 默认的 NDEBUG 必须撤销，否则 assert 会被静默删除。
  target_compile_options(${test_name} PRIVATE /UNDEBUG /W4 /permissive- /utf-8 /EHsc
    $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:/WX>)
  add_custom_command(TARGET ${test_name} POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CITIZENSDK_CORE_LIBRARY}" "$<TARGET_FILE_DIR:${test_name}>")
  add_test(NAME CitizenSDK.Windows.${test_name} COMMAND ${test_name})
  set_tests_properties(CitizenSDK.Windows.${test_name} PROPERTIES TIMEOUT 120
    LABELS "CitizenSDK;WindowsHost;Contract"
    ENVIRONMENT "CITIZENSDK_TEST_WORK_DIR=${CITIZENSDK_TEST_WORK_DIR}")
endforeach()
