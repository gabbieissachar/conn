// FakeHerdr serve --dir DIR --session NAME [--agents N] [--working-rate R] [--protocol P]
// FakeHerdr cli --session NAME status --json | terminal session observe PANE --cols C --rows R
// `cli` is what a `herdr` shim script execs, so HELM_HERDR_BIN can point at a stand-in for the real executable.
import Foundation
import HelmCore
import FakeHerdrKit

func fail(_ s: String) -> Never { FileHandle.standardError.write(Data((s + "\n").utf8)); exit(2) }

var args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { fail("usage: FakeHerdr serve|cli ...") }
args.removeFirst()

func option(_ name: String, in a: inout [String]) -> String? {
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    let v = a[i + 1]; a.removeSubrange(i...(i + 1)); return v
}

switch mode {
case "serve":
    guard let session = option("--session", in: &args) else { fail("--session required") }
    let dir = option("--dir", in: &args) ?? HerdrEndpoint.defaultSocketDirectory
    var cfg = FakeHerdrServer.Config(directory: dir, session: session)
    if let n = option("--agents", in: &args).flatMap(Int.init) { cfg.agents = n }
    if let r = option("--working-rate", in: &args).flatMap(Double.init) { cfg.workingRate = r }
    if let f = option("--working-fraction", in: &args).flatMap(Double.init) { cfg.workingFraction = f }
    if let p = option("--protocol", in: &args).flatMap(Int.init) { cfg.serverProtocol = p }
    let server = FakeHerdrServer(config: cfg)
    do { try server.start() } catch { fail("\(error)") }
    print("fake herdr listening: \(dir)/\(session)/herdr.sock")
    fflush(stdout)
    signal(SIGTERM) { _ in exit(0) }
    signal(SIGINT) { _ in exit(0) }
    dispatchMain()
case "cli":
    guard let session = option("--session", in: &args) else { fail("--session required") }
    let endpoint = HerdrEndpoint(session: session, binaryPath: "")
    if args.first == "status" {
        // The stand-in CLI asks the live stand-in server what protocol it speaks, as the real CLI does.
        guard let sock = UnixLineSocket(path: endpoint.socketPath) else { fail("cannot connect to \(endpoint.socketPath)") }
        _ = sock
        let clientProtocol = Int(ProcessInfo.processInfo.environment["FAKE_CLIENT_PROTOCOL"] ?? "") ?? 22
        // Reuse the server's own status logic through a tiny local server query: ask for the protocol via the snapshot.
        let client = HerdrClient(endpoint: endpoint)
        let serverProtocol = ((try? client.call(.snapshot))?["result"] as? [String: Any]).flatMap { ($0["snapshot"] as? [String: Any])?["protocol"] as? Int } ?? 0
        let compatible = serverProtocol == clientProtocol
        let obj: [String: Any] = [
            "client": ["version": "fake", "channel": "stable", "protocol": clientProtocol, "endpoint_protocol_generation": 1, "session": session],
            "server": ["status": serverProtocol == 0 ? "stopped" : "running", "running": serverProtocol != 0, "version": "fake", "protocol": serverProtocol,
                       "compatible": compatible, "endpoint_compatible": true, "restart_needed": false, "server_binary_stale": false, "session": session],
            "update": ["restart_needed": false, "server_binary_stale": false],
        ]
        print(String(decoding: (try? JSONSerialization.data(withJSONObject: obj)) ?? Data(), as: UTF8.self))
    } else if args.count >= 5, args[0] == "terminal", args[1] == "session", args[2] == "observe" {
        let pane = args[3]
        var rest = Array(args.dropFirst(4))
        let cols = option("--cols", in: &rest).flatMap(Int.init) ?? 66
        let rows = option("--rows", in: &rest).flatMap(Int.init) ?? 59
        let clientProtocol = Int(ProcessInfo.processInfo.environment["FAKE_CLIENT_PROTOCOL"] ?? "") ?? 22
        // A real client and server of different protocol versions refuse to talk: mimic the protocol_mismatch error.
        let client = HerdrClient(endpoint: endpoint)
        let serverProtocol = ((try? client.call(.snapshot))?["result"] as? [String: Any]).flatMap { ($0["snapshot"] as? [String: Any])?["protocol"] as? Int } ?? 0
        if serverProtocol != 0 && serverProtocol != clientProtocol { fail("protocol_mismatch: client \(clientProtocol), server \(serverProtocol)") }
        guard let sock = UnixLineSocket(path: endpoint.fakeStreamSocketPath) else { fail("cannot connect to \(endpoint.fakeStreamSocketPath)") }
        sock.writeLine(["pane": pane, "cols": cols, "rows": rows])
        let out = FileHandle.standardOutput
        while let line = sock.readLine() {
            var d = line; d.append(0x0a)
            out.write(d)
        }
    } else {
        fail("unsupported fake herdr command: \(args.joined(separator: " "))")
    }
default:
    fail("usage: FakeHerdr serve|cli ...")
}
