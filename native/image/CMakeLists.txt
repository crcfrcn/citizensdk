cmake_minimum_required(VERSION 3.24)
project(CitizenSDKQrImage LANGUAGES C CXX)

set(CITIZENSDK_ZXING_SOURCE_DIR "" CACHE PATH "Official complete ZXing-C++ source directory")
option(CITIZENSDK_QR_IMAGE_BUILD_TESTS "Build CitizenSDK QR image round-trip test" OFF)

if(NOT IS_ABSOLUTE "${CITIZENSDK_ZXING_SOURCE_DIR}" OR
   NOT EXISTS "${CITIZENSDK_ZXING_SOURCE_DIR}/core/src/ZXingC.h")
  message(FATAL_ERROR "CITIZENSDK_ZXING_SOURCE_DIR must be the complete official ZXing-C++ 3.1.1 source")
endif()

# 固定官方完整 Release 的实际构建输入（core、docs、根 CMake 和辅助脚本）。
# 仅版本字符串不能证明来源；在执行上游 CMake 之前逐文件验真，拒绝额外文件和链接。
file(GLOB_RECURSE _citizensdk_zxing_entries LIST_DIRECTORIES true
  RELATIVE "${CITIZENSDK_ZXING_SOURCE_DIR}"
  "${CITIZENSDK_ZXING_SOURCE_DIR}/core/*"
  "${CITIZENSDK_ZXING_SOURCE_DIR}/docs/*")
list(APPEND _citizensdk_zxing_entries CMakeLists.txt zxing.cmake)
list(SORT _citizensdk_zxing_entries)
set(_citizensdk_zxing_manifest "")
foreach(_citizensdk_entry IN LISTS _citizensdk_zxing_entries)
  set(_citizensdk_file "${CITIZENSDK_ZXING_SOURCE_DIR}/${_citizensdk_entry}")
  if(IS_SYMLINK "${_citizensdk_file}")
    message(FATAL_ERROR "ZXing-C++ build input cannot contain symlinks")
  endif()
  if(NOT IS_DIRECTORY "${_citizensdk_file}")
    file(SHA256 "${_citizensdk_file}" _citizensdk_digest)
    string(APPEND _citizensdk_zxing_manifest "${_citizensdk_entry}:${_citizensdk_digest}\n")
  endif()
endforeach()
string(SHA256 _citizensdk_zxing_digest "${_citizensdk_zxing_manifest}")
if(NOT _citizensdk_zxing_digest STREQUAL "47e4950494ae7fef55307846ad47f2586b83a1d4cde381ec3c2ca0215015db3e")
  message(FATAL_ERROR "ZXing-C++ build inputs differ from the pinned official 3.1.1 release")
endif()
file(READ "${CITIZENSDK_ZXING_SOURCE_DIR}/core/CMakeLists.txt" _citizensdk_zxing_core)
if(NOT _citizensdk_zxing_core MATCHES "project \\(ZXing VERSION \"3\\.1\\.1\"\\)")
  message(FATAL_ERROR "CitizenSDK requires ZXing-C++ exactly 3.1.1")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ZXING_READERS ON CACHE BOOL "" FORCE)
set(ZXING_WRITERS NEW CACHE STRING "" FORCE)
set(ZXING_C_API ON CACHE BOOL "" FORCE)
set(ZXING_USE_BUNDLED_ZINT ON CACHE BOOL "" FORCE)
set(ZXING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(ZXING_BLACKBOX_TESTS OFF CACHE BOOL "" FORCE)
set(ZXING_UNIT_TESTS OFF CACHE BOOL "" FORCE)
foreach(_citizensdk_option EXAMPLES_QT TEST_DOTNET TEST_GO TEST_INSTALL PYTHON_MODULE CLANG_TIDY EXPERIMENTAL_API)
  set(ZXING_${_citizensdk_option} OFF CACHE BOOL "" FORCE)
endforeach()
set(ZXING_ENABLE_QRCODE ON CACHE BOOL "" FORCE)
# 本产品只接受 QR Code；只关闭上游公开构建选项，不修改上游源码。
foreach(_citizensdk_format 1D AZTEC DATAMATRIX MAXICODE PDF417)
  set(ZXING_ENABLE_${_citizensdk_format} OFF CACHE BOOL "" FORCE)
endforeach()
set(ZXING_DEPENDENCIES LOCAL CACHE STRING "" FORCE)

# 上游根工程会随 C API 无条件构建 C 示例并拉入 stb。直接使用其独立 core
# 工程即可保留同一 C API/编解码实现，不引入示例、图片文件库或在线下载。
add_subdirectory("${CITIZENSDK_ZXING_SOURCE_DIR}/core" zxing/core EXCLUDE_FROM_ALL)

add_library(citizensdk_qr_image STATIC citizensdk_qr_image.cc)
add_library(CitizenSDK::QrImage ALIAS citizensdk_qr_image)
target_compile_features(citizensdk_qr_image PUBLIC cxx_std_17)
target_include_directories(citizensdk_qr_image PUBLIC "${CMAKE_CURRENT_LIST_DIR}")
# ZXing-C++ 是经摘要固定、只读使用的上游。把它的公开头标为系统头，避免
# CitizenSDK 的 -Werror 把上游 3.1.1 自身告警误判成包装层错误；本目标源码的
# -Wall/-Wextra/-Wconversion 仍全部生效。
target_include_directories(citizensdk_qr_image SYSTEM PRIVATE
  "${CITIZENSDK_ZXING_SOURCE_DIR}/core/src")
target_link_libraries(citizensdk_qr_image PRIVATE ZXing::ZXing)
set_target_properties(citizensdk_qr_image PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  C_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  POSITION_INDEPENDENT_CODE ON)
if(MSVC)
  target_compile_options(citizensdk_qr_image PRIVATE /W4 /WX /permissive- /utf-8 /EHsc)
else()
  target_compile_options(citizensdk_qr_image PRIVATE
    -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Werror)
endif()

if(CITIZENSDK_QR_IMAGE_BUILD_TESTS)
  enable_testing()
  add_executable(citizensdk_qr_image_test citizensdk_qr_image_test.cc)
  target_compile_features(citizensdk_qr_image_test PRIVATE cxx_std_17)
  target_link_libraries(citizensdk_qr_image_test PRIVATE citizensdk_qr_image)
  add_test(NAME citizensdk_qr_image_round_trip COMMAND citizensdk_qr_image_test)
endif()
