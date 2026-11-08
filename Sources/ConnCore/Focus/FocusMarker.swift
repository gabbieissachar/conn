// The marker file other tools read to know a focus session is running (decision F14). It is a contract with the agent notifier, which skips its spoken
// "Approval needed" and "Task finished" while the file says a session is live.
//
//   ~/Library/Application Support/Conn/focus-session.json
//   {"pid": 4242, "started_at": 1793000000, "ends_at": 1793001500}
//
// `pid` is the Conn process that owns the session, `started_at` and `ends_at` are Unix seconds. While the session is paused `ends_at` is `null` (the
// session is still on, with no deadline). The file exists only while a session is running or paused: it is written when the session starts, rewritten
// on pause, resume and "+5 min", and removed when the session finishes, is stopped early, or Conn quits. A reader that finds the file checks that `pid`
// is alive (and, if it wants to be sure, that the process is older than `started_at`); a file whose owner is gone is stale and is removed by the next
// Conn launch. Written atomically: a reader never sees half a file.
import Foundation

public struct FocusMarker: Equatable, Sendable {
    public var pid: Int32
    public var startedAt: Int
    /// nil while paused.
    public var endsAt: Int?

    public init(pid: Int32, startedAt: Int, endsAt: Int?) { self.pid = pid; self.startedAt = startedAt; self.endsAt = endsAt }

    public static let fileName = "focus-session.json"

    /// `~/Library/Application Support/Conn`.
    public static func defaultDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Conn", isDirectory: true)
    }

    /// The file's text. Keys in a fixed order so the file reads the same every time.
    public var json: String {
        "{\"pid\": \(pid), \"started_at\": \(startedAt), \"ends_at\": \(endsAt.map(String.init) ?? "null")}\n"
    }

    public static func parse(_ data: Data) -> FocusMarker? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let pid = (o["pid"] as? NSNumber)?.int32Value, pid > 0,
              let start = (o["started_at"] as? NSNumber)?.intValue else { return nil }
        let end: Int?
        if let e = o["ends_at"], !(e is NSNull) { guard let n = (e as? NSNumber)?.intValue else { return nil }; end = n } else { end = nil }
        return FocusMarker(pid: pid, startedAt: start, endsAt: end)
    }
}

/// Where the marker lives and the things done to it.
public struct FocusMarkerFile: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public var url: URL { directory.appendingPathComponent(FocusMarker.fileName) }

    /// Write it atomically (a temporary file in the same folder, then a rename). Returns false when it could not be written.
    @discardableResult
    public func write(_ m: FocusMarker) -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(m.json.utf8).write(to: url, options: .atomic)
            return true
        } catch { return false }
    }

    public func read() -> FocusMarker? { (try? Data(contentsOf: url)).flatMap(FocusMarker.parse) }
    public var exists: Bool { FileManager.default.fileExists(atPath: url.path) }

    /// Remove it. True when there is no file afterwards.
    @discardableResult
    public func remove() -> Bool {
        guard exists else { return true }
        try? FileManager.default.removeItem(at: url)
        return !exists
    }

    /// At launch: remove a marker whose owner is gone. Kept when its pid is a live process (not a zombie) that started no later than the marker says
    /// (a pid that was reused by a newer process is not the owner). Nothing readable counts as stale. Returns true when it removed a file.
    @discardableResult
    public func removeIfStale(isOwnerAlive: (Int32, Int) -> Bool = FocusMarkerFile.ownerIsAlive) -> Bool {
        guard exists else { return false }
        if let m = read(), isOwnerAlive(m.pid, m.startedAt) { return false }
        return remove()
    }

    /// The pid is a live process that began no later than a second after `startedAt` (Unix seconds).
    public static func ownerIsAlive(pid: Int32, startedAt: Int) -> Bool {
        guard let info = ProcessProbe.info(pid), !info.isZombie else { return false }
        return info.startedAtMicros / 1_000_000 <= Int64(startedAt) + 1
    }
}
