// Watches an opened folder for changes by other programs, so the tree follows the disk. One FSEvents stream per folder, file-level
// events, 0.2 s latency (a burst is one call). Where a stream cannot start (some network volumes) it falls back to a 2 s poll.
import Foundation
import CoreServices

public final class FolderWatcher {
    public let root: URL
    /// True when the stream could not start and a poll stands in.
    public private(set) var isPolling = false
    private let onChange: () -> Void
    private let queue: DispatchQueue
    private var stream: FSEventStreamRef?
    private var timer: Timer?

    private final class Box { let handler: ([String]) -> Void; init(_ h: @escaping ([String]) -> Void) { handler = h } }
    private var box: Box?

    /// `onChange` runs on `queue` (the main queue unless a test says otherwise).
    public init(root: URL, queue: DispatchQueue = .main, onChange: @escaping () -> Void) {
        self.queue = queue
        // FSEvents sees through no link in the path it is given, so it gets the physical one.
        self.root = PathCopy.physical(root)
        self.onChange = onChange
    }

    /// Changes inside these folders never matter to the tree (git and build churn).
    static func isNoise(_ path: String) -> Bool {
        for part in [".git", ".build"] where path.hasSuffix("/" + part) || path.contains("/" + part + "/") { return true }
        return false
    }

    public func start() {
        guard stream == nil, timer == nil else { return }
        let box = Box { [weak self] paths in
            guard let self = self, paths.contains(where: { !Self.isNoise($0) }) else { return }
            self.onChange()
        }
        self.box = box
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(box).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info = info else { return }
            let b = Unmanaged<Box>.fromOpaque(info).takeUnretainedValue()
            let list = (unsafeBitCast(paths, to: NSArray.self) as? [String]) ?? []
            b.handler(Array(list.prefix(count)))
        }
        let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagWatchRoot)
        if let s = FSEventStreamCreate(nil, callback, &ctx, [root.path] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags) {
            FSEventStreamSetDispatchQueue(s, queue)
            if FSEventStreamStart(s) { stream = s; return }
            FSEventStreamInvalidate(s); FSEventStreamRelease(s)
        }
        isPolling = true
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.queue.async { self.onChange() }
        }
    }

    public func stop() {
        if let s = stream { FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s); stream = nil }
        timer?.invalidate(); timer = nil
        box = nil
    }

    deinit { stop() }
}
