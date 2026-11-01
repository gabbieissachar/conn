// Newline-delimited JSON over a Unix domain socket: the wire format of Herdr's JSON API.
import Foundation
import Darwin

public final class UnixLineSocket {
    private var fd: Int32
    private var buffer = Data()
    private let lock = NSLock()
    private var closed = false
    /// A line longer than this is a protocol error, not something to buffer: the real snapshot is under 100 KB.
    public var maxLineBytes = 32 << 20

    /// Connects to a listening socket. Returns nil if the path is too long for `sockaddr_un` or nothing listens there.
    public init?(path: String) {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return nil }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { Darwin.close(s); return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: bytes.count) { p in
                for (i, b) in bytes.enumerated() { p[i] = b }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, len) } }
        guard rc == 0 else { Darwin.close(s); return nil }
        fd = s
    }

    /// Wraps an accepted descriptor (server side).
    public init(adopting fd: Int32) {
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        self.fd = fd
    }

    @discardableResult
    public func writeLine(_ object: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return false }
        return writeRawLine(data)
    }

    @discardableResult
    public func writeRawLine(_ json: Data) -> Bool {
        var data = json
        data.append(0x0a)
        return data.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = write(fd, raw.baseAddress! + off, raw.count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }

    /// Blocks until a full line arrives, the peer closes, or `timeout` seconds pass (nil = wait forever).
    /// Returns nil on close, error or timeout; `timedOut` tells the last two apart.
    public private(set) var timedOut = false
    public func readLine(timeout: TimeInterval? = nil) -> Data? {
        timedOut = false
        let deadline = timeout.map { Date().addingTimeInterval($0) }
        while true {
            if let nl = buffer.firstIndex(of: 0x0a) {
                let out = Data(buffer[buffer.startIndex..<nl])
                buffer.removeSubrange(buffer.startIndex...nl)
                return out
            }
            if let deadline = deadline {
                let remaining = deadline.timeIntervalSinceNow
                if remaining <= 0 { timedOut = true; return nil }
                var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                let rc = poll(&pfd, 1, Int32(min(remaining * 1000, Double(Int32.max))))
                if rc == 0 { timedOut = true; return nil }
                if rc < 0 { if errno == EINTR { continue }; return nil }
            }
            var chunk = [UInt8](repeating: 0, count: 1 << 16)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(chunk, count: n)
            if buffer.count > maxLineBytes && !buffer.contains(0x0a) { buffer.removeAll(); return nil }
        }
    }

    public func readJSON(timeout: TimeInterval? = nil) -> [String: Any]? {
        guard let line = readLine(timeout: timeout) else { return nil }
        return (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
    }

    /// Safe to call from another thread: unblocks a pending read.
    public func shutdown() {
        lock.lock(); defer { lock.unlock() }
        if !closed { Darwin.shutdown(fd, SHUT_RDWR) }   // never touch a descriptor number that may have been reused
    }

    public func close() {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }

    deinit { close() }
}

/// A listening Unix socket (used by the stand-in Herdr).
public final class UnixListener {
    public let path: String
    private var fd: Int32 = -1

    /// Refuses (returns nil) when something already answers at `path`: a listener must never take over a live socket.
    public init?(path: String) {
        self.path = path
        if let probe = UnixLineSocket(path: path) { probe.close(); return nil }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { Darwin.close(s); return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: bytes.count) { p in
                for (i, b) in bytes.enumerated() { p[i] = b }
            }
        }
        unlink(path)
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) } }
        guard rc == 0, listen(s, 16) == 0 else { Darwin.close(s); return nil }
        fd = s
    }

    /// Blocks for the next client; nil once the listener is closed.
    public func accept() -> UnixLineSocket? {
        let c = Darwin.accept(fd, nil, nil)
        return c >= 0 ? UnixLineSocket(adopting: c) : nil
    }

    public func close() {
        guard fd >= 0 else { return }
        let f = fd; fd = -1
        Darwin.shutdown(f, SHUT_RDWR)
        Darwin.close(f)
        unlink(path)
    }

    deinit { close() }
}
