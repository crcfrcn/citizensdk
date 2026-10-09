#ifndef FLUTTER_PLUGIN_CITIZEN_SDK_PLUGIN_H_
#define FLUTTER_PLUGIN_CITIZEN_SDK_PLUGIN_H_

#include <flutter_plugin_registrar.h>

#ifdef FLUTTER_PLUGIN_IMPL
#define FLUTTER_PLUGIN_EXPORT __declspec(dllexport)
#else
#define FLUTTER_PLUGIN_EXPORT __declspec(dllimport)
#endif

#ifdef __cplusplus
extern "C" {
#endif

// 仅供 Flutter 官方 generated registrant；不是另一套 Host 或钱包接口。
FLUTTER_PLUGIN_EXPORT void CitizenSdkPluginRegisterWithRegistrar(
    FlutterDesktopPluginRegistrarRef registrar);

#ifdef __cplusplus
}
#endif

#endif
