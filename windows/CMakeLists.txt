cmake_minimum_required(VERSION 3.24)
project(CitizenSDKHost VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "CitizenSDK Windows Host requires the Windows MSVC 64-bit toolchain")
endif()
if(DEFINED CMAKE_GENERATOR_PLATFORM AND NOT CMAKE_GENERATOR_PLATFORM STREQUAL "" AND
   NOT CMAKE_GENERATOR_PLATFORM STREQUAL "x64")
  message(FATAL_ERROR "CitizenSDK Windows machine target is x86_64-pc-windows-msvc")
endif()
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

set(CITIZENSDK_PLATFORM "Windows" CACHE STRING "Public CitizenSDK platform identity")
if(NOT CITIZENSDK_PLATFORM STREQUAL "Windows")
  message(FATAL_ERROR "CITIZENSDK_PLATFORM must be exactly Windows")
endif()
set(CITIZENSDK_CORE_LIBRARY "" CACHE FILEPATH "Matching citizensdk.dll")
set(CITIZENSDK_CORE_IMPORT_LIBRARY "" CACHE FILEPATH "Matching citizensdk.dll.lib")
set(CITIZENSDK_CORE_INCLUDE_DIR "${CMAKE_CURRENT_LIST_DIR}/../include" CACHE PATH "Core public headers")
set(CITIZENSDK_INTERNAL_INCLUDE_DIR "" CACHE PATH "本轮构建生成的 SDK 私有声明目录；不安装")
set(CITIZENSDK_ASSET_DIR "${CMAKE_CURRENT_LIST_DIR}/../chain" CACHE PATH "Canonical chain assets")
set(CITIZENSDK_SQLITE_INCLUDE_DIR "" CACHE PATH "Pinned SQLite headers")
set(CITIZENSDK_SQLITE_ARCHIVE "" CACHE FILEPATH "Pinned MSVC SQLite static archive")
set(CITIZENSDK_ZXING_SOURCE_DIR "" CACHE PATH "Official complete ZXing-C++ 3.1.1 source directory")
option(CITIZENSDK_BUILD_TESTS "Build Windows Host contract tests" OFF)
option(CITIZENSDK_WARNINGS_AS_ERRORS "Treat Windows Host warnings as errors" ON)

# Flutter 只连接同版已安装 Host/Core，不能落入下方原生生产编译分支。
if(TARGET flutter)
  include(cmake/CitizenSDKFlutter.cmake)
  return()
endif()

if(NOT IS_ABSOLUTE "${CITIZENSDK_INTERNAL_INCLUDE_DIR}" OR
   NOT EXISTS "${CITIZENSDK_INTERNAL_INCLUDE_DIR}/citizensdk_internal.h")
  message(FATAL_ERROR "CITIZENSDK_INTERNAL_INCLUDE_DIR must contain the generated private header")
endif()
foreach(_file CITIZENSDK_CORE_LIBRARY CITIZENSDK_CORE_IMPORT_LIBRARY CITIZENSDK_SQLITE_ARCHIVE)
  if(NOT IS_ABSOLUTE "${${_file}}" OR NOT EXISTS "${${_file}}" OR IS_DIRECTORY "${${_file}}")
    message(FATAL_ERROR "${_file} must be an existing absolute file")
  endif()
endforeach()
get_filename_component(_core_name "${CITIZENSDK_CORE_LIBRARY}" NAME)
get_filename_component(_core_import_name "${CITIZENSDK_CORE_IMPORT_LIBRARY}" NAME)
if(NOT _core_name STREQUAL "citizensdk.dll" OR NOT _core_import_name STREQUAL "citizensdk.dll.lib")
  message(FATAL_ERROR "Core DLL/import-library names must match the Rust MSVC output")
endif()
foreach(_header citizensdk.h citizensdk_types.h)
  if(NOT EXISTS "${CITIZENSDK_CORE_INCLUDE_DIR}/${_header}")
    message(FATAL_ERROR "CitizenSDK Core header is missing: ${_header}")
  endif()
endforeach()
if(NOT IS_ABSOLUTE "${CITIZENSDK_SQLITE_INCLUDE_DIR}" OR
   NOT EXISTS "${CITIZENSDK_SQLITE_INCLUDE_DIR}/sqlite3.h")
  message(FATAL_ERROR "Pinned SQLite include directory is required")
endif()
foreach(_asset manifest.json chainspec.json light_sync_state.json)
  if(NOT EXISTS "${CITIZENSDK_ASSET_DIR}/${_asset}")
    message(FATAL_ERROR "CitizenChain asset is missing: ${_asset}")
  endif()
endforeach()

add_library(citizensdk_core SHARED IMPORTED GLOBAL)
set_target_properties(citizensdk_core PROPERTIES
  IMPORTED_LOCATION "${CITIZENSDK_CORE_LIBRARY}"
  IMPORTED_IMPLIB "${CITIZENSDK_CORE_IMPORT_LIBRARY}"
  INTERFACE_INCLUDE_DIRECTORIES "${CITIZENSDK_CORE_INCLUDE_DIR}")
add_library(CitizenSDK::Core ALIAS citizensdk_core)

# Windows 与其它四端使用相同的 SDK 窄包装和完整官方 ZXing-C++ 源码输入。
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../native/qr-image"
                 "${CMAKE_CURRENT_BINARY_DIR}/citizensdk-qr-image")

set(CITIZENSDK_HOST_SOURCES
  src/citizen_sdk_assets.cc
  src/citizen_sdk_host_api.cc
  src/citizen_sdk_host_bridge.cc
  src/citizen_sdk_host_record.cc
  src/citizen_sdk_window.cc
  src/citizen_sdk_input_limits.cc
  src/citizen_sdk_lifecycle.cc
  src/citizen_sdk_operation.cc
  src/citizen_sdk_directory.cc
  src/citizen_sdk_public_store.cc
  src/citizen_sdk_record_key.cc
  src/citizen_sdk_secure_store.cc
  src/citizen_sdk_sensitive_buffer.cc
  src/citizen_sdk_secret_vault.cc
  src/citizen_sdk_sqlite.cc
  src/citizen_sdk_cng.cc
  src/citizen_sdk_user_auth.cc
  src/citizen_sdk_qr_camera.cc
)

add_library(citizensdk_host SHARED ${CITIZENSDK_HOST_SOURCES} cmake/citizensdk_host.def)
add_library(CitizenSDK::Host ALIAS citizensdk_host)
target_compile_features(citizensdk_host PUBLIC cxx_std_17)
target_compile_definitions(citizensdk_host PRIVATE
  WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE _WIN32_WINNT=0x0A00
  CITIZENSDK_HOST_BUILDING=1 CITIZENSDK_HOST_VERSION="${PROJECT_VERSION}")
target_include_directories(citizensdk_host PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_LIST_DIR}>
  $<BUILD_INTERFACE:${CITIZENSDK_CORE_INCLUDE_DIR}>
  $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
  PRIVATE src "${CITIZENSDK_INTERNAL_INCLUDE_DIR}" "${CITIZENSDK_SQLITE_INCLUDE_DIR}")
target_link_libraries(citizensdk_host PUBLIC
  "$<BUILD_INTERFACE:citizensdk_core>" "$<INSTALL_INTERFACE:CitizenSDK::Core>"
  PRIVATE CitizenSDK::QrImage "${CITIZENSDK_SQLITE_ARCHIVE}" winbio ncrypt bcrypt tbs advapi32 user32 gdi32 comctl32 ntdll wtsapi32 mfplat mfreadwrite mfuuid ole32 windowscodecs)
target_compile_options(citizensdk_host PRIVATE /W4 /permissive- /utf-8 /EHsc
  $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:/WX>)
target_link_options(citizensdk_host PRIVATE /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA)
set_target_properties(citizensdk_host PROPERTIES EXPORT_NAME Host OUTPUT_NAME citizensdk_host)

# 只导出 C ABI。C++ header-only 所有权包装不暴露 STL 或编译器专属符号。
install(TARGETS citizensdk_host EXPORT CitizenSDKTargets
  RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}/Windows"
  ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}/Windows")
install(FILES "${CITIZENSDK_CORE_LIBRARY}" DESTINATION "${CMAKE_INSTALL_BINDIR}/Windows")
install(FILES "${CITIZENSDK_CORE_IMPORT_LIBRARY}" DESTINATION "${CMAKE_INSTALL_LIBDIR}/Windows")
install(FILES "${CITIZENSDK_CORE_INCLUDE_DIR}/citizensdk.h"
  "${CITIZENSDK_CORE_INCLUDE_DIR}/citizensdk_types.h"
  "${CMAKE_CURRENT_LIST_DIR}/../native/qr-image/citizensdk_qr_image.h"
  DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
# Flutter 注册头只供 generated registrant 使用，不进入纯原生七头安装合同。
install(DIRECTORY citizen_sdk DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}"
  PATTERN "citizen_sdk_plugin.h" EXCLUDE)
install(FILES "${CITIZENSDK_ASSET_DIR}/manifest.json" "${CITIZENSDK_ASSET_DIR}/chainspec.json"
  "${CITIZENSDK_ASSET_DIR}/light_sync_state.json" DESTINATION "${CMAKE_INSTALL_DATADIR}/citizensdk/chain")
set(CITIZENSDK_PACKAGE_INSTALL_DIR "${CMAKE_INSTALL_LIBDIR}/Windows/cmake/CitizenSDK")
configure_package_config_file(cmake/CitizenSDKConfig.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfig.cmake"
  INSTALL_DESTINATION "${CITIZENSDK_PACKAGE_INSTALL_DIR}"
  PATH_VARS CMAKE_INSTALL_INCLUDEDIR CMAKE_INSTALL_LIBDIR CMAKE_INSTALL_BINDIR CMAKE_INSTALL_DATADIR)
configure_file(cmake/CitizenSDKConfigVersion.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfigVersion.cmake" @ONLY)
install(EXPORT CitizenSDKTargets FILE CitizenSDKTargets.cmake NAMESPACE CitizenSDK::
  DESTINATION "${CITIZENSDK_PACKAGE_INSTALL_DIR}")
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfigVersion.cmake" cmake/CitizenSDKDependencies.cmake
  DESTINATION "${CITIZENSDK_PACKAGE_INSTALL_DIR}")
if(CITIZENSDK_BUILD_TESTS)
  enable_testing()
  add_subdirectory(test)
endif()
