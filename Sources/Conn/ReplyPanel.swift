// The native "Original reply" panel (README "The original reply panel"): the reply an answer sheet was made from, in a panel that floats over the whole Conn window.
// The sheet's page draws the same reply in a panel of its own, which cannot leave its web view (one Reader column or one Watch column). `WebBox.replyScript` takes that
// panel over on the page's own click: the page opens its panel, the script reads what it drew, closes it again in the same click, and hands the reply to Conn.
import SwiftUI
import WebKit
import ConnCore

@MainActor
final class ReplyPanelModel: ObservableObject {
    /// What the panel shows, or nil when it is closed.
    @Published private(set) var content: ReplyPanelContent?
    /// Where it sits (window points, top left first). nil until it has been placed once; the view places it from the window's size.
    @Published private(set) var frame: ReplyPanelFrame?
    /// How many times a reply was handed over, and the panel's web view (test hooks).
    private(set) var opened = 0
    weak var web: WKWebView?
    /// The window size the layer last measured, so a hand-off that arrives before the first layout can still be placed.
    private(set) var bounds = CGSize(width: 0, height: 0)
    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults, key: String = "conn.replyPanel.frame") {
        self.defaults = defaults
        self.key = key
        if let data = defaults.data(forKey: key), let f = try? JSONDecoder().decode(ReplyPanelFrame.self, from: data) { frame = f }
    }

    /// The person opened the original reply in a page: show it (the same panel, with the new reply, when one is already open).
    func open(_ c: ReplyPanelContent) {
        content = c
        opened += 1
        if bounds.width > 0 { place() }
    }

    func close() { content = nil }

    /// The window's size changed (or was measured for the first time): bring the panel inside it.
    func measured(_ size: CGSize) {
        guard size.width > 0, size.height > 0, size != bounds else { return }
        bounds = size
        place()
    }

    private func place() {
        let placed = (frame ?? ReplyPanelFrame.initial(in: bounds)).clamped(in: bounds)
        if placed != frame { frame = placed }
    }

    /// A drag of the header ended or moved: `by` is the distance from where it started; `from` is the frame at the start.
    func drag(from start: ReplyPanelFrame, by d: CGSize, commit: Bool) {
        frame = start.moved(by: d, in: bounds)
        if commit { save() }
    }

    func resize(from start: ReplyPanelFrame, by d: CGSize, commit: Bool) {
        frame = start.resized(by: d, in: bounds)
        if commit { save() }
    }

    /// Forget where the panel was left (a check starts from the first-time place; the next open places it afresh).
    func forgetPlace() { frame = nil; defaults.removeObject(forKey: key); if bounds.width > 0 { place() } }

    func resetPlace() { frame = ReplyPanelFrame.initial(in: bounds); save() }

    /// The code of a code box, copied. A check replaces `copied` to read it without touching the real pasteboard.
    var copied: (String) -> Void = { text in
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
    func copy(_ text: String) { copied(text) }

    private func save() {
        guard let f = frame, let data = try? JSONEncoder().encode(f) else { return }
        defaults.set(data, forKey: key)
    }
}

/// The layer in the window's stack: nothing when no reply is open, and the panel above everything else when one is. It takes no click outside the panel.
struct ReplyPanelLayer: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var model: ReplyPanelModel

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Color.clear
                if let c = model.content, let f = model.frame {
                    ReplyPanelHost(root: AnyView(ReplyPanelView(model: model, content: c, frame: f, privacy: app.privacy).environmentObject(app)))
                        .frame(width: f.width, height: f.height)
                        .offset(x: f.x, y: f.y)
                        .transition(.opacity)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .onAppear { model.measured(geo.size) }
            .onChange(of: geo.size) { _, s in model.measured(s) }
        }
        .allowsHitTesting(model.content != nil)
    }
}

/// The whole panel, header included, as one AppKit view. The Reader and the Watch columns are web views (AppKit views), which SwiftUI draws above anything it paints itself in the same
/// window: a panel made of SwiftUI shapes and text only would have its header and frame hidden behind them, and only its own web view would show. Hosted in a view of its own it stacks
/// above the columns like any other view, wherever the person drags it.
struct ReplyPanelHost: NSViewRepresentable {
    let root: AnyView
    func makeNSView(context: Context) -> NSHostingView<AnyView> {
        let v = NSHostingView(rootView: root)
        v.wantsLayer = true
        v.layer?.masksToBounds = false
        return v
    }
    func updateNSView(_ v: NSHostingView<AnyView>, context: Context) { v.rootView = root }
}

struct ReplyPanelView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var model: ReplyPanelModel
    let content: ReplyPanelContent
    let frame: ReplyPanelFrame
    let privacy: Bool
    /// The frame when the current drag began (the frame itself moves while the drag goes on).
    @State private var dragStart: ReplyPanelFrame?
    @State private var resizeStart: ReplyPanelFrame?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack {
                ReplyWebView(content: content, onLink: { app.openReplyLink($0) }, onFile: { app.openReaderFile($0) }, onCopy: { model.copy($0) }, onWeb: { model.web = $0 }).opacity(privacy ? 0 : 1)
                if privacy {
                    Text("Hidden while privacy mode is on").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.16)))
        .overlay(alignment: .bottomTrailing) { resizeHandle }
        .shadow(color: .black.opacity(0.28), radius: 18, y: 6)
        .accessibilityElement(children: .contain).accessibilityIdentifier("reply-panel")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "text.bubble").font(.system(size: 12)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(content.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                if !content.meta.isEmpty || !content.source.isEmpty {
                    Text([content.source, content.meta].filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                        .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        .redacted(reason: privacy ? .placeholder : [])
                }
            }
            Spacer(minLength: 8)
            Button { model.close() } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                .buttonStyle(.plain).frame(width: 22, height: 22).contentShape(Rectangle())
                .keyboardShortcut(.cancelAction).help("Close (Esc)").accessibilityLabel("Close the original reply").accessibilityIdentifier("reply-panel-close")
        }
        .padding(.horizontal, 10)
        .frame(height: ReplyPanelFrame.headerHeight)
        .background(Color.primary.opacity(0.05))
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 2, coordinateSpace: .global)
            .onChanged { v in
                if dragStart == nil { dragStart = frame }
                if let s = dragStart { model.drag(from: s, by: v.translation, commit: false) }
            }
            .onEnded { v in
                if let s = dragStart { model.drag(from: s, by: v.translation, commit: true) }
                dragStart = nil
            })
        .onTapGesture(count: 2) { model.resetPlace() }
        .help("Drag to move. Double-click to put it back")
    }

    /// The bottom right corner: drag to resize.
    private var resizeHandle: some View {
        Image(systemName: "arrow.down.right.and.arrow.up.left").rotationEffect(.degrees(90))
            .font(.system(size: 9)).foregroundStyle(.tertiary)
            .frame(width: 20, height: 20).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { v in
                    if resizeStart == nil { resizeStart = frame }
                    if let s = resizeStart { model.resize(from: s, by: v.translation, commit: false) }
                }
                .onEnded { v in
                    if let s = resizeStart { model.resize(from: s, by: v.translation, commit: true) }
                    resizeStart = nil
                })
            .accessibilityIdentifier("reply-panel-resize")
    }
}

/// The web view of the panel: the reader's own styles with the reply under them. Links that leave the page go to the browser; a file link opens in the Editor view as it does
/// in the reader; Copy on a code box works as in the page.
struct ReplyWebView: NSViewRepresentable {
    let content: ReplyPanelContent
    var onLink: (URL) -> Void = { _ in }
    var onFile: (String) -> Void = { _ in }
    var onCopy: (String) -> Void = { _ in }
    var onWeb: (WKWebView) -> Void = { _ in }

    func makeCoordinator() -> ReplyWebCoordinator { ReplyWebCoordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.userContentController.addUserScript(WKUserScript(source: ReplyWebCoordinator.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        cfg.userContentController.add(context.coordinator, name: ReplyWebCoordinator.message)
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.setValue(false, forKey: "drawsBackground")
        v.navigationDelegate = context.coordinator
        v.allowsBackForwardNavigationGestures = false
        context.coordinator.web = v
        context.coordinator.onLink = onLink; context.coordinator.onFile = onFile; context.coordinator.onCopy = onCopy
        context.coordinator.show(content)
        DispatchQueue.main.async { onWeb(v) }
        return v
    }

    func updateNSView(_ v: WKWebView, context: Context) {
        context.coordinator.onLink = onLink; context.coordinator.onFile = onFile; context.coordinator.onCopy = onCopy
        context.coordinator.show(content)
    }

    static func dismantleNSView(_ v: WKWebView, coordinator: ReplyWebCoordinator) {
        v.stopLoading()
        v.navigationDelegate = nil
        v.configuration.userContentController.removeScriptMessageHandler(forName: ReplyWebCoordinator.message)
    }
}

final class ReplyWebCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let message = "connReplyPanel"
    weak var web: WKWebView?
    private var shown: ReplyPanelContent?
    /// How many times a document was loaded into the panel (test hook).
    private(set) var loads = 0
    /// What the person did in the panel: a web address (opens in the browser), a file path (opens in the Editor view), the code of a code box (Copy). Set by `ReplyWebView`.
    var onLink: (URL) -> Void = { _ in }
    var onFile: (String) -> Void = { _ in }
    var onCopy: (String) -> Void = { _ in }

    func show(_ c: ReplyPanelContent) {
        guard c != shown else { return }
        shown = c
        loads += 1
        web?.loadHTMLString(ReplyPanelDocument.html(c), baseURL: nil)
    }

    /// Clicks in the panel, taken before the page sees them: a `.file-ref[data-path]` goes to the Editor view, any other link goes to the browser, and the Copy button of a code box
    /// copies its code (the page's own handler is not in this document).
    static let script = """
    (function () {
      function post(m) { try { window.webkit.messageHandlers.\(message).postMessage(m); } catch (e) {} }
      document.addEventListener('click', function (e) {
        var t = e.target;
        var copy = t && t.closest ? t.closest('button.copy') : null;
        if (copy) {
          var pre = copy.parentElement && copy.parentElement.querySelector('pre');
          if (pre) { post({ copy: pre.textContent }); copy.dataset.label = 'Copied'; setTimeout(function () { copy.dataset.label = 'Copy'; }, 1200); }
          e.preventDefault(); return;
        }
        var f = t && t.closest ? t.closest('.file-ref[data-path]') : null;
        if (f) { e.preventDefault(); post({ path: f.getAttribute('data-path') }); return; }
        var a = t && t.closest ? t.closest('a[href]') : null;
        if (a) { e.preventDefault(); post({ href: a.href }); }
      }, true);
    })();
    """

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any] else { return }
        if let text = d["copy"] as? String { DispatchQueue.main.async { [weak self] in self?.onCopy(text) }; return }
        if let p = d["path"] as? String { DispatchQueue.main.async { [weak self] in self?.onFile(p) }; return }
        if let h = d["href"] as? String, let u = URL(string: h), ["http", "https"].contains(u.scheme?.lowercased() ?? "") { DispatchQueue.main.async { [weak self] in self?.onLink(u) } }
    }

    /// The panel only ever shows its own document: any navigation the page starts is refused (a link was already taken by the script).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.navigationType == .other ? .allow : .cancel)
    }
}
