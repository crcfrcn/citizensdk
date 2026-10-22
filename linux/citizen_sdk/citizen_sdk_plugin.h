#ifndef CITIZENSDK_FLUTTER_PLUGIN_H
#define CITIZENSDK_FLUTTER_PLUGIN_H

#include <flutter_linux/flutter_linux.h>

G_BEGIN_DECLS

// 仅供 Flutter 官方 generated registrant 注册通道，不构成第二套 Core ABI。
// Flutter's generated Linux registrant calls this C entry point. It only
// registers the official CitizenSDK v1 channels; it is not another Core ABI.
G_MODULE_EXPORT
void citizen_sdk_plugin_register_with_registrar(FlPluginRegistrar *registrar);

G_END_DECLS

#endif
