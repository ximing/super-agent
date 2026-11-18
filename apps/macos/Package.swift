// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SuperAgent",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SuperAgentCore", targets: ["SuperAgentCore"]),
        .executable(name: "SuperAgent", targets: ["SuperAgentMac"])
    ],
    targets: [
        .target(name: "SuperAgentCore"),
        .executableTarget(name: "SuperAgentMac", dependencies: ["SuperAgentCore"]),
        .testTarget(name: "SuperAgentCoreTests", dependencies: ["SuperAgentCore"])
    ]
)
