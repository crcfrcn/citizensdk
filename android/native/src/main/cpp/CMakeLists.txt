cmake_minimum_required(VERSION 3.31.6)
project(citizensdk_jni LANGUAGES CXX)

if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
  message(FATAL_ERROR "CitizenSDK Android 1.0.0 supports only arm64-v8a")
endif()
if(NOT DEFINED CITIZENSDK_CORE_DIR)
  message(FATAL_ERROR "CITIZENSDK_CORE_DIR is required")
endif()
if(NOT IS_ABSOLUTE "${CITIZENSDK_ZXING_SOURCE_DIR}")
  message(FATAL_ERROR "CITIZENSDK_ZXING_SOURCE_DIR is required")
endif()
if(NOT IS_ABSOLUTE "${CITIZENSDK_INTERNAL_INCLUDE_DIR}" OR
   NOT EXISTS "${CITIZENSDK_INTERNAL_INCLUDE_DIR}/citizensdk_internal.h")
  message(FATAL_ERROR "SDK build-private declarations are required")
endif()
set(CITIZENSDK_CORE_LIBRARY "${CITIZENSDK_CORE_DIR}/libcitizensdk.so")
if(NOT EXISTS "${CITIZENSDK_CORE_LIBRARY}")
  message(FATAL_ERROR "The staged libcitizensdk.so is missing")
endif()

add_library(citizensdk_core SHARED IMPORTED GLOBAL)
set_target_properties(citizensdk_core PROPERTIES
  IMPORTED_LOCATION "${CITIZENSDK_CORE_LIBRARY}"
)

set(CITIZENSDK_QR_IMAGE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../../../../../native/qr-image"
                 "${CMAKE_CURRENT_BINARY_DIR}/citizensdk-qr-image")

add_library(citizensdk_jni SHARED
  citizensdk_host_bridge.cpp
  citizensdk_jni.cpp
)
target_compile_features(citizensdk_jni PRIVATE cxx_std_17)
target_compile_options(citizensdk_jni PRIVATE
  -Wall -Wextra -Werror -fvisibility=hidden -fvisibility-inlines-hidden
)
target_include_directories(citizensdk_jni PRIVATE
  "${CITIZENSDK_INTERNAL_INCLUDE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../include"
  "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../native/qr-image"
)
target_link_libraries(citizensdk_jni PRIVATE citizensdk_core CitizenSDK::QrImage android log)

set(CITIZENSDK_JNI_VERSION_SCRIPT
    "${CMAKE_CURRENT_BINARY_DIR}/citizensdk-jni.exports.map")
file(GENERATE OUTPUT "${CITIZENSDK_JNI_VERSION_SCRIPT}" CONTENT
"CITIZENSDK_JNI_1.0 {
  global:
    JNI_OnLoad;
  local:
    *;
};
")
target_link_options(citizensdk_jni PRIVATE
  "-Wl,--version-script=${CITIZENSDK_JNI_VERSION_SCRIPT}"
  "-Wl,--exclude-libs,ALL"
  "-Wl,--no-undefined"
)

# JNI 仅导出版本化注册/生命周期符号；89个公开及4个内部链接符号仅归Core所有。
set_target_properties(citizensdk_jni PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
)
