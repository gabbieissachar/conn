// How Conn reaches Campus. `CampusAuth` is the one small seam between the views and the way a request is signed in: today the cookie
// (a hidden, signed-in Campus web view runs every call same-origin, so the `campus_session` cookie never leaves it and Conn's own code
// only ever receives status, JSON text and event text); an API key can replace it later by writing one more conformance, with no change
// to anything that uses this protocol. Nothing in ConnCore reads, stores, logs or copies a cookie or a token.
import Foundation

public struct CampusRequest: Equatable, Sendable {
    public var method: String
    /// Path and query, starting with `/` (never a full address: the auth decides the origin).
    public var path: String
    public var headers: [String: String]
    public var body: Data?
    public init(method: String = "GET", path: String, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method; self.path = path; self.headers = headers; self.body = body
    }
}

public struct CampusReply: Equatable, Sendable {
    public var status: Int
    public var body: Data
    /// The answer was Campus's sign-in page instead of the API (a redirect to the login): the person is signed out.
    public var loginRedirect: Bool
    public init(status: Int, body: Data = Data(), loginRedirect: Bool = false) { self.status = status; self.body = body; self.loginRedirect = loginRedirect }

    /// `403 {"error":"module_required","module":"ide"}`: the person is signed in, but the account lacks a module this call needs. A named refusal, not a sign-out.
    public var moduleRequired: Bool { status == 403 && CampusJSON.parse(body)?["error"].string == "module_required" }

    /// A 403 whose body is not Campus's own JSON error (an HTML page, empty): not Campus answering at all. Campus answers through a private network (Zscaler
    /// private access); off it, a public ingress refuses every path with an nginx `403 Forbidden` page. It says nothing about the person's sign-in.
    public var blockedByNetwork: Bool { status == 403 && CampusJSON.parse(body)?.object == nil }

    /// The sign-in is gone: a redirect to the login page, or 401. A 403 is never a sign-out: it is `moduleRequired` (signed in, a module missing), `blockedByNetwork`
    /// (the network refused the connection), or another JSON refusal that keeps its own text.
    public var signedOut: Bool { loginRedirect || status == 401 }

    /// What a refused or failed answer says to the person.
    public var failureText: String {
        if blockedByNetwork { return CampusNetworkBlock.short }
        guard moduleRequired else { return "Campus answered \(status)" }
        let name = CampusJSON.parse(body)?["module"].string.flatMap { $0.isEmpty ? nil : $0 }
        return "Signed in, but this Campus account does not have \(name.map { "the \($0) module" } ?? "a module") this needs (403 module_required)"
    }
}

public enum CampusStreamEvent: Equatable, Sendable {
    /// The stream answered with this status (200 for a good one).
    case opened(Int)
    /// Text of the stream (any split; `CampusSSEReader` puts it together).
    case text(String)
    /// The stream ended or failed; the reason is for the status line only.
    case closed(String?)
}

@MainActor
public protocol CampusAuth: AnyObject {
    /// What signs the requests: `cookie` for the signed-in web view, `key` for an API key.
    var kind: String { get }
    /// One request. nil: Campus could not be reached at all (no answer).
    func perform(_ request: CampusRequest) async -> CampusReply?
    /// Open `GET /api/events` and deliver its text. The stream ends with `.closed`; the caller reconnects.
    func openEventStream() -> AsyncStream<CampusStreamEvent>
    /// End the stream now (an idle stream is cut after 45 seconds without bytes).
    func closeEventStream()
    /// Show the sign-in (the web view's login page). A key-based auth has nothing to show and does nothing.
    func beginSignIn()
    /// Drop the connections the requests ride on, so the next request dials afresh. A network that comes back (Zscaler turned on) must not meet the answer of a connection
    /// that was open while it refused: WebKit pools a connection per website data store and reuses it for every page and fetch, so only a new store gets a new one.
    /// The sign-in stays (the session moves with the store). A key-based auth has no connection of its own and does nothing.
    func resetConnection() async
}

extension CampusAuth {
    public func resetConnection() async {}
}

/// What a read of Campus came to.
public enum CampusFetch<T> {
    case ok(T)
    /// 401 or a redirect to the login: the sign-in is gone.
    case unauthorized
    /// A 403 that is not Campus's own JSON error: the network refused the connection (`CampusNetworkBlock`).
    case blocked
    /// `503 {"error":"opencode_starting"}`: the person's Instance is booting.
    case starting
    case failed(String)
}

/// The requests Conn makes, and what they answer (scout report section 3). Paths are built from checked parts only.
@MainActor
public struct CampusClient {
    public let auth: CampusAuth
    public init(auth: CampusAuth) { self.auth = auth }

    nonisolated public static func conversationPath(_ c: CampusConversation) -> String { "/api/spaces/\(c.spaceKind)/\(c.folder)/conversations/\(c.id)" }
    nonisolated public static func conversationPath(kind: String, folder: String, id: String) -> String { "/api/spaces/\(kind)/\(folder)/conversations/\(id)" }

    /// The page of one conversation in Campus's own web app (for "Open in web").
    nonisolated public static func webURL(base: URL, kind: String, folder: String, id: String) -> URL? {
        guard CampusSpace.validFolder(folder), CampusSpace.validConversationID(id), ["private", "team"].contains(kind) else { return nil }
        return URL(string: "/spaces/\(kind)/\(folder)/conversations/\(id)", relativeTo: base)?.absoluteURL
    }

    /// A link to a conversation in Campus's web app, as a reply may carry it: `https://<campus>/spaces/<kind>/<folder>/conversations/<ses_id>`.
    nonisolated public static func conversationLink(_ url: URL, campusHost: String) -> (kind: String, folder: String, id: String)? {
        guard url.host?.lowercased() == campusHost.lowercased() else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        guard let i = parts.firstIndex(of: "spaces"), parts.count >= i + 5, parts[i + 3] == "conversations",
              ["private", "team"].contains(parts[i + 1]), CampusSpace.validFolder(parts[i + 2]), CampusSpace.validConversationID(parts[i + 4]) else { return nil }
        return (parts[i + 1], parts[i + 2], parts[i + 4])
    }

    func fetch<T>(_ r: CampusRequest, _ read: (Data) -> T?) async -> CampusFetch<T> {
        guard let reply = await auth.perform(r) else { return .failed("Campus did not answer") }
        if reply.signedOut { return .unauthorized }
        if reply.blockedByNetwork { return .blocked }
        if reply.status == 503, CampusJSON.parse(reply.body)?["error"].string == "opencode_starting" { return .starting }
        guard (200..<300).contains(reply.status) else { return .failed(reply.failureText) }
        guard let v = read(reply.body) else { return .failed("Campus answered something Conn does not know") }
        return .ok(v)
    }

    public func spaces() async -> CampusFetch<[CampusSpace]> { await fetch(CampusRequest(path: "/api/spaces"), CampusSpace.parseList) }

    public func conversations(in s: CampusSpace) async -> CampusFetch<[CampusConversation]> {
        await fetch(CampusRequest(path: "/api/spaces/\(s.kind)/\(s.folder)/conversations?limit=50")) { CampusConversation.parseList($0, space: s) }
    }

    public func status(of c: CampusConversation) async -> CampusFetch<CampusStatus> {
        await fetch(CampusRequest(path: Self.conversationPath(c) + "/status"), CampusStatus.parse)
    }

    public func openForms(of c: CampusConversation) async -> CampusFetch<[CampusForm]> {
        await fetch(CampusRequest(path: Self.conversationPath(c) + "/form")) { CampusForm.parseOpenForms($0) }
    }

    /// What the agent waits on: its questions and its permission requests, a permission first. `GET .../form` answers both lists (`{sessionIDs, permissions[], forms[]}`, scout report 3.3);
    /// when it lists nothing, `GET .../permission` is asked too (the report names it as the other place a permission is listed). Nothing is sent: both are reads.
    public func openRequests(of c: CampusConversation) async -> CampusFetch<[CampusForm]> {
        let first = await fetch(CampusRequest(path: Self.conversationPath(c) + "/form")) { CampusForm.parseOpenRequests($0) }
        guard case .ok(let list) = first, list.isEmpty else { return first }
        if case .ok(let more) = await fetch(CampusRequest(path: Self.conversationPath(c) + "/permission"), { CampusForm.parseOpenRequests($0, permissionsOnly: true) }), !more.isEmpty { return .ok(more) }
        return first
    }

    public func messages(of c: CampusConversation) async -> CampusFetch<[CampusItem]> {
        await fetch(CampusRequest(path: Self.conversationPath(c) + "/message?limit=50&order=desc"), CampusTimeline.items(fromMessages:))
    }

    /// One conversation by its address (a link Conn was handed): its row, from `GET .../<id>`.
    public func conversation(kind: String, folder: String, id: String) async -> CampusFetch<CampusConversation> {
        await fetch(CampusRequest(path: Self.conversationPath(kind: kind, folder: folder, id: id))) { data in
            guard let root = CampusJSON.parse(data) else { return nil }
            let d = root["data"].isNull ? root : root["data"]
            guard d.object != nil else { return nil }
            return CampusConversation(id: id, title: d["title"].string ?? "Untitled conversation", spaceKind: kind, folder: folder,
                                      updatedAt: d["time"]["updated"].date, agent: d["agent"].string, model: d["model"]["id"].string)
        }
    }
}
