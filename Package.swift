// swift-tools-version:5.9
// Conn builds with the Command Line Tools and SwiftPM only (no Xcode). `./build.sh` wraps this into build/Conn.app.
import PackageDescription

let package = Package(
    name: "Conn",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ConnCore", targets: ["ConnCore"]),
        .executable(name: "Conn", targets: ["Conn"]),
    ],
    dependencies: [],
    targets: [
        // Everything that is not UI: Herdr protocol client, models, terminal protocol, grid decoder, editor documents.
        .target(name: "ConnCore"),
        // SwiftTerm upstream (migueldeicaza/SwiftTerm v1.99.2), pinned by tools/deps.lock, fetched into .deps/ by
        // tools/fetch-deps.sh and compiled here as a plain target (see tools/fetch-deps.sh for why it is not a SwiftPM
        // dependency). Decision B2: the terminal engine lives behind ConnCore's TerminalEngine protocol, so only
        // ConnTerminal names it.
        .target(
            name: "SwiftTerm",
            path: "Sources/SwiftTermVendored",
            exclude: ["Upstream/Mac/README.md", "Upstream/Apple/Metal/Shaders.metal"]
        ),
        // SwiftTerm adapters (engine + AppKit view) behind ConnCore's terminal protocol.
        .target(name: "ConnTerminal", dependencies: ["ConnCore", "SwiftTerm"]),
        // The Mac app.
        .executableTarget(name: "Conn", dependencies: ["ConnCore", "ConnTerminal", "SwiftTerm"]),
        // A stand-in Herdr (JSON socket server, pane stream, `herdr` CLI subset) for fixtures, tests and measurements.
        // The real Herdr lab cannot be provisioned on this Mac, so everything that writes to a pane runs against this.
        .target(name: "FakeHerdrKit", dependencies: ["ConnCore"]),
        .executableTarget(name: "FakeHerdr", dependencies: ["FakeHerdrKit", "ConnCore"]),
        // A stand-in Campus (invented conversations, the private API's shapes, a cookie-gated HTTP server with an event stream) for the same purpose:
        // fixtures, tests and `--ui-check` never talk to the real campus.shopback.com.
        .target(name: "FakeCampusKit", dependencies: ["ConnCore"]),
        .executableTarget(name: "FakeCampus", dependencies: ["FakeCampusKit"]),
        // The Herdr stream test (decision D2): latency, reconnect, CPU, compatibility.
        .executableTarget(name: "ConnStreamTest", dependencies: ["ConnCore"]),
        .testTarget(name: "ConnCoreTests", dependencies: ["ConnCore", "FakeHerdrKit", "FakeCampusKit"]),
        .testTarget(name: "ConnTerminalTests", dependencies: ["ConnCore", "ConnTerminal"]),
    ]
)
