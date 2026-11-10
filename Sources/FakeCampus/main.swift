// FakeCampus serve [--port N] [--autorun] [--step SECONDS] [--trace FILE] [--blocked-network]
// A stand-in Campus on 127.0.0.1 (invented content; see FakeCampusWorld). Conn's `--fixture` launch points its Campus web view at it
// (`CONN_CAMPUS_URL`). `--autorun` starts a scripted run that ends on a question a few seconds after the first stream opens.
import Foundation
import FakeCampusKit

func fail(_ s: String) -> Never { FileHandle.standardError.write(Data((s + "\n").utf8)); exit(2) }
var args = Array(CommandLine.arguments.dropFirst())
guard args.first == "serve" else { fail("usage: FakeCampus serve [--port N] [--autorun] [--step SECONDS] [--trace FILE] [--blocked-network]") }
args.removeFirst()
func option(_ name: String) -> String? { guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }; return args[i + 1] }

let world = FakeCampusWorld(authMode: .cookie)
if let s = option("--step").flatMap(Double.init) { world.stepDelay = s }
// `--trace FILE`: append one line per event, `<epoch milliseconds> <event type> <conversation>`, for a lab that times each hop of a request.
if let path = option("--trace") {
    FileManager.default.createFile(atPath: path, contents: nil)
    if let handle = FileHandle(forWritingAtPath: path) {
        let gate = NSLock()
        world.onEmit = { type, sid in
            gate.lock(); defer { gate.unlock() }
            handle.seekToEndOfFile()
            handle.write(Data("\(Int(Date().timeIntervalSince1970 * 1000)) \(type) \(sid)\n".utf8))
        }
    }
}
// Off the company private network the real Campus is a public ingress that answers every path with nginx's `403 Forbidden` page; `--blocked-network` starts the stand-in
// that way (`/__fake/blocked-network?on=1` and `?on=0` flip it live). `?on=1&sticky=1` also makes the refusal stick to the connections open now (after `/__fake/keep-alive?on=1`
// lets a client pool them): they keep answering it after `?on=0`, and only a new connection gets through (a connection to the public ingress that outlives the network's return).
if args.contains("--blocked-network") { world.setBlockedNetwork(true) }
let server = FakeCampusServer(world: world)
do { try server.start(port: UInt16(option("--port") ?? "0") ?? 0) } catch { fail("could not listen: \(error)") }
print("fake campus listening: http://127.0.0.1:\(server.port)")
fflush(stdout)
if args.contains("--autorun") {
    DispatchQueue.global().async {
        while world.subscriberCount == 0 { Thread.sleep(forTimeInterval: 0.25) }
        Thread.sleep(forTimeInterval: 2)
        world.startRun("ses_fakeRates01", userText: nil, ask: true)
    }
}
DispatchQueue.global().async { while true { Thread.sleep(forTimeInterval: 15); world.emitHeartbeat() } }
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
dispatchMain()
