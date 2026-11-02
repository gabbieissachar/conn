// Footprint and CPU time of a process, from proc_pid_rusage: the same call the baseline measurement used, so numbers
// taken here are comparable with the 4.09 GB / 15.5% figure for the VS Code setup.
import Foundation
import Darwin

public struct ProcessUsage: Equatable, Sendable {
    public var footprint: UInt64      // phys_footprint, bytes
    public var cpuNanos: UInt64       // user + system time

    public static func read(_ pid: pid_t) -> ProcessUsage? {
        var info = rusage_info_current()
        let rc = withUnsafeMutablePointer(to: &info) { p in
            p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_CURRENT, $0) }
        }
        guard rc == 0 else { return nil }
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        let ns = (info.ri_user_time &+ info.ri_system_time) &* UInt64(tb.numer) / UInt64(tb.denom)
        return ProcessUsage(footprint: info.ri_phys_footprint, cpuNanos: ns)
    }

    public static var mebibyte: Double { 1_048_576 }
}

/// Samples CPU between calls for a changing set of processes.
public struct CPUSampler {
    private var last: (t: UInt64, ns: [pid_t: UInt64])?
    public init() {}

    /// CPU as a percentage of one core since the previous call (0 on the first call or when the window is under `minWindow` seconds).
    public mutating func sample(pids: [pid_t], minWindow: Double = 0.5) -> Double {
        var now: [pid_t: UInt64] = [:]
        for pid in pids { if let u = ProcessUsage.read(pid) { now[pid] = u.cpuNanos } }
        let t = monotonicNanos()
        defer { last = (t, now) }
        guard let l = last else { return 0 }
        let dt = Double(t &- l.t) / 1e9
        guard dt >= minWindow else { return 0 }
        var d: UInt64 = 0
        for (pid, ns) in now { if let prev = l.ns[pid], ns >= prev { d += ns - prev } }
        return Double(d) / 1e9 / dt * 100
    }
}
