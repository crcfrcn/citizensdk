# 只消费 Flutter 官方目标和同包已安装双库，不下载或重编 Host/Core。
if(NOT TARGET flutter OR NOT TARGET flutter_wrapper_plugin)
  message(FATAL_ERROR "CitizenSDK Windows requires official Flutter plugin targets")
endif()
if(NOT FLUTTER_TARGET_PLATFORM STREQUAL "windows-x64" OR
   NOT CITIZENSDK_PLATFORM STREQUAL "Windows")
  message(FATAL_ERROR "CitizenSDK Windows Flutter requires the official windows-x64 target")
endif()

# 身份是稳定的数据命名空间，而不是 Shell 展示名或登录账户。只有显式声明，
# 没有默认值、环境变量探测或大小写转换；白名单同时阻止构建定义注入。
if(NOT DEFINED CITIZENSDK_APPLICATION_ID)
  message(FATAL_ERROR "Declare CITIZENSDK_APPLICATION_ID before generated_plugins.cmake")
endif()
string(LENGTH "${CITIZENSDK_APPLICATION_ID}" _citizensdk_id_length)
if(_citizensdk_id_length LESS 3 OR _citizensdk_id_length GREATER 253 OR
   NOT CITIZENSDK_APPLICATION_ID MATCHES "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$")
  message(FATAL_ERROR "CITIZENSDK_APPLICATION_ID must be a lowercase reverse-DNS identifier")
endif()

get_filename_component(_citizensdk_windows_root "${CMAKE_CURRENT_LIST_DIR}/.." REALPATH)
set(_citizensdk_package_dir "${_citizensdk_windows_root}/lib/Windows/cmake/CitizenSDK")
foreach(_config CitizenSDKConfig.cmake CitizenSDKConfigVersion.cmake)
  if(NOT EXISTS "${_citizensdk_package_dir}/${_config}" OR
     IS_DIRECTORY "${_citizensdk_package_dir}/${_config}" OR
     IS_SYMLINK "${_citizensdk_package_dir}/${_config}")
    message(FATAL_ERROR "CitizenSDK same-release Windows installation is missing: ${_config}")
  endif()
endforeach()
set(CitizenSDK_DIR "${_citizensdk_package_dir}")
find_package(CitizenSDK ${PROJECT_VERSION} EXACT CONFIG REQUIRED
  PATHS "${_citizensdk_package_dir}" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)

# 检查全部配置的 DLL 与 import library，防止父图中的同名目标或 Debug
# 配置暗中指向其它安装；包版本检查不能代替实际链接目标检查。
foreach(_kind Core Host)
  if(NOT TARGET CitizenSDK::${_kind})
    message(FATAL_ERROR "CitizenSDK installation is missing CitizenSDK::${_kind}")
  endif()
  get_target_property(_imported CitizenSDK::${_kind} IMPORTED)
  get_target_property(_type CitizenSDK::${_kind} TYPE)
  if(NOT _imported OR NOT _type STREQUAL "SHARED_LIBRARY")
    message(FATAL_ERROR "CitizenSDK Flutter requires imported Core/Host shared libraries")
  endif()
  get_target_property(_headers CitizenSDK::${_kind} INTERFACE_INCLUDE_DIRECTORIES)
  if(NOT _headers STREQUAL "${_citizensdk_windows_root}/include")
    message(FATAL_ERROR "CitizenSDK::${_kind} headers are outside the same-release installation")
  endif()
  get_target_property(_links CitizenSDK::${_kind} INTERFACE_LINK_LIBRARIES)
  if((_kind STREQUAL "Core" AND _links) OR
     (_kind STREQUAL "Host" AND NOT _links STREQUAL "CitizenSDK::Core"))
    message(FATAL_ERROR "CitizenSDK Flutter requires the single installed Host-to-Core dependency")
  endif()
  if(_kind STREQUAL "Core")
    set(_runtime citizensdk.dll)
    set(_archive citizensdk.dll.lib)
  else()
    set(_runtime citizensdk_host.dll)
    set(_archive citizensdk_host.lib)
  endif()
  set(_expected_location "${_citizensdk_windows_root}/bin/Windows/${_runtime}")
  set(_expected_implib "${_citizensdk_windows_root}/lib/Windows/${_archive}")
  foreach(_expected IN ITEMS "${_expected_location}" "${_expected_implib}")
    if(NOT EXISTS "${_expected}" OR IS_DIRECTORY "${_expected}" OR IS_SYMLINK "${_expected}")
      message(FATAL_ERROR "CitizenSDK Windows runtime/import pair must be ordinary files")
    endif()
  endforeach()
  get_target_property(_configs CitizenSDK::${_kind} IMPORTED_CONFIGURATIONS)
  if(NOT _configs)
    set(_configs)
  endif()
  list(APPEND _configs ${CMAKE_CONFIGURATION_TYPES} ${CMAKE_BUILD_TYPE}
    DEBUG RELEASE RELWITHDEBINFO MINSIZEREL PROFILE NOCONFIG)
  list(REMOVE_DUPLICATES _configs)
  foreach(_property LOCATION IMPLIB)
    set(_values)
    get_target_property(_value CitizenSDK::${_kind} IMPORTED_${_property})
    if(_value)
      list(APPEND _values "${_value}")
    endif()
    foreach(_config IN LISTS _configs)
      string(TOUPPER "${_config}" _upper)
      get_target_property(_value CitizenSDK::${_kind} IMPORTED_${_property}_${_upper})
      if(_value)
        list(APPEND _values "${_value}")
      endif()
    endforeach()
    if(NOT _values)
      message(FATAL_ERROR "CitizenSDK::${_kind} has no imported ${_property}")
    endif()
    if(_property STREQUAL "LOCATION")
      set(_expected "${_expected_location}")
    else()
      set(_expected "${_expected_implib}")
    endif()
    foreach(_value IN LISTS _values)
      if(NOT _value STREQUAL _expected)
        message(FATAL_ERROR "CitizenSDK::${_kind} ${_property} is outside the same-release installation")
      endif()
    endforeach()
  endforeach()
endforeach()

set(CITIZENSDK_FLUTTER_ADAPTER_SOURCES
  "${_citizensdk_windows_root}/src/citizen_sdk_plugin.cc"
  "${_citizensdk_windows_root}/src/citizen_sdk_flutter_codec.cc"
  "${_citizensdk_windows_root}/src/citizen_sdk_flutter_environment.cc"
  "${_citizensdk_windows_root}/src/citizen_sdk_flutter_sessions.cc")

# 自有目标统一异常模式，不调用会设置 _HAS_EXCEPTIONS=0 的宿主 helper，
# 也不改 Flutter wrapper 或宿主全局编译选项。测试复用同一配置函数。
function(citizensdk_configure_flutter_target target)
  target_compile_features(${target} PUBLIC cxx_std_17)
  target_compile_definitions(${target} PRIVATE
    WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE _WIN32_WINNT=0x0A00
    _HAS_EXCEPTIONS=1 FLUTTER_PLUGIN_IMPL
    CITIZENSDK_APPLICATION_ID="${CITIZENSDK_APPLICATION_ID}")
  target_include_directories(${target} PUBLIC "${_citizensdk_windows_root}"
    PRIVATE "${_citizensdk_windows_root}/src")
  target_link_libraries(${target} PUBLIC flutter flutter_wrapper_plugin CitizenSDK::Host
    PRIVATE bcrypt user32 gdi32 comctl32 shell32 ole32)
  target_compile_options(${target} PRIVATE /W4 /permissive- /utf-8 /EHsc
    $<$<BOOL:${CITIZENSDK_WARNINGS_AS_ERRORS}>:/WX>)
  set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF CXX_VISIBILITY_PRESET hidden)
endfunction()

add_library(citizen_sdk_plugin SHARED ${CITIZENSDK_FLUTTER_ADAPTER_SOURCES})
citizensdk_configure_flutter_target(citizen_sdk_plugin)
target_link_options(citizen_sdk_plugin PRIVATE /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA)

# Flutter 负责 plugin 自身；只追加该次安装的双库，不让宿主重复收集或重建。
set(citizen_sdk_bundled_libraries
  "${_citizensdk_windows_root}/bin/Windows/citizensdk.dll"
  "${_citizensdk_windows_root}/bin/Windows/citizensdk_host.dll"
  PARENT_SCOPE)
if(CITIZENSDK_BUILD_TESTS)
  enable_testing()
  add_subdirectory("${_citizensdk_windows_root}/test" "${CMAKE_CURRENT_BINARY_DIR}/test")
endif()
