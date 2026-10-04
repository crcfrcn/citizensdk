# Flutter 官方 target 与 ABI 机器字段只在此转换成产品平台名。
# 本文件不下载、不构建 Core/Host；没有同版安装投影即失败关闭。
if(NOT TARGET flutter)
  message(FATAL_ERROR "CitizenSDK Flutter adapter requires the official flutter target")
endif()
if(FLUTTER_TARGET_PLATFORM STREQUAL "linux-arm64")
  set(_citizensdk_flutter_platform "LinuxARM")
elseif(FLUTTER_TARGET_PLATFORM STREQUAL "linux-x64")
  set(_citizensdk_flutter_platform "LinuxAMD")
else()
  message(FATAL_ERROR "CitizenSDK Flutter requires the official linux-arm64 or linux-x64 target")
endif()
if(CITIZENSDK_PLATFORM AND
   NOT CITIZENSDK_PLATFORM STREQUAL _citizensdk_flutter_platform)
  message(FATAL_ERROR "CitizenSDK Flutter and native package platform must match")
endif()
set(CITIZENSDK_PLATFORM "${_citizensdk_flutter_platform}")

get_filename_component(_citizensdk_linux_root "${CMAKE_CURRENT_LIST_DIR}/.." REALPATH)
# 正式插件与消费者都只消费同一个包内的安装投影，不接受宿主覆盖前缀，
# 也不从系统路径、环境变量或其它仓库取得另一份 Core/Host。
set(_citizensdk_host_prefix "${_citizensdk_linux_root}")
set(_citizensdk_package_dir
  "${_citizensdk_host_prefix}/lib/${CITIZENSDK_PLATFORM}/cmake/CitizenSDK")
foreach(_config CitizenSDKConfig.cmake CitizenSDKConfigVersion.cmake)
  if(NOT EXISTS "${_citizensdk_package_dir}/${_config}")
    message(FATAL_ERROR "CitizenSDK same-release Linux Host installation is missing: ${_config}")
  endif()
endforeach()
set(CitizenSDK_DIR "${_citizensdk_package_dir}")
find_package(CitizenSDK ${PROJECT_VERSION} EXACT CONFIG REQUIRED
  PATHS "${_citizensdk_package_dir}" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)

# 导入目标也必须指向这次安装中的精确双库。禁止父图中同名的源码 target、
# 不同版本库或另一平台被 CMake 的已有 target 静默复用。
foreach(_kind Core Host)
  if(NOT TARGET CitizenSDK::${_kind})
    message(FATAL_ERROR "CitizenSDK installation does not define CitizenSDK::${_kind}")
  endif()
  get_target_property(_imported CitizenSDK::${_kind} IMPORTED)
  if(NOT _imported)
    message(FATAL_ERROR "CitizenSDK Flutter must consume imported Core/Host, not rebuild them")
  endif()
  if(_kind STREQUAL "Core")
    set(_filename libcitizensdk.so)
  else()
    set(_filename libcitizensdk_host.so)
  endif()
  set(_expected "${_citizensdk_host_prefix}/lib/${CITIZENSDK_PLATFORM}/${_filename}")
  if(NOT EXISTS "${_expected}" OR IS_DIRECTORY "${_expected}" OR IS_SYMLINK "${_expected}")
    message(FATAL_ERROR "CitizenSDK installation requires the ordinary runtime file ${_filename}")
  endif()
  get_target_property(_configs CitizenSDK::${_kind} IMPORTED_CONFIGURATIONS)
  set(_locations)
  get_target_property(_location CitizenSDK::${_kind} IMPORTED_LOCATION)
  if(_location)
    list(APPEND _locations "${_location}")
  endif()
  foreach(_config IN LISTS _configs)
    string(TOUPPER "${_config}" _upper)
    get_target_property(_location CitizenSDK::${_kind} IMPORTED_LOCATION_${_upper})
    if(_location)
      list(APPEND _locations "${_location}")
    endif()
  endforeach()
  if(NOT _locations)
    message(FATAL_ERROR "CitizenSDK::${_kind} has no imported runtime location")
  endif()
  foreach(_location IN LISTS _locations)
    if(NOT _location STREQUAL _expected)
      message(FATAL_ERROR "CitizenSDK::${_kind} does not belong to the selected same-release installation")
    endif()
  endforeach()
endforeach()

find_package(Threads REQUIRED)
set(CITIZENSDK_FLUTTER_ADAPTER_SOURCES
  "${_citizensdk_linux_root}/src/citizen_sdk_plugin.cc"
  "${_citizensdk_linux_root}/src/citizen_sdk_flutter_codec.cc"
  "${_citizensdk_linux_root}/src/citizen_sdk_flutter_sessions.cc"
  "${_citizensdk_linux_root}/src/citizen_sdk_flutter_environment.cc"
)
add_library(citizen_sdk_plugin SHARED ${CITIZENSDK_FLUTTER_ADAPTER_SOURCES})
if(COMMAND apply_standard_settings)
  apply_standard_settings(citizen_sdk_plugin)
endif()
target_compile_features(citizen_sdk_plugin PRIVATE cxx_std_17)
target_compile_definitions(citizen_sdk_plugin PRIVATE FLUTTER_PLUGIN_IMPL)
target_include_directories(citizen_sdk_plugin
  PUBLIC "${_citizensdk_linux_root}"
  PRIVATE "${_citizensdk_linux_root}/src"
)
target_link_libraries(citizen_sdk_plugin PRIVATE
  flutter CitizenSDK::Host Threads::Threads)
set_target_properties(citizen_sdk_plugin PROPERTIES
  OUTPUT_NAME citizen_sdk_plugin
  CXX_EXTENSIONS OFF
  CXX_VISIBILITY_PRESET hidden
  C_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  # Flutter 用 install(FILES) 复制插件，不会重写其 build-tree RUNPATH。
  # 因此插件自身在链接时就使用最终路径，不能由测试 runner 额外补配置。
  BUILD_WITH_INSTALL_RPATH TRUE
  INSTALL_RPATH "$ORIGIN"
)
target_compile_options(citizen_sdk_plugin PRIVATE
  -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
  $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:-Werror>)
target_link_options(citizen_sdk_plugin PRIVATE
  -static-libstdc++ -static-libgcc "LINKER:--exclude-libs,ALL"
  "LINKER:-z,defs" "LINKER:-z,relro" "LINKER:-z,now")

# Flutter 自己把 plugin target 加入 bundle；这里只交付其同版依赖双库。
set(citizen_sdk_bundled_libraries
  "${_citizensdk_host_prefix}/lib/${CITIZENSDK_PLATFORM}/libcitizensdk.so"
  "${_citizensdk_host_prefix}/lib/${CITIZENSDK_PLATFORM}/libcitizensdk_host.so"
  PARENT_SCOPE)

if(CITIZENSDK_BUILD_TESTS)
  enable_testing()
  add_subdirectory("${_citizensdk_linux_root}/test" "${CMAKE_CURRENT_BINARY_DIR}/test")
endif()
