import Foundation
import CoreGraphics

// The native "Original reply" panel (README "The original reply panel"). The reader's answer sheet draws the reply a sheet was made from in a panel inside its own page,
// so the panel can never leave that web view: it stays inside a Reader column or one Watch column. Conn takes the panel over: when the person opens it, the page's own
// panel is closed again in the same click and what it drew (the reply as HTML, the page's styles) is handed to Conn, which shows it in a panel of its own that floats
// over the whole window, drags by its header, resizes from its corner and remembers where it was.
//
// This file is the part that needs no window: what a hand-off may hold, where the panel may sit, and the small document that draws it.

/// What the page hands over when the person opens the original reply.
public struct ReplyPanelContent: Equatable, Sendable {
    /// The panel's title ("Original reply").
    public var title: String
    /// The line beside it ("asked 10:32").
    public var meta: String
    /// Which conversation the sheet belongs to, so a panel that stays open while the person moves on still says where it came from. May be empty.
    public var source: String
    /// The reply, already drawn by the reader's own markdown code (tables, code boxes with their Copy buttons, lists, links). Raw HTML is switched off in that code, so a tag in a reply
    /// arrives as text; the panel's page also has a content policy that runs no script of the reply's.
    public var html: String
    /// The page's own styles, so the reply looks as it does in the conversation. Empty is allowed (the reply then draws with the panel's plain styles).
    public var css: String

    public static let maxHTML = 2_000_000
    public static let maxCSS = 600_000
    public static let maxTitle = 120
    public static let maxMeta = 200
    public static let maxSource = 160

    public init(title: String, meta: String, source: String, html: String, css: String) {
        self.title = title; self.meta = meta; self.source = source; self.html = html; self.css = css
    }

    /// The content for a hand-off the page sent, or nil when it holds no reply or the reply is too big to take whole (a cut reply would be unbalanced markup, so it is refused,
    /// not shortened). Text fields are shortened; styles that are too big are left out.
    public static func make(title: String?, meta: String?, source: String?, html: String?, css: String?) -> ReplyPanelContent? {
        guard let html = html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, html.utf8.count <= maxHTML else { return nil }
        func short(_ s: String?, _ n: Int) -> String {
            let t = (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.count > n ? String(t.prefix(n - 1)) + "\u{2026}" : t
        }
        let t = short(title, maxTitle)
        // `</` in styles could end the style element early and let the rest be read as markup; `<\/` is the same text in CSS and cannot.
        let c = (css ?? "").utf8.count <= maxCSS ? (css ?? "").replacingOccurrences(of: "</", with: "<\\/") : ""
        return ReplyPanelContent(title: t.isEmpty ? "Original reply" : t, meta: short(meta, maxMeta), source: short(source, maxSource), html: html, css: c)
    }

    /// The hand-off as the page's message body (`{ title, meta, source, html, css }`), or nil when it is not one.
    public static func parse(_ body: Any) -> ReplyPanelContent? {
        guard let d = body as? [String: Any] else { return nil }
        return make(title: d["title"] as? String, meta: d["meta"] as? String, source: d["source"] as? String, html: d["html"] as? String, css: d["css"] as? String)
    }
}

/// Where the panel sits in the window: an origin and a size in the window's own points, top left first.
public struct ReplyPanelFrame: Equatable, Codable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public static let minWidth = 280.0
    public static let minHeight = 160.0
    /// The panel is never dragged so far that its header cannot be grabbed again: this much of it stays inside the window on each side, and the header stays inside at the top.
    public static let keepVisible = 96.0
    public static let headerHeight = 34.0

    public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }

    /// Where the panel opens the first time: right of centre, below the toolbar, about as wide as a column and tall enough to read a table.
    public static func initial(in bounds: CGSize) -> ReplyPanelFrame {
        let w = min(max(minWidth, bounds.width * 0.42), 560)
        let h = min(max(minHeight, bounds.height * 0.7), 680)
        return ReplyPanelFrame(x: max(0, bounds.width - w - 28), y: min(72, max(0, bounds.height - h)), width: w, height: h).clamped(in: bounds)
    }

    /// The frame brought inside the window: at least the minimum size, no bigger than the window, the header inside at the top and bottom edges, and `keepVisible` points of the panel inside at each side.
    public func clamped(in bounds: CGSize) -> ReplyPanelFrame {
        let maxW = max(Self.minWidth, bounds.width), maxH = max(Self.minHeight, bounds.height)
        let w = min(max(width, Self.minWidth), maxW), h = min(max(height, Self.minHeight), maxH)
        let keep = min(Self.keepVisible, w)
        let nx = min(max(x, keep - w), max(keep - w, bounds.width - keep))
        let ny = min(max(y, 0), max(0, bounds.height - Self.headerHeight))
        return ReplyPanelFrame(x: nx, y: ny, width: w, height: h)
    }

    public func moved(by d: CGSize, in bounds: CGSize) -> ReplyPanelFrame {
        ReplyPanelFrame(x: x + Double(d.width), y: y + Double(d.height), width: width, height: height).clamped(in: bounds)
    }

    /// The bottom right corner dragged: the size changes, the origin stays; never below the minimum, never past the window's right and bottom edge.
    public func resized(by d: CGSize, in bounds: CGSize) -> ReplyPanelFrame {
        let w = min(max(width + Double(d.width), Self.minWidth), max(Self.minWidth, bounds.width - x))
        let h = min(max(height + Double(d.height), Self.minHeight), max(Self.minHeight, bounds.height - y))
        return ReplyPanelFrame(x: x, y: y, width: w, height: h).clamped(in: bounds)
    }
}

/// Where a hand-off may come from: the page Conn loaded (same host over http, or a file page for a fixture launch).
public enum ReplyPanelOrigin {
    public static func allows(scheme: String, host: String, pageBase: URL) -> Bool {
        if pageBase.isFileURL { return scheme == "file" }
        guard let h = pageBase.host?.lowercased(), !h.isEmpty else { return false }
        return host.lowercased() == h && (scheme == "http" || scheme == "https")
    }
}

/// The page the panel's web view shows: the reader's styles, then the reply under them.
public enum ReplyPanelDocument {
    /// A whole document for `loadHTMLString`. The reader's styles scope a reply's rules under `.rp-body`, and take their colours from the page's own variables (`--paper`, `--ink`, `--line`,
    /// `--code` ...), so the reply goes into a `.rp-body` and the page body uses the same variables: it looks as it does in the sheet's panel, light or dark. `html` is the page's `#reply-body`
    /// content (which already holds its `.md` wrapper). The content policy allows styles and `data:` pictures and nothing else, so a script in the reply does not run (the panel's own
    /// Copy and link handling are Conn's user scripts, which the policy does not apply to).
    public static func html(_ c: ReplyPanelContent) -> String {
        """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
        <meta name="color-scheme" content="light dark">
        <style>\(c.css)</style>
        <style>
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; background: var(--paper, Canvas); color: var(--ink, CanvasText); font: 14px/1.5 var(--sans, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif); -webkit-font-smoothing: antialiased; }
        .rp-body { overflow: visible; padding: 12px 18px 26px; }
        </style></head>
        <body><div class="rp-body" id="reply-body">\(c.html)</div></body></html>
        """
    }
}
