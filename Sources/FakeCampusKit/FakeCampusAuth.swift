// The stand-in Campus without a socket: `FakeCampusAuth` is a `CampusAuth` that asks the world directly (unit tests and fixture launches that
// do not need the web view). It signs nothing: the world's `.none` mode asks for no cookie.
import Foundation
import ConnCore

public final class FakeCampusAuth: CampusAuth, @unchecked Sendable {
    public let world: FakeCampusWorld
    public var kind: String { "fake" }
    public private(set) var signInRequests = 0
    private let lock = NSLock()
    private var current: (cont: AsyncStream<CampusStreamEvent>.Continuation, task: Task<Void, Never>)?
    public private(set) var streamsOpened = 0
    /// While true every request answers as if Campus could not be reached.
    public var offline = false
    /// A test's own answer to every request (a 401 for an expired sign-in, a 503 for a Campus that is starting); nil returns the world's.
    public var override: ((CampusRequest) -> CampusReply?)?
    /// A test's own answer to opening the event stream: its status, then the reason it closes with (nil: the world's stream).
    public var streamAnswer: (status: Int, why: String?)?

    public init(world: FakeCampusWorld = FakeCampusWorld()) { self.world = world }

    public func perform(_ r: CampusRequest) async -> CampusReply? {
        if offline { return nil }
        if let o = override, let r2 = o(r) { return r2 }
        let resp = world.route(method: r.method, path: r.path, cookie: nil, body: r.body, headers: r.headers)
        return CampusReply(status: resp.status, body: resp.body)
    }

    public func openEventStream() -> AsyncStream<CampusStreamEvent> {
        streamsOpened += 1
        if let a = streamAnswer { return AsyncStream { cont in cont.yield(.opened(a.status)); cont.yield(.closed(a.why)); cont.finish() } }
        return AsyncStream { cont in
            let world = self.world
            let task = Task {
                cont.yield(.opened(200))
                for await t in world.subscribe() { if Task.isCancelled { break }; cont.yield(.text(t)) }
                cont.yield(.closed(nil)); cont.finish()
            }
            lock.lock(); current = (cont, task); lock.unlock()
            cont.onTermination = { _ in task.cancel() }
        }
    }

    public func closeEventStream() {
        lock.lock(); let c = current; current = nil; lock.unlock()
        c?.task.cancel(); c?.cont.yield(.closed("closed")); c?.cont.finish()
    }

    public func beginSignIn() { signInRequests += 1 }
}
