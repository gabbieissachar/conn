// Where a link clicked inside one of Conn's web panes goes.
//
// Conn shows two pages from local servers (the transcript reader on :8768 and the organizer on :8765). A link between them
// belongs inside Conn: it switches to the other pane and loads that exact address, hash included. Everything else that
// leaves the page opens in the default browser, and links inside the page stay where they are.
import Foundation

public enum WebLinkRoute: Equatable, Sendable {
    /// Let the web view handle it (same page, same origin, or not a web address at all).
    case allow
    /// Show `url` exactly as given in the pane called `pane`, and switch Conn to that pane.
    case showInPane(pane: String, url: URL)
    /// Hand it to the default browser.
    case openInBrowser(URL)
}

public enum WebLinkPolicy {
    private static let loopback: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]

    /// Same scheme and port, and the same host or two names for this machine (`localhost`, `127.0.0.1`, `::1`).
    public static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let sa = a.scheme?.lowercased(), let sb = b.scheme?.lowercased(), sa == sb, let ha = a.host?.lowercased(), let hb = b.host?.lowercased() else { return false }
        let pa = a.port ?? (sa == "https" ? 443 : 80), pb = b.port ?? (sb == "https" ? 443 : 80)
        guard pa == pb else { return false }
        return ha == hb || (loopback.contains(ha) && loopback.contains(hb))
    }

    /// `own` is the page the link was clicked in; `panes` are Conn's panes by name with their base addresses.
    public static func route(for url: URL, ownBase own: URL, panes: [String: URL]) -> WebLinkRoute {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return .allow }
        if sameOrigin(url, own) { return .allow }
        if let hit = panes.first(where: { sameOrigin(url, $0.value) }) { return .showInPane(pane: hit.key, url: url) }
        return .openInBrowser(url)
    }

    /// Whether `current` is the page at `base` (same server and path), whatever its query or fragment say. A pin that Conn had to
    /// load carries a `?conn=<n>` query, so a page Conn loaded earlier still counts as the base page.
    public static func isPage(_ base: URL, _ current: URL?) -> Bool {
        guard let c = current, let s = base.scheme?.lowercased(), s == c.scheme?.lowercased() else { return false }
        if base.isFileURL { return base.path == c.path }
        return sameOrigin(base, c) && base.path == c.path
    }

    /// Whether `url` is the page `current` already shows, apart from its fragment (then only the hash needs to change).
    public static func samePageIgnoringFragment(_ url: URL, _ current: URL?) -> Bool {
        guard let c = current else { return false }
        func strip(_ u: URL) -> String { var comps = URLComponents(url: u, resolvingAgainstBaseURL: false); comps?.fragment = nil; return comps?.string ?? u.absoluteString }
        return strip(url) == strip(c)
    }
}
