// The stand-in Campus over HTTP on 127.0.0.1, so Conn's real web-view path (a hidden web view that fetches same-origin, the sign-in page,
// the HttpOnly `campus_session` cookie, the event stream read by `fetch`) runs end to end against something that behaves like Campus's
// edges: 401 without the cookie, a login page that sets it, `503 opencode_starting`, an SSE stream. Local only; invented content.
import Foundation
import Network

public final class FakeCampusServer: @unchecked Sendable {
    public let world: FakeCampusWorld
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "fake-campus")
    public private(set) var port: UInt16 = 0

    public init(world: FakeCampusWorld) { self.world = world }

    public func start(port requested: UInt16 = 0) throws {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        let l = try NWListener(using: params, on: requested == 0 ? .any : NWEndpoint.Port(rawValue: requested)!)
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        let ready = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = l.port?.rawValue ?? 0
        world.publicBase = "http://127.0.0.1:\(port)"
        listener = l
    }

    public func stop() { listener?.cancel(); world.dropStreams() }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        read(c, Data())
    }

    private func read(_ c: NWConnection, _ acc: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self = self else { return }
            var buf = acc
            if let d = data { buf.append(d) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                var headers: [String: String] = [:]
                for l in lines.dropFirst() { if let i = l.firstIndex(of: ":") { headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
                let need = Int(headers["content-length"] ?? "0") ?? 0
                let body = buf[end.upperBound...]
                if body.count >= need { self.respond(c, lines.first ?? "", headers, Data(body.prefix(need))); return }
            }
            if done || err != nil { c.cancel(); return }
            self.read(c, buf)
        }
    }

    private func respond(_ c: NWConnection, _ requestLine: String, _ headers: [String: String], _ body: Data) {
        let p = requestLine.split(separator: " ").map(String.init)
        guard p.count >= 2 else { c.cancel(); return }
        let r = world.route(method: p[0], path: p[1], cookie: headers["cookie"], body: body, headers: headers)
        var head = "HTTP/1.1 \(r.status) \(r.status == 200 ? "OK" : r.status == 302 ? "Found" : "Status")\r\nContent-Type: \(r.contentType)\r\nCache-Control: no-cache, no-transform\r\nConnection: close\r\n"
        for (k, v) in r.headers { head += "\(k): \(v)\r\n" }
        if r.isStream {
            head += "Transfer-Encoding: chunked\r\n\r\n"
            c.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            let task = Task {
                for await t in self.world.subscribe() {
                    if Task.isCancelled { break }
                    let chunk = Data(t.utf8)
                    let framed = Data("\(String(chunk.count, radix: 16))\r\n".utf8) + chunk + Data("\r\n".utf8)
                    c.send(content: framed, completion: .contentProcessed { e in if e != nil { c.cancel() } })
                }
                c.send(content: Data("0\r\n\r\n".utf8), isComplete: true, completion: .contentProcessed { _ in c.cancel() })
            }
            c.stateUpdateHandler = { s in if case .cancelled = s { task.cancel() }; if case .failed = s { task.cancel() } }
        } else {
            head += "Content-Length: \(r.body.count)\r\n\r\n"
            let payload = Data(head.utf8) + r.body
            let send = { c.send(content: payload, isComplete: true, completion: .contentProcessed { _ in c.cancel() }) }
            if r.delay > 0 { queue.asyncAfter(deadline: .now() + r.delay, execute: send) } else { send() }
        }
    }
}
