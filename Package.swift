// swift-tools-version:5.9
// Helm builds with the Command Line Tools and SwiftPM only (no Xcode). `./build.sh` wraps this into build/Helm.app.
import PackageDescription

let package = Package(
    name: "Helm",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelmCore", targets: ["HelmCore"]),
        .executable(name: "Helm", targets: ["Helm"]),
    ],
    dependencies: [],
    targets: [
        // Everything that is not UI: Herdr protocol client, models, terminal protocol, grid decoder, editor documents.
        .target(name: "HelmCore"),
        // SwiftTerm upstream (migueldeicaza/SwiftTerm v1.99.2), pinned by tools/deps.lock, fetched into .deps/ by
        // tools/fetch-deps.sh and compiled here as a plain target (see tools/fetch-deps.sh for why it is not a SwiftPM
        // dependency). Decision B2: the terminal engine lives behind HelmCore's TerminalEngine protocol, so only
        // HelmTerminal names it.
        .target(
            name: "SwiftTerm",
            path: "Sources/SwiftTermVendored",
            exclude: ["Upstream/Mac/README.md", "Upstream/Apple/Metal/Shaders.metal"]
        ),
        // SwiftTerm adapters (engine + AppKit view) behind HelmCore's terminal protocol.
        .target(name: "HelmTerminal", dependencies: ["HelmCore", "SwiftTerm"]),
        // The Mac app.
        .executableTarget(name: "Helm", dependencies: ["HelmCore", "HelmTerminal", "SwiftTerm"]),
        // A stand-in Herdr (JSON socket server, pane stream, `herdr` CLI subset) for fixtures, tests and measurements.
        // The real Herdr lab cannot be provisioned on this Mac, so everything that writes to a pane runs against this.
        .target(name: "FakeHerdrKit", dependencies: ["HelmCore"]),
        .executableTarget(name: "FakeHerdr", dependencies: ["FakeHerdrKit", "HelmCore"]),
        // The Herdr stream test (decision D2): latency, reconnect, CPU, compatibility.
        .executableTarget(name: "HelmStreamTest", dependencies: ["HelmCore"]),
        .testTarget(name: "HelmCoreTests", dependencies: ["HelmCore", "FakeHerdrKit"]),
        .testTarget(name: "HelmTerminalTests", dependencies: ["HelmCore", "HelmTerminal"]),
    ]
)
