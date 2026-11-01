// Records the observer children this app started, so a crash cannot leave them behind.
//
// `herdr terminal session observe` on an idle pane writes nothing, so it never learns that its parent is gone (no
// EPIPE). If Helm is killed or crashes, such a child lives on. The registry remembers each child's pid; the next launch
// terminates the ones that are still running, have been re-parented to launchd (parent pid 1), and still carry the exact
// command line this app builds. Nothing else is ever signalled.
import Foundation
import Darwin

public enum ObserverRegistry {
    private static let lock = NSLock()

    static var fileURL: URL {
        if let d = ProcessInfo.processInfo.environment["HELM_STATE_DIR"], !d.isEmpty { return URL(fileURLWithPath: d).appendingPathComponent("observers.json") }
        return URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/Helm/observers.json")
    }

    private static func read() -> [Int32] {
        guard let d = try? Data(contentsOf: fileURL), let a = try? JSONSerialization.jsonObject(with: d) as? [Int] else { return [] }
        return a.map { Int32($0) }
    }

    private static func write(_ pids: [Int32]) {
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONSerialization.data(withJSONObject: pids.map { Int($0) }) { try? d.write(to: fileURL, options: .atomic) }
    }

    public static func record(_ pid: Int32) {
        lock.lock(); defer { lock.unlock() }
        var pids = read()
        if !pids.contains(pid) { pids.append(pid) }
        write(pids)
    }

    public static func forget(_ pid: Int32) {
        lock.lock(); defer { lock.unlock() }
        write(read().filter { $0 != pid })
    }

    /// True if `command` is an observer command line as ObserveProcessSource builds it.
    static func looksLikeOurObserver(_ command: String) -> Bool {
        command.contains(" --session ") && command.contains(" terminal session observe ") && command.contains(" --cols ") && command.contains(" --rows ")
    }

    /// Terminates recorded observers that are orphans of a previous run. Returns the pids it signalled.
    /// Entries of children that still have a live parent (another running instance of the app) stay on the list.
    @discardableResult
    public static func reapOrphans() -> [Int32] {
        lock.lock(); defer { lock.unlock() }
        var reaped: [Int32] = []
        var keep: [Int32] = []
        for pid in read() {
            guard let (ppid, command) = processInfo(pid), looksLikeOurObserver(command) else { continue }   // gone, or pid reused
            if ppid == 1 { if kill(pid, SIGTERM) == 0 { reaped.append(pid) } } else { keep.append(pid) }
        }
        write(keep)
        return reaped
    }

    private static func processInfo(_ pid: Int32) -> (Int32, String)? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-p", "\(pid)", "-o", "ppid=,command="]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let line = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return nil }
        let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, let ppid = Int32(parts[0]) else { return nil }
        return (ppid, " " + String(parts[1]))
    }
}
