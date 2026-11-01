import Foundation
import HelmCore
import Darwin

func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

struct Distribution {
    var values: [Double]
    func percentile(_ p: Double) -> Double {
        guard !values.isEmpty else { return .nan }
        let s = values.sorted()
        let i = min(s.count - 1, max(0, Int((p / 100 * Double(s.count - 1)).rounded())))
        return s[i]
    }
    var json: [String: Any] {
        guard !values.isEmpty else { return ["n": 0] }
        let s = values.sorted()
        return ["n": values.count, "min": r(s.first!), "p50": r(percentile(50)), "p90": r(percentile(90)), "p99": r(percentile(99)),
                "max": r(s.last!), "mean": r(values.reduce(0, +) / Double(values.count))]
    }
    private func r(_ v: Double) -> Double { (v * 100).rounded() / 100 }
}

func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    print(String(decoding: data, as: UTF8.self))
}

func option(_ name: String, _ args: [String]) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// The text of a terminal screen with trailing spaces and trailing blank rows removed, for comparing two renderings.
func normalizedScreen(_ e: TerminalEngine) -> String {
    var rows = (0..<e.rows).map { e.rowText($0) }
    while let last = rows.last, last.isEmpty { rows.removeLast() }
    return rows.joined(separator: "\n")
}

func normalizedText(_ s: String) -> String {
    var rows = s.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
        var l = String(line)
        while l.hasSuffix(" ") { l.removeLast() }
        return l
    }
    while let last = rows.last, last.isEmpty { rows.removeLast() }
    return rows.joined(separator: "\n")
}

/// Spawn and manage a child process with its own pid we can sample and signal.
final class Child {
    let process = Process()
    var pid: pid_t { process.processIdentifier }
    init(_ path: String, _ args: [String], env: [String: String] = [:], quiet: Bool = true) throws {
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        var e = ProcessInfo.processInfo.environment
        for (k, v) in env { e[k] = v }
        process.environment = e
        if quiet { process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice }
        try process.run()
    }
    func terminate() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}

func sleepUntil(_ timeout: TimeInterval, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end { if cond() { return true }; Thread.sleep(forTimeInterval: 0.02) }
    return cond()
}
