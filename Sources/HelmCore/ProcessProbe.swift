// What the kernel says about another process, without spawning `ps`: parent pid, start time, state and argv.
//
// A pid alone does not identify a process (pids are reused), so anything that decides to signal a process by pid also
// compares the start time it recorded. Both calls work for processes of the same user, which is all the observer
// registry ever asks about.
import Foundation
import Darwin

public enum ProcessProbe {
    public struct Info: Equatable, Sendable {
        public var ppid: Int32
        /// Start time in microseconds since 1970: with the pid, the identity of one process.
        public var startedAtMicros: Int64
        /// Exited but not yet collected by its parent: it can no longer run or hold anything.
        public var isZombie: Bool
    }

    /// Nil if no such process exists.
    public static func info(_ pid: Int32) -> Info? {
        guard pid > 0 else { return nil }
        var bsd = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, size) == size else { return nil }
        let micros = Int64(bsd.pbi_start_tvsec) &* 1_000_000 &+ Int64(bsd.pbi_start_tvusec)
        return Info(ppid: Int32(bitPattern: bsd.pbi_ppid), startedAtMicros: micros, isZombie: bsd.pbi_status == 5 /* SZOMB */)
    }

    /// True if the process with this pid exists, is not a zombie and, when `startedAtMicros` is given, started at that time.
    public static func isAlive(_ pid: Int32, startedAtMicros: Int64? = nil) -> Bool {
        guard let i = info(pid), !i.isZombie else { return false }
        if let t = startedAtMicros { return i.startedAtMicros == t }
        return true
    }

    /// The process's argv (`KERN_PROCARGS2`: argc, the executable path, then argc strings). Nil if unreadable.
    public static func arguments(_ pid: Int32) -> [String]? {
        guard pid > 0 else { return nil }
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return nil }
        let argc = Int(buf.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) })
        guard argc >= 0 else { return nil }
        var i = 4
        while i < size, buf[i] != 0 { i += 1 }      // the executable path
        while i < size, buf[i] == 0 { i += 1 }      // padding
        var args: [String] = []
        while args.count < argc, i < size {
            var j = i
            while j < size, buf[j] != 0 { j += 1 }
            args.append(String(decoding: buf[i..<j], as: UTF8.self))
            i = j + 1
        }
        return args
    }

    /// The identity of this process.
    public static var current: (pid: Int32, startedAtMicros: Int64) {
        let pid = getpid()
        return (pid, info(pid)?.startedAtMicros ?? 0)
    }
}
