import Foundation

internal struct CitizenSDKAssets {
    let manifest: Data
    let chainSpec: Data
    let lightSyncState: Data

    static func load(bundle: Bundle = Bundle(for: CitizenSDKBundleMarker.self)) throws -> CitizenSDKAssets {
        // 构建器将SDK根下chain三文件原样装入Framework的chain资源目录。
        // 以下位置对应正式Bundle布局；不读取旧资源目录或建立第二资产真源。
        let roots = [
            bundle.resourceURL?.appendingPathComponent("chain", isDirectory: true),
            bundle.resourceURL?.appendingPathComponent("Resources/chain", isDirectory: true),
            bundle.resourceURL?
                .appendingPathComponent("CitizenSDKResources.bundle", isDirectory: true)
                .appendingPathComponent("chain", isDirectory: true),
        ].compactMap { $0 }

        func read(_ name: String) throws -> Data {
            guard let url = roots.lazy.map({ $0.appendingPathComponent(name) }).first(where: {
                FileManager.default.fileExists(atPath: $0.path)
            }) else {
                throw CitizenSDKError(.integrity, "CitizenSDK resource \(name) is missing")
            }
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            guard !data.isEmpty else { throw CitizenSDKError(.integrity, "CitizenSDK resource \(name) is empty") }
            return data
        }

        // Asset identity, genesis binding and all manifest hashes are
        // revalidated by Rust during `citizensdk_create_with_modules`; Swift only
        // locates and supplies the exact packaged bytes.
        return try CitizenSDKAssets(
            manifest: read("manifest.json"),
            chainSpec: read("chainspec.json"),
            lightSyncState: read("light_sync_state.json")
        )
    }
}

private final class CitizenSDKBundleMarker: NSObject {}
