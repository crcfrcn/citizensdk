import 'dart:ffi';
import 'dart:io';

import 'package:path/path.dart' as path;

import 'types.dart';

/// CitizenApp 差分测试保留的 legacy smoldot 库装载器。
///
/// 此整个目录由 `.pubignore` 排除在 CitizenSDK Hosted 运行闭包外；正式
/// Flutter/Swift/Kotlin 产品只经过 `citizensdk_*` ABI，不调用本装载器。
class SmoldotPlatform {
  /// Library name without extension
  static const String _libraryName = 'smoldot';

  /// Get the dynamic library for the current platform
  static DynamicLibrary loadLibrary() {
    if (Platform.isAndroid || Platform.isLinux) {
      return _loadLinux();
    } else if (Platform.isIOS || Platform.isMacOS) {
      return _loadDarwin();
    } else if (Platform.isWindows) {
      return _loadWindows();
    } else {
      throw SmoldotFfiException(
        'Unsupported platform: ${Platform.operatingSystem}',
        details:
            'Only Android, iOS, macOS, LinuxARM, LinuxAMD, and Windows are supported',
      );
    }
  }

  /// Load library for the LinuxARM/LinuxAMD or Android ELF technical path.
  static DynamicLibrary _loadLinux() {
    try {
      // Try loading from system library path
      return DynamicLibrary.open('lib$_libraryName.so');
    } catch (e) {
      // Try loading from package directory
      final libraryPath = _getPackageLibraryPath('lib$_libraryName.so');
      if (libraryPath != null) {
        return DynamicLibrary.open(libraryPath);
      }
      throw SmoldotFfiException(
        'Failed to load $_libraryName library on ${Platform.operatingSystem}',
        details: e.toString(),
      );
    }
  }

  /// Load library on macOS/iOS
  static DynamicLibrary _loadDarwin() {
    if (Platform.isIOS) {
      // 归档基线保留 CitizenApp 原有的进程符号查找行为，仅用于差分
      // 夹具。CitizenSDK iOS 正式运行件是 iOS XCFramework slice 内的
      // 产品 Core，不再存在 pod/ios/smoldot 或 libsmoldot.a 产品路径。
      return DynamicLibrary.process();
    }

    // flutter_tester 不会链接 iOS CocoaPods 的静态库；macOS 宿主测试只能
    // dlopen 中央工作目录生成并注入隔离快照的 dylib。禁止退回当前进程句柄，
    // 否则“宿主库不存在”会被伪装成某一个 FFI 符号 lookup 失败。
    final libraryPath = _getPackageLibraryPath('lib$_libraryName.dylib');
    Object? packageError;
    if (libraryPath != null && File(libraryPath).existsSync()) {
      try {
        return DynamicLibrary.open(libraryPath);
      } on Object catch (error) {
        packageError = error;
      }
    }

    try {
      return DynamicLibrary.open('lib$_libraryName.dylib');
    } on Object catch (systemError) {
      throw SmoldotFfiException(
        'Failed to load $_libraryName library on ${Platform.operatingSystem}',
        details:
            'Library path: $libraryPath\n'
            'Package error: ${packageError ?? 'library not found'}\n'
            'System error: $systemError\n'
            'Run ./scripts/build-native.sh host with central work/output paths '
            'before flutter test.',
      );
    }
  }

  /// Load library on Windows
  static DynamicLibrary _loadWindows() {
    try {
      // Try loading from system library path
      return DynamicLibrary.open('$_libraryName.dll');
    } catch (e) {
      // Try loading from package directory
      final libraryPath = _getPackageLibraryPath('$_libraryName.dll');
      if (libraryPath != null) {
        return DynamicLibrary.open(libraryPath);
      }
      throw SmoldotFfiException(
        'Failed to load $_libraryName library on ${Platform.operatingSystem}',
        details: e.toString(),
      );
    }
  }

  /// Get the package library path for the given library name
  static String? _getPackageLibraryPath(String libraryName) {
    // 中文注释：源码树禁止出现任何编译产物。宿主测试只允许把中央工作目录
    // 生成的动态库注入隔离测试根目录，因此这里只检查当前工作目录；
    // 正式 Android/Apple 产品不进入这条 legacy 路径。
    final libraryPath = path.join(Directory.current.path, libraryName);
    return File(libraryPath).existsSync() ? libraryPath : null;
  }

  /// Get the current platform name
  static String get platformName => Platform.operatingSystem;

  /// Check if the platform is supported
  static bool get isSupported {
    return Platform.isAndroid ||
        Platform.isIOS ||
        Platform.isMacOS ||
        Platform.isLinux ||
        Platform.isWindows;
  }

  /// Get platform-specific library extension
  static String get libraryExtension {
    if (Platform.isAndroid || Platform.isLinux) {
      return '.so';
    } else if (Platform.isIOS || Platform.isMacOS) {
      return '.dylib';
    } else if (Platform.isWindows) {
      return '.dll';
    }
    return '';
  }

  /// Get the full library name with extension
  static String get fullLibraryName {
    final prefix = Platform.isWindows ? '' : 'lib';
    return '$prefix$_libraryName$libraryExtension';
  }
}
