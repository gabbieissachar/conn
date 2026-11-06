// `--ui-check` steps for the Editor view's folder support (README "The Explorer" and "Opening a folder from the terminal").
// Everything runs inside the process on an invented folder in the temp directory: no real file is read, nothing is posted to the
// system, no window comes forward, and Copy Path writes to a private pasteboard, never the person's clipboard.
import SwiftUI
import AppKit
import ConnCore

@MainActor
enum ExplorerCheck {
    typealias Report = (String, Bool, String) -> Void
    typealias Wait = (Double) async -> Void

    /// An invented project, with long and deeply nested names, a large file and a binary one.
    static func makeProject() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("conn-ui-check-\(UUID().uuidString)/storefront", isDirectory: true)
        let fm = FileManager.default
        func text(_ path: String, _ body: String) throws {
            let u = root.appendingPathComponent(path)
            try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(body.utf8).write(to: u)
        }
        try text("README.md", "# Storefront\n\nAn invented project for Conn's checks.\n")
        try text("Package.swift", "// swift-tools-version:5.9\nimport PackageDescription\n")
        try text("Sources/Storefront/Checkout/PaymentSheetViewModel.swift", "struct PaymentSheetViewModel {\n    var total = 0\n}\n")
        try text("Sources/Storefront/Checkout/ApplePayEligibilityAndRegionalAvailabilityPolicy.swift", "enum ApplePayEligibilityAndRegionalAvailabilityPolicy {}\n")
        try text("Sources/Storefront/Cart/CartStore.swift", "final class CartStore {}\n")
        try text("Tests/StorefrontCoreTests/CartStoreTests.swift", "import Testing\n")
        try text("docs/design/notes.md", "# Notes\n")
        try text("assets/readme-header.png", "this is named like a picture, so it opens as a placeholder")
        try fm.createDirectory(at: root.appendingPathComponent("data"), withIntermediateDirectories: true)
        try Data(repeating: 0x78, count: TextFile.sizeLimit + 2_000_000).write(to: root.appendingPathComponent("data/events-2026-10-trace-with-a-very-long-name.jsonl"))
        try Data([0x61, 0x00, 0x62, 0x63]).write(to: root.appendingPathComponent("data/export.dat2"))
        try text(".git/HEAD", "ref: refs/heads/main\n")
        try text(".build/debug/x.o", "x")
        try text(".DS_Store", "x")
        try text(".github/workflows/ci.yml", "name: ci\n")
        return root
    }

    private static func find<T: NSView>(_ type: T.Type, in root: NSView) -> T? {
        if let v = root as? T { return v }
        for s in root.subviews { if let v = find(type, in: s) { return v } }
        return nil
    }

    private static func menuItem(_ menu: String, _ title: String) -> NSMenuItem? {
        NSApp.mainMenu?.items.first { $0.title == menu }?.submenu?.items.first { $0.title == title }
    }

    /// Runs a menu item's action. SwiftUI refreshes an item's enabled state when the menu is shown, which never happens in a
    /// check, so the state is reported by the caller where it matters and not required here.
    private static func perform(_ menu: String, _ title: String) -> Bool {
        guard let sub = NSApp.mainMenu?.items.first(where: { $0.title == menu })?.submenu, let i = sub.items.firstIndex(where: { $0.title == title }) else { return false }
        sub.performActionForItem(at: i)
        return true
    }

    private static func keys(_ i: NSMenuItem?) -> String {
        guard let i = i else { return "missing" }
        let m = i.keyEquivalentModifierMask
        return "\(m.contains(.control) ? "^" : "")\(m.contains(.option) ? "~" : "")\(m.contains(.shift) ? "$" : "")\(m.contains(.command) ? "@" : "")\(i.keyEquivalent)"
    }

    private static func shot(_ model: AppModel, _ name: String) async {
        guard model.config.fixture, let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] else { return }
        await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    }

    static func run(model: AppModel, report: Report, wait: Wait) async {
        let ed = model.editor
        let pb = NSPasteboard(name: NSPasteboard.Name("dev.local.conn.explorer-check.\(UUID().uuidString)"))
        ed.pasteboard = pb
        defer { ed.pasteboard = .general }
        guard let project = try? makeProject(), let win = Capture.mainWindow() else { report("the Explorer checks need a scratch project and a window", false, "setup failed"); return }
        let savedMode = model.mode, savedWeb = model.showWeb, savedSidebar = model.sidebarVisible
        for d in ed.docs { _ = ed.close(d) }
        ed.closeFolder()
        model.showWeb = true; model.sidebarVisible = true; model.explorerVisible = true
        win.setContentSize(NSSize(width: 1900, height: 900)); await wait(0.8)

        // MARK: menus and keys
        let items: [(String, String, String)] = [
            ("File", "Open…", "@o"), ("File", "Open Folder…", "$@o"), ("File", "Copy Path", "~@c"), ("File", "Copy Relative Path", "~$@c"),
            ("Layout", "Explorer", "@b"), ("Layout", "Focus Explorer", "$@e"), ("Layout", "Go to File…", "@p"),
            ("Layout", "Next Editor Tab", "$@]"), ("Layout", "Previous Editor Tab", "$@["),
        ]
        let wrong = items.filter { keys(menuItem($0.0, $0.1)) != $0.2 }.map { "\($0.1)=\(keys(menuItem($0.0, $0.1))) wanted \($0.2)" }
        report("the File and Layout menus carry Open Folder, Copy Path, Explorer, Go to File and the tab keys on the chosen shortcuts", wrong.isEmpty, "wrong=\(wrong)")
        let printItems = (NSApp.mainMenu?.items.first { $0.title == "File" }?.submenu?.items ?? []).filter { $0.title.hasPrefix("Print") }
        report("Cmd+P is Go to File: the File menu has no Print item", printItems.isEmpty, "print=\(printItems.map(\.title))")

        // MARK: opening a folder from outside
        model.mode = .herdr
        let req = ed.openFromOutside([project])
        model.mode = .editor; await wait(0.8)
        report("opening a folder from outside makes it the Explorer's folder", ed.folder?.root.path == project.resolvingSymlinksInPath().path && req.folder != nil && req.files.isEmpty,
               "folder=\(ed.folder?.root.path ?? "nil")")
        let labels = ed.folder?.rows.map(\.label) ?? []
        report("folders come first, a chain of single-child folders shares a row, and .git, .build and .DS_Store are hidden",
               labels == [".github/workflows", "assets", "data", "docs/design", "Sources/Storefront", "Tests/StorefrontCoreTests", "Package.swift", "README.md"], "rows=\(labels)")
        let table = find(ExplorerTableView.self, in: win.contentView!)
        report("the Explorer's table is in the window beside the editor", table != nil && (table?.numberOfRows ?? 0) == labels.count, "table rows=\(table?.numberOfRows ?? -1)")

        // MARK: tree and tabs
        let f = ed.folder!
        f.setExpanded("Sources/Storefront", true); f.setExpanded("Sources/Storefront/Checkout", true); await wait(0.3)
        let pay = f.url(for: "Sources/Storefront/Checkout/PaymentSheetViewModel.swift")
        let policy = f.url(for: "Sources/Storefront/Checkout/ApplePayEligibilityAndRegionalAvailabilityPolicy.swift")
        let cart = f.url(for: "Sources/Storefront/Cart/CartStore.swift")
        ed.open(pay, preview: true, focus: .explorer); await wait(0.3)
        report("a click opens a preview tab (italic) and leaves the keyboard in the Explorer", ed.docs.count == 1 && ed.current?.isPreview == true && ed.current?.title == "PaymentSheetViewModel.swift", "docs=\(ed.docs.map(\.title)) preview=\(ed.current?.isPreview ?? false)")
        ed.open(policy, preview: true, focus: .explorer); await wait(0.3)
        report("the next click replaces the preview tab", ed.docs.count == 1 && ed.current?.title == "ApplePayEligibilityAndRegionalAvailabilityPolicy.swift", "docs=\(ed.docs.map(\.title))")
        ed.open(policy, preview: false, focus: .editor); await wait(0.3)
        report("a double click (or Open and Keep Tab) keeps it", ed.current?.isPreview == false && ed.docs.count == 1, "preview=\(ed.current?.isPreview ?? true)")
        ed.open(pay, preview: true, focus: .explorer); await wait(0.3)
        report("the next preview is a new tab beside the kept one", ed.docs.count == 2 && ed.docs.map(\.isPreview) == [false, true], "docs=\(ed.docs.map { "\($0.title) preview=\($0.isPreview)" })")
        ed.current?.text += "// typed"; await wait(0.3)
        let dirtyRel = ed.dirtyRelativePaths()
        report("the first edit keeps a preview tab and marks the file unsaved in the tree", ed.current?.isPreview == false && ed.current?.isDirty == true && dirtyRel == ["Sources/Storefront/Checkout/PaymentSheetViewModel.swift"], "dirty=\(dirtyRel)")
        f.setExpanded("Sources/Storefront/Checkout", false); f.setExpanded("Sources/Storefront", false); await wait(0.3)
        report("a collapsed folder above an unsaved file shows the mark too", table.map { t in
            guard let row = f.rows.firstIndex(where: { $0.id == "Sources/Storefront" }), let cell = t.view(atColumn: 0, row: row, makeIfNecessary: true) else { return false }
            return cell.subviews.contains { !$0.isHidden && $0.layer?.cornerRadius == 3.5 }
        } ?? false, "rows=\(f.rows.map(\.id))")
        ed.current?.text = ed.current?.savedText ?? ""
        ed.open(cart, preview: false, focus: .editor); await wait(0.3)
        ed.selectedID = ed.docs.first { $0.title == "PaymentSheetViewModel.swift" }?.id; await wait(0.3)
        report("the tree follows the active tab: it expands the folders and selects the row", f.selection == "Sources/Storefront/Checkout/PaymentSheetViewModel.swift" && f.rows.contains { $0.id == f.selection }, "selection=\(f.selection ?? "nil")")
        await shot(model, "explorer-open-folder.png")

        // MARK: hide, show, focus
        let handledB = await AgentViewCheck.press("b", 11, [.command], wait: wait)
        await wait(0.4)
        let flag1 = model.explorerVisible, table1 = find(ExplorerTableView.self, in: win.contentView!) != nil
        let handledB2 = await AgentViewCheck.press("b", 11, [.command], wait: wait)
        await wait(0.4)
        let flag2 = model.explorerVisible, table2 = find(ExplorerTableView.self, in: win.contentView!) != nil
        report("Cmd+B hides the Explorer and Cmd+B shows it again, with the open tabs kept", handledB && handledB2 && !flag1 && !table1 && flag2 && table2 && ed.docs.count == 3,
               "handled=\(handledB)/\(handledB2) hidden: flag=\(!flag1) table gone=\(!table1); shown again: flag=\(flag2) table=\(table2) docs=\(ed.docs.count) item enabled=\(menuItem("Layout", "Explorer")?.isEnabled ?? false)")
        let didFocus = perform("Layout", "Focus Explorer"); await wait(0.8)
        let tableNow = find(ExplorerTableView.self, in: win.contentView!)
        let focusedIn = ed.explorerFocused && win.firstResponder === tableNow
        let firstIn = String(describing: win.firstResponder).prefix(40)
        _ = perform("Layout", "Focus Explorer"); await wait(0.8)
        let focusedOut = !ed.explorerFocused && win.firstResponder is NSTextView
        report("Shift+Cmd+E moves the keyboard to the Explorer and back to the editor", didFocus && focusedIn && focusedOut,
               "in=\(focusedIn) (explorerFocused=\(ed.explorerFocused) first=\(firstIn)) out=\(focusedOut) first=\(String(describing: win.firstResponder).prefix(40)) windowKey=\(win.isKeyWindow) enabled=\(menuItem("Layout", "Focus Explorer")?.isEnabled ?? false)")

        // MARK: copy path
        let url = ed.current!.url!
        ed.explorerFocused = false
        ed.copyPath(relative: false)
        let p1 = pb.string(forType: .string)
        ed.copyPath(relative: true)
        let p2 = pb.string(forType: .string)
        report("Copy Path copies the open file's full path and Copy Relative Path its path below the folder, with a confirmation that shows the text",
               p1 == url.path && p2 == "Sources/Storefront/Checkout/PaymentSheetViewModel.swift" && model.toastText == "Copied relative path" && model.toastDetail == p2, "path=\(p1 ?? "nil") relative=\(p2 ?? "nil") toast=\(model.toastText ?? "nil")/\(model.toastDetail ?? "nil")")
        f.selection = "docs/design"; ed.explorerFocused = true
        ed.copyPath(relative: false)
        let p3 = pb.string(forType: .string)
        ed.copyPath(relative: true)
        let p4 = pb.string(forType: .string)
        report("with the Explorer focused the same copies act on the selected row, a folder row too", p3?.hasSuffix("/storefront/docs/design") == true && p4 == "docs/design", "path=\(p3 ?? "nil") relative=\(p4 ?? "nil")")
        ed.explorerFocused = false
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("conn-outside-\(UUID().uuidString).md")
        try? Data("outside".utf8).write(to: outside)
        ed.open(outside, focus: .editor); await wait(0.3)
        ed.copyPath(relative: true)
        report("Copy Relative Path of a file outside the folder copies the full path and says so", pb.string(forType: .string) == outside.path && model.toastText == "Copied path (outside the folder)", "toast=\(model.toastText ?? "nil")")
        ed.newDocument(); await wait(0.3)
        pb.clearContents(); pb.setString("sentinel", forType: .string)
        ed.copyPath(relative: false)
        report("an unsaved document has no path: nothing is copied and the toast says to save it", pb.string(forType: .string) == "sentinel" && model.toastText?.hasPrefix("Nothing to copy") == true, "toast=\(model.toastText ?? "nil")")
        if let d = ed.current { _ = ed.close(d) }
        ed.selectedID = ed.docs.first { $0.title == "PaymentSheetViewModel.swift" }?.id; await wait(0.3)
        pb.clearContents()
        let didKeyPath = perform("File", "Copy Path")
        await wait(0.3)
        let didKeyRel = (pb.string(forType: .string) != nil)
        let afterPath = pb.string(forType: .string)
        _ = perform("File", "Copy Relative Path")
        await wait(0.3)
        report("the Copy Path and Copy Relative Path menu items (Opt+Cmd+C, Opt+Shift+Cmd+C) copy for the open file", didKeyPath && didKeyRel && afterPath == url.path && pb.string(forType: .string) == "Sources/Storefront/Checkout/PaymentSheetViewModel.swift",
               "path=\(afterPath ?? "nil") enabled=\(menuItem("File", "Copy Path")?.isEnabled ?? false) mode=\(model.mode.rawValue)")
        if let t = find(ExplorerTableView.self, in: win.contentView!), let row = f.rows.firstIndex(where: { $0.kind == .file }), let m = t.menuForRow?(row) {
            report("a right click on a row offers Open, Open and Keep Tab, Reveal in Finder, Copy Path and Copy Relative Path", m.items.filter { !$0.isSeparatorItem }.map(\.title) == ["Open", "Open and Keep Tab", "Reveal in Finder", "Copy Path", "Copy Relative Path"], "items=\(m.items.map(\.title))")
        } else { report("a right click on a row offers its menu", false, "no table or file row") }

        // MARK: large and binary files
        let big = f.url(for: "data/events-2026-10-trace-with-a-very-long-name.jsonl")
        ed.open(f.url(for: "data/events-2026-10-trace-with-a-very-long-name.jsonl"), preview: true, focus: .explorer); await wait(0.5)
        let large = ed.current
        report("a text file over 5 MB opens read-only as its first megabyte, without an alert", large?.kind == .large && large?.isReadOnly == true && (large?.text.utf8.count ?? 0) <= TextFile.headLimit && (large?.text.isEmpty == false) && ed.alert == nil && large?.url == big,
               "kind=\(large?.kind.rawValue ?? "nil") chars=\(large?.text.count ?? 0) alert=\(ed.alert ?? "nil")")
        report("a large file cannot be saved or made unsaved", { () -> Bool in guard let d = large else { return false }; d.text += "x"; ed.save(d); return !d.isDirty && ed.alert != nil }(), "alert=\(ed.alert ?? "nil")")
        ed.alert = nil
        await shot(model, "explorer-large-file.png")
        ed.open(f.url(for: "assets/readme-header.png"), preview: true, focus: .explorer); await wait(0.5)
        let png = ed.current
        let placeholder = find(NSHostingView<BinaryPlaceholder>.self, in: win.contentView!) != nil
        report("a file with a picture's name opens as a placeholder, not as text", png?.kind == .binary && png?.text.isEmpty == true && ed.alert == nil, "kind=\(png?.kind.rawValue ?? "nil") hostedPlaceholder=\(placeholder)")
        await shot(model, "explorer-binary-file.png")
        ed.open(f.url(for: "data/export.dat2"), preview: true, focus: .explorer); await wait(0.3)
        report("a file with a NUL byte opens as a placeholder too", ed.current?.kind == .binary && ed.alert == nil, "kind=\(ed.current?.kind.rawValue ?? "nil")")

        // MARK: the Reader and the width rule
        ed.selectedID = ed.docs.first { $0.title == "PaymentSheetViewModel.swift" }?.id
        win.setContentSize(NSSize(width: 1500, height: 900)); await wait(1.0)
        let narrow = model.readerSteppedAside
        let webInWindow1 = model.web.allBoxes.contains { $0.webView.window != nil }
        report("at 1500 pt with the Explorer open the Reader column steps aside by itself", narrow && !model.readerShown && model.showWeb && !webInWindow1, "aside=\(narrow) shown=\(model.readerShown) webInWindow=\(webInWindow1)")
        await shot(model, "explorer-1500-reader-aside.png")
        model.readerToggle = true; await wait(0.6)
        report("showing the Reader by hand keeps it, even without the room", model.readerShown && model.readerForced && !model.readerSteppedAside, "shown=\(model.readerShown) forced=\(model.readerForced)")
        await shot(model, "explorer-1500-reader-forced.png")
        win.setContentSize(NSSize(width: 1900, height: 900)); await wait(1.0)
        report("with room again the Reader stays and the forced mark is cleared", model.readerShown && !model.readerForced && !model.readerSteppedAside, "shown=\(model.readerShown) forced=\(model.readerForced)")
        win.setContentSize(NSSize(width: 1000, height: 700)); await wait(1.0)
        let tv = find(NSTextView.self, in: win.contentView!)
        let scrollW = tv?.enclosingScrollView?.frame.width ?? 0
        report("in the smallest window the Reader is aside and the editor keeps at least 420 pt", model.readerSteppedAside && scrollW >= 420, "editorWidth=\(Int(scrollW)) aside=\(model.readerSteppedAside) window=\(Int(win.contentView?.frame.width ?? 0))")
        ed.selectedID = ed.docs.first { $0.title == "PaymentSheetViewModel.swift" }?.id; await wait(0.6)
        await shot(model, "explorer-1000-narrow.png")
        win.setContentSize(NSSize(width: 1900, height: 900)); await wait(0.8)

        // MARK: another program changes the folder
        f.setExpanded("docs/design", true)
        let added = project.appendingPathComponent("docs/design/added-by-another-program.md")
        try? Data("new".utf8).write(to: added)
        var seen = false
        for _ in 0..<30 { await wait(0.2); if f.rows.contains(where: { $0.id == "docs/design/added-by-another-program.md" }) { seen = true; break } }
        report("a file added by another program appears in the tree (\(f.isPolling ? "2 s poll" : "FSEvents"))", seen, "polling=\(f.isPolling)")
        let doomed = project.appendingPathComponent("docs/design/notes.md")
        ed.open(doomed, focus: .editor); await wait(0.3)
        try? FileManager.default.moveItem(at: doomed, to: FileManager.default.temporaryDirectory.appendingPathComponent("conn-moved-\(UUID().uuidString).md"))
        var deleted = false
        for _ in 0..<20 { await wait(0.25); if ed.current?.deletedOnDisk == true { deleted = true; break } }
        report("a file deleted by another program is marked deleted in its tab and the text stays", deleted && ed.current?.text == "# Notes\n", "deleted=\(deleted)")
        await shot(model, "explorer-deleted-file.png")
        if let d = ed.current { try? d.save() }
        report("Save to Restore writes it back", ed.current?.deletedOnDisk == false && FileManager.default.fileExists(atPath: doomed.path), "exists=\(FileManager.default.fileExists(atPath: doomed.path))")

        // MARK: Go to File
        ed.showQuickOpen()
        for _ in 0..<30 { await wait(0.2); if ed.quickOpen?.loading == false { break } }
        ed.quickOpen?.query = "pay"
        let top = ed.quickOpen?.results.first
        report("Go to File reads the folder and puts the best match first", ed.quickOpen?.loading == false && top == "Sources/Storefront/Checkout/PaymentSheetViewModel.swift" && !(ed.quickOpen?.results.contains { $0.hasPrefix(".git/") || $0.hasPrefix(".build/") } ?? true),
               "top=\(top ?? "nil") n=\(ed.quickOpen?.results.count ?? 0)")
        ed.closeQuickOpen()

        // MARK: from an agent and from the terminal
        let other = project.appendingPathComponent("docs")
        let agent = Agent(id: "check:1", name: "check", harness: "claude", state: .idle, workspaceID: "w", tabID: "t", sessionID: nil, cwd: other.path)
        model.mode = .herdr
        model.openWorkingFolder(of: agent); await wait(0.5)
        report("Open Working Folder in Editor shows the agent's folder in the Explorer and switches to the Editor view", model.mode == .editor && ed.folder?.root.path == other.resolvingSymlinksInPath().path && ed.docs.count > 0, "mode=\(model.mode.rawValue) folder=\(ed.folder?.root.path ?? "nil")")
        // `conn .` reaching a running Conn: the folder switches, open tabs stay, nothing unsaved is touched.
        let tabsBefore = ed.docs.count
        let _ = ed.openFromOutside([project, other])
        report("a folder from `conn` switches the Explorer and keeps every open tab; a second folder in the call is ignored with a note", ed.folder?.root.lastPathComponent == "storefront" && ed.docs.count == tabsBefore && model.toastText?.hasPrefix("Opened storefront") == true, "folder=\(ed.folder?.root.lastPathComponent ?? "nil") docs=\(ed.docs.count) toast=\(model.toastText ?? "nil")")
        // Cold start, both orders of the request and the restore.
        let suite = "dev.local.conn.explorer-check.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let a = project.appendingPathComponent("docs"), keep = project.appendingPathComponent("README.md"), asked = project.appendingPathComponent("Package.swift")
        let first = EditorModel(defaults: defaults)       // an earlier run: it remembers a folder and README.md
        first.restoreSession()
        first.openFromOutside([a, keep])
        let before = EditorModel(defaults: defaults)       // the request arrives before the session is restored
        before.openFromOutside([project, asked])
        before.restoreSession()
        let after = EditorModel(defaults: defaults)        // the request arrives after the session is restored
        after.restoreSession()
        after.openFromOutside([project, asked])
        let titles: (EditorModel) -> [String] = { $0.docs.map(\.title) }
        report("cold start: the command's folder wins over the remembered one, remembered files stay, and the file it named is the open tab (request first)",
               before.folder?.root.lastPathComponent == "storefront" && Set(titles(before)) == ["Package.swift", "README.md"] && before.current?.title == "Package.swift", "folder=\(before.folder?.root.lastPathComponent ?? "nil") docs=\(titles(before)) current=\(before.current?.title ?? "nil")")
        report("cold start: the same when the session is restored first", after.folder?.root.lastPathComponent == "storefront" && Set(titles(after)) == ["Package.swift", "README.md"] && after.current?.title == "Package.swift", "folder=\(after.folder?.root.lastPathComponent ?? "nil") docs=\(titles(after)) current=\(after.current?.title ?? "nil")")
        _ = first

        // MARK: the `conn` command's link
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("conn-ui-check-home-\(UUID().uuidString)")
        let script = home.appendingPathComponent("Apps/Conn.app/Contents/Resources/bin/conn")
        try? FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data("#!/bin/sh\n".utf8).write(to: script)
        let savedState = model.connCommand
        let o1 = model.installConnCommand(script: script, home: home, environmentPath: "/usr/bin")
        let link = ConnCommandLink.link(home: home)
        let o2 = model.uninstallConnCommand(script: script, home: home)
        report("File > Install 'conn' Command links ~/.local/bin/conn to the script in the app, says when ~/.local/bin is not on the PATH, and Uninstall removes only that link",
               !o1.failed && o1.message.contains("export PATH") && !o2.failed && !FileManager.default.fileExists(atPath: link.path) && FileManager.default.fileExists(atPath: script.path), "install=\(o1.title) uninstall=\(o2.title)")
        model.connCommand = savedState

        // Leave the window as it was.
        for d in ed.docs { d.isPreview = false; if d.isDirty { d.text = d.savedText }; _ = ed.close(d) }
        ed.closeFolder()
        // The check ran in the test domain; it leaves nothing of its scratch folders there.
        for k in [EditorModel.Keys.recent, EditorModel.Keys.expanded, EditorModel.Keys.folder] { AppModel.defaults.removeObject(forKey: k) }
        model.mode = savedMode; model.showWeb = savedWeb; model.sidebarVisible = savedSidebar
        win.setContentSize(NSSize(width: 1500, height: 900)); await wait(0.5)
    }
}
