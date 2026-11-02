// SwiftTerm v1.99.2, unmodified, is compiled from .deps/SwiftTerm through the Upstream symlink (see tools/fetch-deps.sh).
// Upstream generates these two declarations with a SwiftPM build plugin that needs the upstream package manifest;
// this repository builds the sources as a plain target instead (the manifest's dependencies cannot be resolved here),
// so the two declarations are written by hand. XTGETTCAP replies (terminal capability queries an application running
// inside the terminal could send) are disabled: Conn only draws frames Herdr already rendered.
enum SwiftTermBuildInfo {
    static let tag = "v1.99.2"
    static let branch = "conn-vendored"
    static let version = "1.99.2"
}

enum SwiftTermTerminfo {
    static let xtgettcapReplies: [String: String] = [:]
}
