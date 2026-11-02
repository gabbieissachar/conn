// The pane stream: what `herdr terminal session observe <pane>` prints, one JSON object per line.
//   {"type":"terminal.frame","encoding":"ansi","full":true|false,"width":W,"height":H,"seq":N,"bytes":"<base64>"}
// An observer never has resize authority: the frame is laid out for the width Herdr's own client gave the pane.
import Foundation
import Darwin

public struct TerminalFrame: Equatable, Sendable {
    public var full: Bool
    public var width: Int
    public var height: Int
    public var seq: UInt64
    public var bytes: [UInt8]
    /// Server clock (monotonic nanoseconds) when the stand-in sent the frame. Real Herdr frames carry none.
    public var sentAt: UInt64?
    /// Frames come from another program, so their geometry is checked before anything allocates for it: the largest pane
    /// the app asks Herdr for is 500 by 300 cells (a 65535 by 65535 grid would need about 69 GB).
    public static let maxCols = 500, maxRows = 300
    public var isSane: Bool {
        full ? (1...Self.maxCols).contains(width) && (1...Self.maxRows).contains(height)
             : (width == 0 || (1...Self.maxCols).contains(width)) && (height == 0 || (1...Self.maxRows).contains(height))
    }

    public init(full: Bool, width: Int, height: Int, seq: UInt64, bytes: [UInt8], sentAt: UInt64? = nil) {
        self.full = full; self.width = width; self.height = height; self.seq = seq; self.bytes = bytes; self.sentAt = sentAt
    }
}

public enum FrameCodec {
    /// Decode one stream line. Returns nil for anything that is not a well-formed ANSI frame (other event types are ignored).
    public static func decode(_ line: Data) -> TerminalFrame? {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              (obj["type"] as? String) == "terminal.frame",
              (obj["encoding"] as? String).map({ $0 == "ansi" }) ?? true,
              let b64 = obj["bytes"] as? String, let data = Data(base64Encoded: b64) else { return nil }
        let w = (obj["width"] as? Int) ?? 0, h = (obj["height"] as? Int) ?? 0
        return TerminalFrame(full: (obj["full"] as? Bool) ?? false, width: w, height: h,
                             seq: (obj["seq"] as? NSNumber)?.uint64Value ?? 0, bytes: [UInt8](data),
                             sentAt: (obj["sent_ns"] as? NSNumber)?.uint64Value)
    }

    public static func encode(_ f: TerminalFrame) -> Data {
        var obj: [String: Any] = ["type": "terminal.frame", "encoding": "ansi", "full": f.full, "width": f.width,
                                  "height": f.height, "seq": f.seq, "bytes": Data(f.bytes).base64EncodedString()]
        if let t = f.sentAt { obj["sent_ns"] = t }
        return (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
    }
}

/// Splits a byte stream into lines. A line longer than `limit` is dropped instead of buffered without bound.
public struct LineBuffer {
    private var buf = Data()
    private var dropping = false
    public let limit: Int
    public init(limit: Int = 16 << 20) { self.limit = limit }

    public mutating func append(_ chunk: Data) -> [Data] {
        var out: [Data] = []
        buf.append(chunk)
        while let nl = buf.firstIndex(of: 0x0a) {
            let line = Data(buf[buf.startIndex..<nl])
            buf.removeSubrange(buf.startIndex...nl)
            if dropping { dropping = false; continue }
            if !line.isEmpty { out.append(line) }
        }
        if buf.count > limit { buf.removeAll(); dropping = true }
        return out
    }
}

@inline(__always) public func monotonicNanos() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

public enum StreamEnd: Equatable, Sendable {
    case exited(status: Int32, stderr: String)
    case failedToStart(String)
}

public protocol PaneStreamSource: AnyObject {
    var processID: Int32? { get }
    /// `onFrame` and `onEnd` are called on `queue`.
    func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue,
               onFrame: @escaping (TerminalFrame, _ arrivedAt: UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void)
    func stop()
}

/// Runs `herdr --session <s> terminal session observe <pane> --cols C --rows R` and decodes its stdout.
public final class ObserveProcessSource: PaneStreamSource {
    public let endpoint: HerdrEndpoint
    private var process: Process?
    private var outPipe: Pipe?
    private var errPipe: Pipe?
    private let lock = NSLock()
    private var stderrTail = ""

    public var processID: Int32? {
        lock.lock(); defer { lock.unlock() }
        return process?.isRunning == true ? process?.processIdentifier : nil
    }

    public init(endpoint: HerdrEndpoint) { self.endpoint = endpoint }

    /// The only command line this source ever builds.
    public static func arguments(session: String, pane: String, cols: Int, rows: Int) -> [String]? {
        guard HerdrEndpoint.validSession(session), HerdrEndpoint.validPaneID(pane), (20...500).contains(cols), (5...300).contains(rows) else { return nil }
        return ["--session", session, "terminal", "session", "observe", pane, "--cols", "\(cols)", "--rows", "\(rows)"]
    }

    public func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue,
                      onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
        stop()
        guard let args = Self.arguments(session: endpoint.session, pane: pane, cols: cols, rows: rows) else {
            queue.async { onEnd(.failedToStart("invalid pane, session or size")) }; return
        }
        guard let bin = endpoint.binaryPath else { queue.async { onEnd(.failedToStart("herdr executable not found")) }; return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = args
        p.qualityOfService = .utility
        var env = ProcessInfo.processInfo.environment
        env["HELM_HERDR_SOCKET_DIR"] = endpoint.socketDirectory   // the stand-in CLI reads it; the real one ignores it
        env.removeValue(forKey: "HERDR_SESSION")                    // the explicit --session above is the only selector
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        var lines = LineBuffer()
        var finished = false
        let finish: (StreamEnd) -> Void = { [weak self] end in
            queue.async {
                guard !finished else { return }
                finished = true
                _ = self
                onEnd(end)
            }
        }
        out.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            let arrived = monotonicNanos()
            for line in lines.append(d) {
                if let frame = FrameCodec.decode(line) { queue.async { onFrame(frame, arrived) } }
            }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            guard let self = self else { return }
            self.lock.lock()
            self.stderrTail = String((self.stderrTail + String(decoding: d, as: UTF8.self)).suffix(400))
            self.lock.unlock()
        }
        p.terminationHandler = { [weak self] proc in
            ObserverRegistry.shared.forget(proc.processIdentifier)
            // Let the readers drain what the process wrote before it exited, then report.
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.15) {
                var tail = ""
                if let self = self { self.lock.lock(); tail = self.stderrTail; self.lock.unlock() }
                finish(.exited(status: proc.terminationStatus, stderr: tail.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
        }
        do { try p.run() } catch { finish(.failedToStart("\(error)")); return }
        ObserverRegistry.shared.record(p.processIdentifier)
        lock.lock(); process = p; outPipe = out; errPipe = err; stderrTail = ""; lock.unlock()
    }

    public func stop() {
        lock.lock()
        let p = process, o = outPipe, e = errPipe
        process = nil; outPipe = nil; errPipe = nil
        lock.unlock()
        o?.fileHandleForReading.readabilityHandler = nil
        e?.fileHandleForReading.readabilityHandler = nil
        p?.terminationHandler = nil
        if let p = p {
            if p.isRunning { p.terminate() }
            ObserverRegistry.shared.forget(p.processIdentifier)
        }
    }
}

/// Text fallback: polls `pane.read` and presents each answer as a full frame. Works across Herdr builds whose private
/// stream protocol differs from the client's, because it only uses the JSON API (stable endpoint generation).
public final class PaneReadSource: PaneStreamSource {
    public let client: HerdrClient
    public var interval: TimeInterval
    private var generation = 0
    private let lock = NSLock()
    public var processID: Int32? { nil }

    public init(client: HerdrClient, interval: TimeInterval = 1.0) { self.client = client; self.interval = interval }

    public func start(pane: String, cols: Int, rows: Int, queue: DispatchQueue,
                      onFrame: @escaping (TerminalFrame, UInt64) -> Void, onEnd: @escaping (StreamEnd) -> Void) {
        stop()
        lock.lock(); generation += 1; let g = generation; lock.unlock()
        var seq: UInt64 = 0
        var last = ""
        Thread.detachNewThread { [weak self] in
            while let self = self {
                self.lock.lock(); let current = self.generation; self.lock.unlock()
                if current != g { return }
                do {
                    let text = try self.client.readPane(pane, source: .visible, ansi: true)
                    if text != last {
                        last = text
                        seq += 1
                        let arrived = monotonicNanos()
                        let frame = Self.frame(fromText: text, cols: cols, rows: rows, seq: seq)
                        queue.async { onFrame(frame, arrived) }
                    }
                } catch {
                    queue.async { onEnd(.failedToStart("\(error)")) }
                    return
                }
                Thread.sleep(forTimeInterval: self.interval)
            }
        }
    }

    public func stop() { lock.lock(); generation += 1; lock.unlock() }

    /// `pane.read` text as one full frame: clear, then each line at its own row (lines the pane never wrapped stay whole).
    public static func frame(fromText text: String, cols: Int, rows: Int, seq: UInt64) -> TerminalFrame {
        var s = "\u{1b}[0m\u{1b}[2J"
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let shown = lines.suffix(rows)
        for (i, line) in shown.enumerated() { s += "\u{1b}[\(i + 1);1H\(line)" }
        return TerminalFrame(full: true, width: cols, height: rows, seq: seq, bytes: Array(s.utf8))
    }
}
