// Switching the macOS Focus from Conn. macOS has no public call that turns a Focus on, so Conn runs a Shortcut that Nathan makes once
// (README "Focus sessions"): `shortcuts run "Conn Focus On"` and `shortcuts run "Conn Focus Off"`, each one action, the system's Set Focus.
//
// This file is the only place that starts `/usr/bin/shortcuts`. It runs exactly two names (`FocusShortcut`), never text from anywhere else, and one
// harmless listing (`shortcuts list`, for Check Focus Setup). Every call has a time-out (a stuck shortcut must not freeze a session or the quit), and the
// child is ended if it does not stop. The executable is a parameter so the unit tests run a stub script and never the real `shortcuts`.
import Foundation

/// The two shortcuts Conn runs. Nothing else is ever passed to `shortcuts run`.
public enum FocusShortcut: String, CaseIterable, Sendable {
    case on = "Conn Focus On"
    case off = "Conn Focus Off"
}

public enum FocusSwitchResult: Equatable, Sendable {
    case done
    /// `shortcuts` ran and said no (a missing shortcut, a shortcut that stopped): the first line of what it said.
    case failed(String)
    case timedOut
    /// `shortcuts` could not be started at all.
    case unavailable(String)

    public var isDone: Bool { self == .done }

    /// A plain sentence for the red warning.
    public var problem: String? {
        switch self {
        case .done: return nil
        case .failed(let why): return why.isEmpty ? "the shortcut stopped with an error" : "the shortcut said: \(why)"
        case .timedOut: return "the shortcut did not finish in time"
        case .unavailable(let why): return "the shortcuts command could not start (\(why))"
        }
    }
}

/// What Check Focus Setup found (it only lists shortcuts; it runs none).
public enum FocusSetupStatus: Equatable, Sendable {
    case ready
    case missing([FocusShortcut])
    case unavailable(String)

    public var isReady: Bool { self == .ready }
}

/// The seam the focus coordinator uses; the real one runs `shortcuts`, a test's records the calls.
public protocol FocusSwitching: Sendable {
    /// Turn Conn Focus on or off. Never blocks the caller's thread.
    func set(on: Bool) async -> FocusSwitchResult
    /// The same, blocking, for the moment Conn quits (the app is going away and cannot wait for an async call).
    func setBlocking(on: Bool) -> FocusSwitchResult
    /// List the shortcuts and say which of the two are missing.
    func checkSetup() async -> FocusSetupStatus
}

public struct ShortcutRunner: FocusSwitching {
    public static let systemExecutable = URL(fileURLWithPath: "/usr/bin/shortcuts")

    public let executable: URL
    /// Seconds a `run` may take before it is ended.
    public var runTimeout: TimeInterval
    public var listTimeout: TimeInterval
    /// Seconds a blocking `run` may take at quit.
    public var quitTimeout: TimeInterval

    public init(executable: URL = ShortcutRunner.systemExecutable, runTimeout: TimeInterval = 10, listTimeout: TimeInterval = 8, quitTimeout: TimeInterval = 4) {
        self.executable = executable; self.runTimeout = runTimeout; self.listTimeout = listTimeout; self.quitTimeout = quitTimeout
    }

    public struct Outcome: Equatable, Sendable {
        public var status: Int32
        public var output: String
        public var timedOut: Bool
        public var launchError: String?
    }

    // MARK: FocusSwitching

    public func set(on: Bool) async -> FocusSwitchResult {
        let me = self
        return await withCheckedContinuation { c in
            DispatchQueue.global(qos: .userInitiated).async { c.resume(returning: me.runShortcut(on ? .on : .off, timeout: me.runTimeout)) }
        }
    }

    public func setBlocking(on: Bool) -> FocusSwitchResult { runShortcut(on ? .on : .off, timeout: quitTimeout) }

    public func checkSetup() async -> FocusSetupStatus {
        let me = self
        return await withCheckedContinuation { c in
            DispatchQueue.global(qos: .userInitiated).async { c.resume(returning: me.checkSetupBlocking()) }
        }
    }

    public func checkSetupBlocking() -> FocusSetupStatus {
        let o = execute(["list"], timeout: listTimeout)
        if let e = o.launchError { return .unavailable(e) }
        if o.timedOut { return .unavailable("`shortcuts list` did not finish in time") }
        if o.status != 0 { return .unavailable("`shortcuts list` stopped with status \(o.status)") }
        return Self.setupStatus(listing: o.output)
    }

    /// Which of the two shortcuts a `shortcuts list` output lacks. A name must match a whole line (trimmed), so "Conn Focus On (old)" is not "Conn Focus On".
    public static func setupStatus(listing: String) -> FocusSetupStatus {
        let names = Set(listing.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) })
        let missing = FocusShortcut.allCases.filter { !names.contains($0.rawValue) }
        return missing.isEmpty ? .ready : .missing(missing)
    }

    func runShortcut(_ s: FocusShortcut, timeout: TimeInterval) -> FocusSwitchResult {
        let o = execute(["run", s.rawValue], timeout: timeout)
        if let e = o.launchError { return .unavailable(e) }
        if o.timedOut { return .timedOut }
        if o.status != 0 { return .failed(Self.firstLine(o.output)) }
        return .done
    }

    static func firstLine(_ s: String) -> String {
        let line = s.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        return String(line.prefix(160))
    }

    // MARK: the process

    /// Run `executable arguments`, wait at most `timeout` seconds, end the child if it is still running (SIGTERM, then SIGKILL after a second).
    /// Output (both streams) is kept up to 64 KiB. The environment is the caller's.
    public func execute(_ arguments: [String], timeout: TimeInterval) -> Outcome {
        let p = Process()
        p.executableURL = executable
        p.arguments = arguments
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        let buffer = LockedBuffer(limit: 64 * 1024)
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { buffer.append(d) }
        }
        let exited = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in exited.signal() }
        do { try p.run() } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            return Outcome(status: -1, output: "", timedOut: false, launchError: error.localizedDescription)
        }
        var timedOut = false
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            p.terminate()
            if exited.wait(timeout: .now() + 1) == .timedOut { kill(p.processIdentifier, SIGKILL); _ = exited.wait(timeout: .now() + 1) }
        }
        pipe.fileHandleForReading.readabilityHandler = nil
        // What is left in the pipe, without waiting: a grandchild that still holds the pipe open must not hold this call up.
        let fd = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var chunk = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n > 0 { buffer.append(Data(chunk[0..<n])) } else { break }
        }
        return Outcome(status: timedOut ? -1 : p.terminationStatus, output: buffer.string, timedOut: timedOut, launchError: nil)
    }
}

private final class LockedBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let limit: Int
    init(limit: Int) { self.limit = limit }
    func append(_ d: Data) {
        lock.lock(); defer { lock.unlock() }
        if data.count < limit { data.append(d.prefix(limit - data.count)) }
    }
    var string: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
}
