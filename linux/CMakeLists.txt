cmake_minimum_required(VERSION 3.24)

project(CitizenSDKHost VERSION 1.0.0 LANGUAGES C CXX)

# 使用标准 C++，避免 GNU 扩展模式预定义的 linux 宏改写内部命名空间；
# 同时约束 Host 与下级测试目标，不依赖调用方的默认编译方言。
set(CMAKE_CXX_EXTENSIONS OFF)

include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

set(CITIZENSDK_PLATFORM "" CACHE STRING "Public CitizenSDK platform identity: LinuxARM or LinuxAMD")
set_property(CACHE CITIZENSDK_PLATFORM PROPERTY STRINGS LinuxARM LinuxAMD)
set(CITIZENSDK_CORE_LIBRARY "" CACHE FILEPATH "Absolute path to the matching libcitizensdk.so")
set(CITIZENSDK_CORE_INCLUDE_DIR "${CMAKE_CURRENT_LIST_DIR}/../include" CACHE PATH "Directory containing citizensdk.h")
set(CITIZENSDK_INTERNAL_INCLUDE_DIR "" CACHE PATH "本轮构建生成的 SDK 私有声明目录；不安装")
set(CITIZENSDK_ASSET_DIR "${CMAKE_CURRENT_LIST_DIR}/../chain" CACHE PATH "Canonical CitizenChain asset directory")
set(CITIZENSDK_SQLITE_INCLUDE_DIR "" CACHE PATH "Pinned SQLite include directory")
set(CITIZENSDK_OPENSSL_INCLUDE_DIR "" CACHE PATH "Pinned OpenSSL include directory")
set(CITIZENSDK_TSS2_INCLUDE_DIR "" CACHE PATH "Pinned TPM2-TSS include directory")
set(CITIZENSDK_SQLITE_ARCHIVE "" CACHE FILEPATH "Pinned libsqlite3.a")
set(CITIZENSDK_CRYPTO_ARCHIVE "" CACHE FILEPATH "Pinned libcrypto.a")
set(CITIZENSDK_TSS2_ESYS_ARCHIVE "" CACHE FILEPATH "Pinned libtss2-esys.a")
set(CITIZENSDK_TSS2_MU_ARCHIVE "" CACHE FILEPATH "Pinned libtss2-mu.a")
set(CITIZENSDK_TSS2_SYS_ARCHIVE "" CACHE FILEPATH "Pinned libtss2-sys.a")
set(CITIZENSDK_TSS2_RC_ARCHIVE "" CACHE FILEPATH "Pinned libtss2-rc.a")
set(CITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE "" CACHE FILEPATH "Pinned libtss2-tcti-device.a")
set(CITIZENSDK_ZXING_SOURCE_DIR "" CACHE PATH "Official complete ZXing-C++ 3.1.1 source directory")
option(CITIZENSDK_BUILD_TESTS "Build Linux Host contract tests" OFF)
option(CITIZENSDK_ENABLE_QR_CAPTURE "Build non-UI camera and native image adapters" ON)
option(CITIZENSDK_WARNINGS_AS_ERRORS "Treat CitizenSDK Linux Host warnings as errors" ON)

# Flutter 只编译适配层，消费同版已安装 Host/Core；不得在插件构建中
# 再编译一份 Host 或要求宿主重新取得 SQLite/TPM/OpenSSL 源码依赖。
if(TARGET flutter)
  include(cmake/CitizenSDKFlutter.cmake)
  return()
endif()

if(NOT IS_ABSOLUTE "${CITIZENSDK_INTERNAL_INCLUDE_DIR}" OR
   NOT EXISTS "${CITIZENSDK_INTERNAL_INCLUDE_DIR}/citizensdk_internal.h")
  message(FATAL_ERROR "CITIZENSDK_INTERNAL_INCLUDE_DIR must contain the generated private header")
endif()

if(NOT CITIZENSDK_PLATFORM STREQUAL "LinuxARM" AND NOT CITIZENSDK_PLATFORM STREQUAL "LinuxAMD")
  message(FATAL_ERROR "CITIZENSDK_PLATFORM must be exactly LinuxARM or LinuxAMD")
endif()
if(NOT IS_ABSOLUTE "${CITIZENSDK_CORE_LIBRARY}" OR NOT EXISTS "${CITIZENSDK_CORE_LIBRARY}")
  message(FATAL_ERROR "CITIZENSDK_CORE_LIBRARY must be an existing absolute libcitizensdk.so path")
endif()
if(NOT EXISTS "${CITIZENSDK_CORE_INCLUDE_DIR}/citizensdk.h" OR
   NOT EXISTS "${CITIZENSDK_CORE_INCLUDE_DIR}/citizensdk_types.h")
  message(FATAL_ERROR "CITIZENSDK_CORE_INCLUDE_DIR must contain citizensdk.h and citizensdk_types.h")
endif()
get_filename_component(_citizensdk_core_name "${CITIZENSDK_CORE_LIBRARY}" NAME)
if(NOT _citizensdk_core_name STREQUAL "libcitizensdk.so")
  message(FATAL_ERROR "CITIZENSDK_CORE_LIBRARY must be named exactly libcitizensdk.so")
endif()
foreach(_asset manifest.json chainspec.json light_sync_state.json)
  if(NOT EXISTS "${CITIZENSDK_ASSET_DIR}/${_asset}")
    message(FATAL_ERROR "CitizenChain asset is missing: ${CITIZENSDK_ASSET_DIR}/${_asset}")
  endif()
endforeach()

function(citizensdk_require_static_archive variable)
  if(NOT IS_ABSOLUTE "${${variable}}" OR NOT EXISTS "${${variable}}" OR
     NOT "${${variable}}" MATCHES "\\.a$")
    message(FATAL_ERROR "${variable} must be an existing absolute .a archive")
  endif()
endfunction()
foreach(_archive
    CITIZENSDK_SQLITE_ARCHIVE CITIZENSDK_CRYPTO_ARCHIVE
    CITIZENSDK_TSS2_ESYS_ARCHIVE CITIZENSDK_TSS2_MU_ARCHIVE
    CITIZENSDK_TSS2_SYS_ARCHIVE CITIZENSDK_TSS2_RC_ARCHIVE
    CITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE)
  citizensdk_require_static_archive(${_archive})
endforeach()
foreach(_include CITIZENSDK_SQLITE_INCLUDE_DIR CITIZENSDK_OPENSSL_INCLUDE_DIR CITIZENSDK_TSS2_INCLUDE_DIR)
  if(NOT IS_ABSOLUTE "${${_include}}" OR NOT IS_DIRECTORY "${${_include}}")
    message(FATAL_ERROR "${_include} must be an existing absolute include directory")
  endif()
endforeach()

find_package(PkgConfig REQUIRED)
find_package(Threads REQUIRED)
pkg_check_modules(GLIB REQUIRED IMPORTED_TARGET glib-2.0 gio-2.0)
if(CITIZENSDK_ENABLE_QR_CAPTURE)
  pkg_check_modules(GTK3 REQUIRED IMPORTED_TARGET gtk+-3.0>=3.24)
  pkg_check_modules(GSTREAMER REQUIRED IMPORTED_TARGET
    gstreamer-1.0>=1.18 gstreamer-app-1.0>=1.18 gstreamer-video-1.0>=1.18)
endif()

add_library(citizensdk_core SHARED IMPORTED GLOBAL)
set_target_properties(citizensdk_core PROPERTIES
  IMPORTED_LOCATION "${CITIZENSDK_CORE_LIBRARY}"
  INTERFACE_INCLUDE_DIRECTORIES "${CITIZENSDK_CORE_INCLUDE_DIR}"
)
add_library(CitizenSDK::Core ALIAS citizensdk_core)

# 五端只链接这一份 SDK 自有窄包装；完整上游源码由构建输入显式提供，
# 不复制、不补丁、不从系统包或网络隐式替换。
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../native/qr-image"
                 "${CMAKE_CURRENT_BINARY_DIR}/citizensdk-qr-image")

add_library(citizensdk_host SHARED
  src/citizen_sdk_assets.cc
  src/citizen_sdk_host_api.cc
  src/citizen_sdk_host_bridge.cc
  src/citizen_sdk_host_record.cc
  src/citizen_sdk_input_limits.cc
  src/citizen_sdk_lifecycle.cc
  src/citizen_sdk_operation.cc
  src/citizen_sdk_public_store.cc
  src/citizen_sdk_record_key.cc
  src/citizen_sdk_secure_store.cc
  src/citizen_sdk_sensitive_buffer.cc
  src/citizen_sdk_secret_vault.cc
  src/citizen_sdk_sqlite.cc
  src/citizen_sdk_tpm2.cc
  src/citizen_sdk_user_auth.cc
  src/citizen_sdk_qr_camera.cc
)
add_library(CitizenSDK::Host ALIAS citizensdk_host)

target_compile_features(citizensdk_host PUBLIC cxx_std_17)
target_compile_definitions(citizensdk_host PRIVATE
  _GNU_SOURCE=1
  CITIZENSDK_HOST_BUILDING=1
  CITIZENSDK_ENABLE_QR_CAPTURE=$<BOOL:${CITIZENSDK_ENABLE_QR_CAPTURE}>
  CITIZENSDK_HOST_VERSION="${PROJECT_VERSION}"
)
target_include_directories(citizensdk_host
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_LIST_DIR}>
    $<BUILD_INTERFACE:${CITIZENSDK_CORE_INCLUDE_DIR}>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>
  PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/src
    ${CITIZENSDK_INTERNAL_INCLUDE_DIR}
    ${CITIZENSDK_SQLITE_INCLUDE_DIR}
    ${CITIZENSDK_OPENSSL_INCLUDE_DIR}
    ${CITIZENSDK_TSS2_INCLUDE_DIR}
)
target_link_libraries(citizensdk_host
  PUBLIC
  "$<BUILD_INTERFACE:citizensdk_core>"
  "$<INSTALL_INTERFACE:CitizenSDK::Core>"
  PRIVATE
  "$<LINK_GROUP:RESCAN,${CITIZENSDK_SQLITE_ARCHIVE},${CITIZENSDK_CRYPTO_ARCHIVE},${CITIZENSDK_TSS2_ESYS_ARCHIVE},${CITIZENSDK_TSS2_MU_ARCHIVE},${CITIZENSDK_TSS2_SYS_ARCHIVE},${CITIZENSDK_TSS2_RC_ARCHIVE},${CITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE}>"
  PkgConfig::GLIB
  Threads::Threads
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,citizensdk_qr_image>"
  ${CMAKE_DL_LIBS}
)
if(CITIZENSDK_ENABLE_QR_CAPTURE)
  target_link_libraries(citizensdk_host PRIVATE PkgConfig::GTK3 PkgConfig::GSTREAMER)
endif()
set_target_properties(citizensdk_host PROPERTIES
  EXPORT_NAME Host
  OUTPUT_NAME citizensdk_host
  CXX_VISIBILITY_PRESET hidden
  C_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  BUILD_RPATH "$ORIGIN"
  INSTALL_RPATH "$ORIGIN"
)
target_compile_options(citizensdk_host PRIVATE
  -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
  $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:-Werror>
)
target_link_options(citizensdk_host PRIVATE
  -static-libstdc++ -static-libgcc
  "LINKER:-soname,libcitizensdk_host.so"
  "LINKER:--exclude-libs,ALL"
  "LINKER:--version-script=${CMAKE_CURRENT_LIST_DIR}/cmake/citizensdk_host.map"
  "LINKER:-z,defs" "LINKER:-z,relro" "LINKER:-z,now"
)

install(TARGETS citizensdk_host EXPORT CitizenSDKTargets
  LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}/${CITIZENSDK_PLATFORM}"
  RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}/${CITIZENSDK_PLATFORM}"
)
install(FILES "${CITIZENSDK_CORE_LIBRARY}"
  DESTINATION "${CMAKE_INSTALL_LIBDIR}/${CITIZENSDK_PLATFORM}"
  RENAME libcitizensdk.so
)
install(FILES
  "${CITIZENSDK_CORE_INCLUDE_DIR}/citizensdk.h"
  "${CITIZENSDK_CORE_INCLUDE_DIR}/citizensdk_types.h"
  "${CMAKE_CURRENT_LIST_DIR}/../native/qr-image/citizensdk_qr_image.h"
  DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}"
)
# 注册头仅由 Flutter generated registrant 使用，原生 C/C++ 安装不依赖 Flutter。
install(DIRECTORY citizen_sdk DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}"
  PATTERN "citizen_sdk_plugin.h" EXCLUDE
)
install(FILES
  "${CITIZENSDK_ASSET_DIR}/manifest.json"
  "${CITIZENSDK_ASSET_DIR}/chainspec.json"
  "${CITIZENSDK_ASSET_DIR}/light_sync_state.json"
  DESTINATION "${CMAKE_INSTALL_DATADIR}/citizensdk/chain"
)

set(CITIZENSDK_PACKAGE_INSTALL_DIR
    "${CMAKE_INSTALL_LIBDIR}/${CITIZENSDK_PLATFORM}/cmake/CitizenSDK")
configure_package_config_file(
  cmake/CitizenSDKConfig.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfig.cmake"
  INSTALL_DESTINATION "${CITIZENSDK_PACKAGE_INSTALL_DIR}"
  PATH_VARS CMAKE_INSTALL_INCLUDEDIR CMAKE_INSTALL_LIBDIR CMAKE_INSTALL_DATADIR
)
configure_file(cmake/CitizenSDKConfigVersion.cmake.in
               "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfigVersion.cmake" @ONLY)
install(EXPORT CitizenSDKTargets
  FILE CitizenSDKTargets.cmake
  NAMESPACE CitizenSDK::
  DESTINATION "${CITIZENSDK_PACKAGE_INSTALL_DIR}"
)
install(FILES
  "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/CitizenSDKConfigVersion.cmake"
  cmake/CitizenSDKDependencies.cmake
  DESTINATION "${CITIZENSDK_PACKAGE_INSTALL_DIR}"
)

if(CITIZENSDK_BUILD_TESTS)
  enable_testing()
  add_subdirectory(test)
endif()
