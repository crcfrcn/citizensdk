# 核对Linux安装包的SQLite、TPM及C++运行依赖闭包。

if(NOT DEFINED CITIZENSDK_LIBRARY_DIR OR
   NOT EXISTS "${CITIZENSDK_LIBRARY_DIR}/${CITIZENSDK_PLATFORM}/libcitizensdk.so" OR
   NOT EXISTS "${CITIZENSDK_LIBRARY_DIR}/${CITIZENSDK_PLATFORM}/libcitizensdk_host.so")
  set(CitizenSDK_FOUND FALSE)
  set(CitizenSDK_NOT_FOUND_MESSAGE "CitizenSDK Core/Host runtime pair is incomplete")
  return()
endif()
