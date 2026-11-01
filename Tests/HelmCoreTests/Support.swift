import Foundation
import HelmCore
import FakeHerdrKit

/// A short, unique socket directory: a Unix socket path is limited to 104 bytes, so it cannot live in a deep temp path.
func shortSocketDir() -> String {
    let d = "/tmp/hf-\(getpid())-\(UInt32.random(in: 0..<1_000_000))"
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
}

func waitUntil(_ timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    return condition()
}

func makeServer(session: String = "fake1", agents: Int = 6, dir: String? = nil, configure: ((inout FakeHerdrServer.Config) -> Void)? = nil) throws -> (FakeHerdrServer, HerdrEndpoint) {
    let d = dir ?? shortSocketDir()
    var cfg = FakeHerdrServer.Config(directory: d, session: session)
    cfg.agents = agents
    configure?(&cfg)
    let server = FakeHerdrServer(config: cfg)
    try server.start()
    return (server, HerdrEndpoint(session: session, socketDirectory: d, binaryPath: ""))
}

/// Streams frames straight from the stand-in's stream socket (the real source is a child process; this skips the shim).
final class DirectStreamSource: PaneStreamSource {
    let endpoint: HerdrEndpoint
    private var sock: UnixLineSocket?
    var processID: Int32? { nil }
    init(endpoint: HerdrEndpoint) { self.endpoint = endpoint }

    func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue,
               onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
        guard let s = UnixLineSocket(path: endpoint.fakeStreamSocketPath) else { queue.async { onEnd(.failedToStart("no stream socket")) }; return }
        sock = s
        s.writeLine(["pane": pane, "cols": cols, "rows": rows])
        Thread.detachNewThread {
            while let line = s.readLine() {
                let arrived = monotonicNanos()
                if let f = FrameCodec.decode(line) { queue.async { onFrame(f, arrived) } }
            }
            queue.async { onEnd(.exited(status: 0, stderr: "")) }
        }
    }

    func stop() { sock?.shutdown(); sock = nil }
}

/// The main queue does not run under the test runner; sessions and stores report on this one instead.
let testQueue = DispatchQueue(label: "helm.tests")
