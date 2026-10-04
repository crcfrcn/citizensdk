# Host carries the audited SQLite, TPM2-TSS, crypto, libstdc++, and libgcc
# closure. This installed-package check prevents a partial projection from
# appearing valid; GTK/glibc are runtime platform dependencies, not exported
# CMake link dependencies.
if(NOT DEFINED CITIZENSDK_LIBRARY_DIR OR
   NOT EXISTS "${CITIZENSDK_LIBRARY_DIR}/${CITIZENSDK_PLATFORM}/libcitizensdk.so" OR
   NOT EXISTS "${CITIZENSDK_LIBRARY_DIR}/${CITIZENSDK_PLATFORM}/libcitizensdk_host.so")
  set(CitizenSDK_FOUND FALSE)
  set(CitizenSDK_NOT_FOUND_MESSAGE "CitizenSDK Core/Host runtime pair is incomplete")
  return()
endif()
