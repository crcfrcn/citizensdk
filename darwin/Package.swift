// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CitizenSDK",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "CitizenSDK", targets: ["CitizenSDK"]),
    ],
    targets: [
        // The canonical candidate builder injects this artifact. Keeping the
        // binary target as the only product prevents SwiftPM from compiling or
        // linking a second copy of Core.
        .binaryTarget(
            name: "CitizenSDK",
            path: "CitizenSDK.xcframework"
        ),
    ]
)
