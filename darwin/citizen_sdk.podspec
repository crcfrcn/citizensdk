framework_path = 'CitizenSDK.xcframework'
raise "Missing CitizenSDK framework: #{framework_path}" unless Dir.exist?(File.join(__dir__, framework_path))

Pod::Spec.new do |spec|
  spec.name             = 'citizen_sdk'
  spec.version          = '1.0.0'
  spec.summary          = 'CitizenChain verified light client, wallet, signing, and transaction SDK.'
  spec.description      = <<-DESC
CitizenSDK projects one Rust Core and one stable C ABI through a native Swift
API and a secret-free Flutter adapter for iOS and macOS.
                       DESC
  spec.homepage         = 'https://github.com/crcfrcn/citizensdk'
  spec.license          = { :file => '../LICENSE' }
  spec.author           = { 'VoyagerRhett' => 'chinanation@icloud.com' }
  spec.source           = { :path => '.' }
  spec.ios.deployment_target = '16.0'
  spec.osx.deployment_target = '13.0'
  spec.swift_version    = '5.9'
  spec.source_files     = 'source/flutter/**/*.swift'
  spec.vendored_frameworks = framework_path
  spec.frameworks = 'AVFoundation', 'CoreVideo'
  spec.ios.dependency 'Flutter'
  spec.osx.dependency 'FlutterMacOS'
  spec.ios.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386 x86_64'
  }
  # CitizenSDK's first macOS product slice is Apple Silicon only. Excluding
  # x86_64 here makes an unsupported host fail during dependency integration
  # instead of silently selecting a different or emulated Core.
  spec.osx.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'ARCHS' => 'arm64',
    'EXCLUDED_ARCHS[sdk=macosx*]' => 'x86_64'
  }
end
