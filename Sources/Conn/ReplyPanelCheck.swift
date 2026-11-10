// `--ui-check` steps for the native "Original reply" panel (README "The original reply panel"). The fixture's reader page and lite page each carry the answer sheet's elements as the
// reader's sheet page draws them (a button, a panel with the reply drawn into it, a Close). A click is dispatched in the page like a real one, so the whole route runs: the injected
// script, the page's own handler, the hand-off, the panel's web view, and the panel's place in the window. Fixture launches only; nothing is written except the panel's place in
// the check's own settings.
import SwiftUI
import WebKit
import ConnCore

@MainActor
enum ReplyPanelCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture else { print("ui-check: SKIP original reply panel (the fixture pages carry the sheet's elements; run with --fixture)"); return }
        let saved = (mode: model.mode, web: model.showWeb, tab: model.webTab, watch: model.watchOn)
        defer { model.replyPanel.close(); model.watchOn = saved.watch; model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab }
        func js(_ box: WebBox, _ s: String) async -> String { await ReaderPinCheck.js(box, s) }
        func panelJS(_ s: String) async -> String {
            guard let w = model.replyPanel.web else { return "no panel web view" }
            return await withCheckedContinuation { c in
                w.evaluateJavaScript(s) { r, e in c.resume(returning: e != nil ? "error: \(e!.localizedDescription)" : (r.map { "\($0)" } ?? "nil")) }
            }
        }
        func shot(_ name: String) async {
            if let d = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: d).appendingPathComponent(name)) }
        }
        var opened: [String] = [], copied: [String] = []
        model.openReplyLink = { opened.append($0.absoluteString) }
        model.replyPanel.copied = { copied.append($0) }
        defer { model.openReplyLink = { NSWorkspace.shared.open($0) }; model.replyPanel.copied = { t in NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string) } }
        model.replyPanel.close()
        model.replyPanel.forgetPlace()
        /// Open the reply the way a person does: a real click on the sheet's button (the page's own handler runs first).
        func openIn(_ b: WebBox) async -> String {
            await js(b, "(() => { const el = document.getElementById('reply-open'); return el ? String(el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))) : 'no button'; })()")
        }
        func pageClosed(_ b: WebBox) async -> Bool {
            await js(b, "String(document.getElementById('reply-panel').hidden && !document.body.classList.contains('reply-open') && sessionStorage.getItem('tr-q-reply') === '0')") == "true"
        }
        func settledOpen() async -> Bool {
            var t = 0.0
            while t < 12, model.replyPanel.content == nil || model.replyPanel.web == nil { await wait(0.1); t += 0.1 }
            await wait(0.8)
            return model.replyPanel.content != nil
        }

        // The full Reader column.
        model.watchOn = false
        model.mode = .agent; model.showWeb = true; model.webTab = .reader; model.pinReader(); await wait(0.5)
        let reader = model.web.box(.reader)
        await ReaderPinCheck.settled(reader, wait: wait)
        await wait(0.3)
        let injected = reader.webView.configuration.userContentController.userScripts.contains { $0.source.contains("#reply-open") }
        let visibleToPage = await js(reader, "String(window.__connReply)")
        report("the Reader column's page has Conn's hook for the sheet's Original reply button in a world of its own (the page cannot see it), and no reply panel is open",
               injected && visibleToPage == "undefined" && reader.phase == .ready && model.replyPanel.content == nil, "hook=\(injected) pageSees=\(visibleToPage) phase=\(reader.phase)")
        let before = model.replyPanel.opened
        let click = await openIn(reader)
        let got = await settledOpen()
        let c = model.replyPanel.content
        report("a click on Original reply hands the reply to Conn: title, the reply's own words, the conversation, and the page's styles",
               click == "true" && got && model.replyPanel.opened == before + 1 && c?.title == "Original reply" && c?.meta == "asked 10:32" && c?.source == "fm-campus-agent-scout"
                   && c?.html.contains("<table") == true && c?.html.contains("Voucher redemptions up on payday") == true && c?.css.contains(".rp-body") == true,
               "click=\(click) opened=\(model.replyPanel.opened) title=\(c?.title ?? "nil") meta=\(c?.meta ?? "nil") source=\(c?.source ?? "nil") html=\(c?.html.count ?? 0) css=\(c?.css.count ?? 0)")
        let closed = await pageClosed(reader)
        report("the page's own panel was closed again in the same click (it is not drawn in the column, the sheet did not move aside, the page does not reopen it on its own)", closed, "closed=\(closed)")

        // What the native panel draws.
        let rows = await panelJS("String(document.querySelectorAll('table tr').length)")
        let thWeight = await panelJS("getComputedStyle(document.querySelector('th')).fontWeight")
        let bodyBg = await panelJS("getComputedStyle(document.body).backgroundColor")
        let copyBtn = await panelJS("String(!!document.querySelector('button.copy'))")
        report("the panel draws the reply as the page did: the table with its header row and styles, a code box with Copy, and the page's own colours",
               rows == "4" && thWeight == "650" && copyBtn == "true" && !bodyBg.contains("rgba(0, 0, 0, 0)"), "rows=\(rows) thWeight=\(thWeight) bodyBg=\(bodyBg) copy=\(copyBtn)")
        let f0 = model.replyPanel.frame, bounds = model.replyPanel.bounds
        report("it opens inside the window, on the right, over the page rather than inside it",
               f0 != nil && bounds.width > 0 && f0!.x >= 0 && f0!.x + f0!.width <= bounds.width + 0.5 && f0!.y >= 0 && f0!.y + f0!.height <= bounds.height + 0.5 && f0!.x > bounds.width / 2 - 1,
               "frame=\(f0.map { "\($0.x),\($0.y) \($0.width)x\($0.height)" } ?? "nil") window=\(Int(bounds.width))x\(Int(bounds.height))")
        await shot("reply-panel-1-open.png")

        // Copy, a file link and a web link inside the panel.
        _ = await panelJS("document.querySelector('button.copy').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); 'x'")
        await wait(0.3)
        report("Copy on the code box copies its code", copied == ["python3 summarise.py --week 44"], "copied=\(copied)")
        _ = await panelJS("document.querySelector('a[data-ref-file=\"reply-web\"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); 'x'")
        await wait(0.3)
        report("a web link in the reply opens in the browser and the panel keeps its reply", opened == ["https://example.test/docs"] && model.replyPanel.content == c, "opened=\(opened)")
        model.toastText = nil; model.toastDetail = nil
        _ = await panelJS("document.querySelector('a[data-ref-file=\"reply-link\"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); 'x'")
        await wait(0.5)
        report("a file link in the reply goes to the Editor view's file check (here the file is missing, so a notice says so) and the panel stays", model.toastText?.hasPrefix("Conn did not open") == true && model.replyPanel.content == c,
               "toast=\(model.toastText ?? "nil")")
        model.toastText = nil; model.toastDetail = nil

        // Moving and resizing, across the whole window, remembered.
        let start = model.replyPanel.frame!
        model.replyPanel.drag(from: start, by: CGSize(width: -(bounds.width - start.width) / 2 - 40, height: 120), commit: true)
        await wait(0.3)
        let moved = model.replyPanel.frame!
        let centre = moved.x + moved.width / 2
        report("the panel can be dragged over the sidebar and the middle of the window, away from the column it came from",
               moved.x < start.x - 200 && centre < bounds.width * 0.6 && moved.y == start.y + 120 && moved.width == start.width && moved.height == start.height,
               "from=\(Int(start.x)),\(Int(start.y)) to=\(Int(moved.x)),\(Int(moved.y))")
        model.replyPanel.drag(from: moved, by: CGSize(width: -9000, height: -9000), commit: false)
        let edge = model.replyPanel.frame!
        report("dragged past the edge it stays reachable: its header stays inside the window and a strip of it stays inside at each side", edge.y == 0 && edge.x + edge.width >= ReplyPanelFrame.keepVisible, "frame=\(edge)")
        model.replyPanel.drag(from: moved, by: .zero, commit: true)
        model.replyPanel.resize(from: moved, by: CGSize(width: 90, height: 60), commit: true)
        await wait(0.4)
        let resized = model.replyPanel.frame!
        report("dragging the corner changes the size and leaves the place", resized.x == moved.x && resized.y == moved.y && resized.width == moved.width + 90 && resized.height == moved.height + 60, "frame=\(resized)")
        await shot("reply-panel-2-moved.png")
        let reread = ReplyPanelModel(defaults: AppModel.defaults, key: "conn.replyPanel.frame.fixture")
        report("the place and size are kept across a quit (read back from Conn's settings)", reread.frame == resized, "saved=\(reread.frame.map { "\($0)" } ?? "nil")")

        // The same panel with the Watch columns on.
        model.replyPanel.close()
        report("Close takes the panel away and leaves the page as it was", model.replyPanel.content == nil, "content=\(model.replyPanel.content == nil ? "nil" : "open")")
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watchOn = true
        var t = 0.0
        while t < 20, !(model.watch.boxes.count >= 1 && model.watch.boxes.values.allSatisfy { $0.phase == .ready && !$0.released }) { await wait(0.25); t += 0.25 }
        await wait(0.6)
        if let column = model.watch.layout.slots.compactMap({ $0 }).compactMap({ model.watch.boxes[$0.id] }).first {
            let hook = column.webView.configuration.userContentController.userScripts.contains { $0.source.contains("#reply-open") } ? "true" : "false"
            let beforeW = model.replyPanel.opened
            let clickW = await openIn(column)
            let gotW = await settledOpen()
            let closedW = await pageClosed(column)
            report("a Watch column hands the reply over the same way: the panel opens over the window, and the column's own page stays as it was",
                   hook == "true" && clickW == "true" && gotW && model.replyPanel.opened == beforeW + 1 && closedW && model.watchOn,
                   "hook=\(hook) click=\(clickW) opened=\(model.replyPanel.opened) pageClosed=\(closedW) watch=\(model.watchOn)")
            await shot("reply-panel-3-watch.png")
            // Stacking. A window capture lays the web views' pictures over everything, so it cannot show whether the panel's header really sits above the columns' web views;
            // a hit test can: the header's centre and a point of the panel over a column must both land inside the panel, not in a column's page.
            if let web = model.replyPanel.web, let content = web.window?.contentView {
                var host: NSView? = web.superview
                while let h = host, !(h is NSHostingView<AnyView>) { host = h.superview }
                if let host = host {
                    let r = host.convert(host.bounds, to: nil)            // window coordinates, y up
                    let overColumn = CGPoint(x: r.minX + 60, y: r.maxY - 17)  // the header, near its left end, above the first column
                    let overHeaderRight = CGPoint(x: r.maxX - 60, y: r.maxY - 17)
                    func hit(_ p: CGPoint) -> NSView? { let top = content.superview ?? content; return top.hitTest(top.convert(p, from: nil)) }   // hitTest takes a point in the receiver's superview, so ask from the window's frame view
                    let a = hit(overColumn), b = hit(overHeaderRight), mid = hit(CGPoint(x: r.midX, y: r.midY))
                    func inside(_ v: NSView?) -> Bool { v?.isDescendant(of: host) == true }
                    report("the panel's header and body sit above the columns' web views (a click on them reaches the panel, not the page under it)", inside(a) && inside(b) && inside(mid) && a !== web && b !== web,
                           "header-left=\(a.map { String(describing: type(of: $0)) } ?? "nil")\(a === web ? "(the panel's own page)" : "") header-right=\(b.map { String(describing: type(of: $0)) } ?? "nil")\(b === web ? "(the panel's own page)" : "") body=\(mid === web ? "the panel's own page" : String(describing: mid.map { type(of: $0) })) host=\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height)) web=\(Int(web.convert(web.bounds, to: nil).minY))..\(Int(web.convert(web.bounds, to: nil).maxY))")
                } else { report("the panel's header and body sit above the columns' web views", false, "no host view above the panel's web view") }
            }
            if let d = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: d).appendingPathComponent("reply-panel-4-watch-no-web-pictures.png"), webSnapshots: false) }
            // The panel stays while the person works in the window: another reply replaces it, in the same place.
            let place = model.replyPanel.frame
            _ = await openIn(column)
            await wait(0.6)
            report("a second reply replaces the first and the panel stays where it was put", model.replyPanel.content != nil && model.replyPanel.frame == place && model.replyPanel.opened == beforeW + 2,
                   "opened=\(model.replyPanel.opened) same=\(model.replyPanel.frame == place)")
        } else {
            report("a Watch column is there to open the reply in", false, "boxes=\(model.watch.boxes.count)")
        }
        model.replyPanel.close()

        // What a reply cannot do: a script in the reply does not run in the panel, a hand-off with nothing in it opens nothing, and privacy mode hides it.
        model.replyPanel.open(ReplyPanelContent(title: "Original reply", meta: "", source: "", html: "<p id=\"p\">plain</p><script>window.__ran = 1</script><img src=\"https://example.test/x.png\">", css: ""))
        await wait(1.0)
        let ran = await panelJS("String(window.__ran)")
        report("a script in a reply does not run in the panel", ran == "undefined", "ran=\(ran)")
        model.replyPanel.close()
        let none = model.web.box(.organizer).webView.configuration.userContentController.userScripts.contains { $0.source.contains("#reply-open") }
        report("the Organizer page has no reply hook", !none, "hook=\(none)")
        // A page's own script cannot reach the hand-off: it is not in the page's world.
        let before2 = model.replyPanel.opened
        let forged = await js(reader, "(() => { try { window.webkit.messageHandlers.connReply.postMessage({ html: '<p>forged</p>' }); return 'posted'; } catch (e) { return 'refused'; } })()")
        await wait(0.5)
        report("a script in the page cannot post a reply to Conn's hand-off", forged == "refused" && model.replyPanel.opened == before2 && model.replyPanel.content == nil, "result=\(forged) opened=\(model.replyPanel.opened - before2)")
    }
}
