// The web side of the silent refresh, without a web view (unit tests): a `CampusRenewing` that keeps a cookie jar of its own and visits the stand-in's
// `/campus/login` the way a hidden web view would, following redirects and taking Set-Cookie. It stands still on the first page that is not a redirect and says
// whether that is Campus, Campus's login page or another site (a 403 is the network refusing the connection). It never answers a page: the stand-in's pages only wait.
import Foundation
import ConnCore

@MainActor
public final class FakeCampusRenewer: CampusRenewing {
    public let world: FakeCampusWorld
    /// Campus's host as Conn knows it (the host of the address the stand-in says it lives at).
    public let campusHost: String
    private var jar: String?
    public private(set) var attempts = 0
    /// While set, `sessionExpiry` answers this instead of the jar (the cookie store without a session).
    public var overrideExpiry: Date??

    public init(world: FakeCampusWorld) {
        self.world = world
        campusHost = URL(string: world.publicBase)?.host ?? "campus.example.test"
    }

    /// The person signs in by hand: the login page's own click, which sets the cookie.
    public func signIn() { take(world.route(method: "GET", path: "/campus/login/ok", cookie: nil, body: nil)) }

    /// The cookie goes away (a cleared cookie store).
    public func clearCookie() { jar = nil }

    private func take(_ r: FakeCampusResponse) {
        guard let set = r.headers["Set-Cookie"], set.hasPrefix("campus_session=") else { return }
        jar = String(set.split(separator: ";")[0])
    }

    public func sessionExpiry() async -> Date? {
        if let o = overrideExpiry { return o }
        guard let jar = jar, let value = jar.split(separator: "=", maxSplits: 1).last else { return nil }
        return CampusSessionToken.expiry(of: String(value))
    }

    public func attemptRenewal(timeout: TimeInterval) async -> CampusRenewalResult {
        attempts += 1
        var url = URL(string: world.publicBase + "/campus/login")!
        for _ in 0..<10 {
            // A page of another site has its own cookies; the stand-in's pages there only wait, so there is nothing to carry.
            guard url.host == campusHost else { return CampusRenewalResult(settled: .elsewhere) }
            let r = world.route(method: "GET", path: url.path, cookie: jar, body: nil, headers: ["host": url.host ?? ""])
            if r.delay > timeout { try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)); return CampusRenewalResult(timedOut: true) }
            if r.status == 403 { return CampusRenewalResult(blocked: true) }            // the page the network answers with: refused, not a page that waits for a click
            take(r)
            if r.status == 302, let loc = r.headers["Location"], let next = URL(string: loc, relativeTo: url)?.absoluteURL { url = next; continue }
            return CampusRenewalResult(settled: CampusRenewalRules.page(for: url, campusHost: campusHost))
        }
        return CampusRenewalResult(failed: true)
    }
}
