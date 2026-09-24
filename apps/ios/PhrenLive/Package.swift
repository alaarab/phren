// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "PhrenLive",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "PhrenLive", targets: ["PhrenLive"])],
    dependencies: [
        .package(path: "../PhrenKit"),
        .package(url: "https://github.com/apple/swift-nio-ssh.git", exact: "0.15.0"),
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.102.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", exact: "4.5.2"),
    ],
    targets: [
        .target(name: "PhrenLive", dependencies: [
            "PhrenKit",
            .product(name: "NIOSSH", package: "swift-nio-ssh"),
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOPosix", package: "swift-nio"),
            .product(name: "NIOHTTP1", package: "swift-nio"),
            .product(name: "NIOWebSocket", package: "swift-nio"),
            .product(name: "NIOConcurrencyHelpers", package: "swift-nio"),
            .product(name: "Crypto", package: "swift-crypto"),
        ]),
        .testTarget(name: "PhrenLiveTests", dependencies: [
            "PhrenLive", .product(name: "NIOEmbedded", package: "swift-nio")
        ]),
    ],
    swiftLanguageModes: [.v5]
)
