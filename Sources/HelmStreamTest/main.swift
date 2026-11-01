// HelmStreamTest: the read-only Herdr stream test (decision D2) and its stand-in twin.
//   compat      --session S
//   lag         --session S [--pane ID] --seconds N
//   coldstart   --session S --rounds N
//   fleet       --session S --observers N --seconds N [--server-pid PID]
//   slow        --session S [--pane ID] --pause N
//   fake-suite  --fake-bin PATH [--out DIR]       (stand-in Herdr: latency, reconnect, mismatch, 32-pane load)
// Results are JSON on stdout. Nothing here sends text, keys, resize or lifecycle calls to Herdr.
import Foundation
import HelmCore

setvbuf(stdout, nil, _IOLBF, 0)
var args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { log("usage: HelmStreamTest compat|lag|coldstart|fleet|slow|fake-suite ..."); exit(2) }
args.removeFirst()

let session = option("--session", args) ?? "esim"
let endpoint = HerdrEndpoint(session: session)

func liveSnapshot() -> Snapshot {
    do { return try HerdrClient(endpoint: endpoint).snapshot() } catch { log("cannot read session \(session): \(error)"); exit(1) }
}

func chosenPane(_ snap: Snapshot) -> Agent {
    if let id = option("--pane", args), let a = snap.agent(id) { return a }
    guard let a = LiveTests.pickPanes(snap, count: 1).first else { log("no panes"); exit(1) }
    return a
}

switch cmd {
case "compat":
    emit(LiveTests.compat(endpoint))
case "lag":
    let snap = liveSnapshot()
    let pane = chosenPane(snap)
    emit(LiveTests.lag(endpoint, pane: pane, size: snap.paneSizes[pane.id] ?? PaneSize(cols: 66, rows: 59), seconds: Double(option("--seconds", args) ?? "60") ?? 60))
case "coldstart":
    let snap = liveSnapshot()
    emit(LiveTests.coldStart(endpoint, panes: LiveTests.pickPanes(snap, count: 8, workingFirst: false), sizes: snap.paneSizes, rounds: Int(option("--rounds", args) ?? "12") ?? 12))
case "fleet":
    emit(LiveTests.fleet(endpoint, observers: Int(option("--observers", args) ?? "1") ?? 1, seconds: Double(option("--seconds", args) ?? "60") ?? 60,
                         serverPID: option("--server-pid", args).flatMap { Int32($0) }, label: option("--label", args) ?? "fleet"))
case "slow":
    let snap = liveSnapshot()
    let pane = chosenPane(snap)
    emit(LiveTests.slowConsumer(endpoint, pane: pane, size: snap.paneSizes[pane.id] ?? PaneSize(cols: 66, rows: 59), pausedSeconds: Double(option("--pause", args) ?? "20") ?? 20))
case "fake-suite":
    guard let bin = option("--fake-bin", args) else { log("--fake-bin required"); exit(2) }
    emit(FakeSuite.run(fakeBin: bin))
default:
    log("unknown command \(cmd)"); exit(2)
}
