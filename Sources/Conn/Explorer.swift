// The Explorer: the folder browser beside the Editor view's text (README "The Explorer"). A header in Conn's sidebar style, a table of
// rows from ConnCore.FolderTree, and Go to File. The tree is a flat NSTableView, not an outline view: the rows are already flat
// (compact chains are one row), so type-to-select, arrow keys and Conn's own selection look are plain code here.
import SwiftUI
import AppKit
import ConnCore

/// The symbol for a file or folder row and for a tab.
enum FileGlyph {
    static func symbol(name: String, isFolder: Bool, isLoop: Bool = false) -> String {
        if isLoop { return "arrow.triangle.2.circlepath" }
        if isFolder { return "folder" }
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "md", "markdown", "mdown": return "text.alignleft"
        case "swift", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "c", "h", "m", "cpp", "java", "kt", "sh", "zsh": return "chevron.left.forwardslash.chevron.right"
        case "json", "jsonl", "plist": return "curlybraces"
        case "yml", "yaml", "toml": return "list.bullet"
        case "png", "jpg", "jpeg", "gif", "tif", "tiff", "bmp", "webp", "heic", "icns", "ico", "psd": return "photo"
        case "sqlite", "sqlite3", "db", "realm": return "cylinder"
        case "txt", "log", "csv", "tsv", "xml", "html", "css", "svg", "": return "doc.text"
        default: return FileKind.binaryExtensions.contains(ext) ? "doc" : "doc.text"
        }
    }
}

// MARK: - Model

/// The opened folder: its tree, which row is selected, and the watcher that keeps the rows in step with the disk.
@MainActor
final class FolderModel: ObservableObject {
    private(set) var tree: FolderTree
    var root: URL { tree.root }
    @Published private(set) var rows: [FolderRow] = []
    /// The selected row's id (the path below the folder).
    @Published var selection: String?
    /// Counts up when the table should scroll to the selected row (a reveal), so a reveal scrolls once.
    @Published private(set) var scrollToken = 0
    /// Called when the expanded folders change, so they are remembered.
    var onChange: (() -> Void)?
    private var watcher: FolderWatcher?
    private var refreshing = false
    private var refreshAgain = false

    init(root: URL, expanded: Set<String>, showHidden: Bool, compact: Bool) {
        tree = FolderTree(root: root, showHidden: showHidden, compact: compact, expanded: expanded)
        rows = tree.rows()
    }

    var isReadable: Bool { tree.isReadable }
    var expanded: [String] { tree.expanded.sorted() }
    var isPolling: Bool { watcher?.isPolling ?? false }

    func start() {
        guard watcher == nil else { return }
        let w = FolderWatcher(root: root) { [weak self] in MainActor.assumeIsolated { self?.refreshFromDisk() } }
        w.start()
        watcher = w
    }

    func stop() { watcher?.stop(); watcher = nil }

    func reload() { let r = tree.rows(); if r != rows { rows = r } }
    func toggle(_ id: String) { tree.toggle(id); reload(); onChange?() }
    func setExpanded(_ id: String, _ on: Bool) { tree.setExpanded(id, on); reload(); onChange?() }
    func collapseAll() { tree.collapseAll(); reload(); onChange?() }
    func setShowHidden(_ on: Bool) { guard tree.showHidden != on else { return }; tree.showHidden = on; reload() }
    func setCompact(_ on: Bool) { guard tree.compact != on else { return }; tree.compact = on; reload() }

    func row(_ id: String?) -> FolderRow? { id.flatMap { id in rows.first { $0.id == id } } }

    /// The file or folder a row stands for (a note stands for its folder).
    func url(for id: String) -> URL {
        tree.url(forRelative: id.hasSuffix("\u{0}note") ? String(id.dropLast("\u{0}note".count)) : id)
    }

    /// Shows the row for `url`: expands the folders above it, selects it and asks the table to scroll to it.
    /// False when `url` is outside the folder or has no row (inside a hidden folder).
    @discardableResult
    func reveal(_ url: URL) -> Bool {
        guard let rel = tree.relativePath(of: url), !rel.isEmpty else { return false }
        let before = tree.expanded
        tree.reveal(relative: rel)
        reload()
        guard rows.contains(where: { $0.id == rel }) else { return false }
        if selection != rel { selection = rel }
        scrollToken += 1
        if tree.expanded != before { onChange?() }
        return true
    }

    /// Reads the folders read so far again, off the main thread, and applies what changed. Several calls in a burst make one more pass.
    func refreshFromDisk() {
        if refreshing { refreshAgain = true; return }
        refreshing = true
        let dirs = tree.loadedDirectories, root = tree.root, hidden = tree.showHidden, cap = tree.entryCap
        Task.detached(priority: .utility) {
            let fresh = FolderTree.relist(dirs, root: root, showHidden: hidden, cap: cap)
            await MainActor.run { [weak self] in
                guard let self = self else { return }
                self.refreshing = false
                if self.tree.apply(fresh) { self.reload(); self.onChange?() }
                if self.refreshAgain { self.refreshAgain = false; self.refreshFromDisk() }
            }
        }
    }
}

/// Go to File: the files below the folder, read in the background, and the match for what is typed.
@MainActor
final class QuickOpenModel: ObservableObject {
    let root: URL
    @Published var query = "" { didSet { if query != oldValue { rerank() } } }
    @Published private(set) var results: [String] = []
    @Published var index = 0
    @Published private(set) var loading = true
    private var all: [String] = []

    init(root: URL) {
        self.root = root
        Task.detached(priority: .userInitiated) {
            let found = QuickOpen.scan(root: root)
            await MainActor.run { [weak self] in
                guard let self = self else { return }
                self.all = found; self.loading = false; self.rerank()
            }
        }
    }

    private func rerank() {
        results = QuickOpen.rank(query: query, in: all, limit: 50)
        index = 0
    }

    func move(_ delta: Int) { guard !results.isEmpty else { return }; index = min(results.count - 1, max(0, index + delta)) }
    var chosen: String? { results.indices.contains(index) ? results[index] : nil }
}

// MARK: - Panel

/// The Explorer column: header, the folder's name, the tree. Or, with no folder, a way to open one.
struct ExplorerPanel: View {
    @ObservedObject var editor: EditorModel
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let folder = editor.folder {
                ExplorerFolderView(editor: editor, folder: folder)
            } else {
                noFolder
            }
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("EXPLORER").font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary)
            Spacer()
            if let folder = editor.folder {
                Button { folder.collapseAll() } label: { Image(systemName: "minus.square") }
                    .buttonStyle(.borderless).help("Collapse all folders")
                Button { folder.refreshFromDisk() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Read the folders again")
                ExplorerMenu(editor: editor, folder: folder)
            }
        }
        .padding(.horizontal, 14).frame(height: 36)
    }

    private var noFolder: some View {
        VStack(spacing: 10) {
            Image(systemName: "folder").font(.system(size: 28)).foregroundStyle(.tertiary)
            Text("No folder open").font(.system(size: 13, weight: .medium))
            Text("Open a folder to browse its files here.").font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Open Folder…") { editor.showOpenFolderPanel(startingIn: app.selectedAgent?.cwd) }
            RecentFoldersList(model: editor, limit: 6).padding(.top, 6)
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

struct ExplorerMenu: View {
    @ObservedObject var editor: EditorModel
    let folder: FolderModel

    var body: some View {
        Menu {
            Toggle("Show Hidden Files", isOn: $editor.showHiddenFiles)
            Toggle("Compact Folders", isOn: $editor.compactFolders)
            Toggle("Follow the Open File", isOn: $editor.followActiveFile)
            Divider()
            Button("Reveal the Open File") { editor.revealActiveFile() }.disabled(editor.current?.url == nil)
            Button("Copy Folder Path") { editor.copyPath(relative: false, of: folder.root) }
            Button("Reveal Folder in Finder") { NSWorkspace.shared.activateFileViewerSelecting([folder.root]) }
            Divider()
            Button("Close Folder") { editor.closeFolder() }
        } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Explorer options")
    }
}

struct ExplorerFolderView: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var folder: FolderModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "folder.fill").font(.system(size: 11)).foregroundStyle(.secondary)
                Text(folder.root.lastPathComponent).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 4)
            .contentShape(Rectangle())
            .help(folder.root.path)
            .contextMenu {
                Button("Copy Folder Path") { editor.copyPath(relative: false, of: folder.root) }
                Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([folder.root]) }
                Divider()
                Button("Close Folder") { editor.closeFolder() }
            }
            ExplorerTable(editor: editor, folder: folder)
        }
    }
}

// MARK: - Table

/// The table: a key view that asks `KeyRule.route` before it takes a key, reports whether it has the keyboard, and turns a click
/// into "open" the way the row says.
final class ExplorerTableView: NSTableView {
    var onFocus: ((Bool) -> Void)?
    var onKey: ((NSEvent) -> Bool)?
    var onClick: ((Int, Int) -> Void)?
    var menuForRow: ((Int) -> NSMenu?)?

    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool { let ok = super.becomeFirstResponder(); if ok { onFocus?(true) }; return ok }
    override func resignFirstResponder() -> Bool { let ok = super.resignFirstResponder(); if ok { onFocus?(false) }; return ok }

    override func keyDown(with event: NSEvent) {
        if onKey?(event) == true { return }
        super.keyDown(with: event)
    }

    override func mouseDown(with event: NSEvent) {
        let r = row(at: convert(event.locationInWindow, from: nil))
        super.mouseDown(with: event)
        if r >= 0 { onClick?(r, event.clickCount) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let r = row(at: convert(event.locationInWindow, from: nil))
        guard r >= 0 else { return nil }
        if selectedRow != r { selectRowIndexes([r], byExtendingSelection: false) }
        return menuForRow?(r)
    }
}

/// Selection drawn the way the sidebar draws it: accent at 20% with a 7 pt radius while the table has the keyboard, grey otherwise.
final class ExplorerRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        let color = isEmphasized ? NSColor.controlAccentColor.withAlphaComponent(0.20) : NSColor.labelColor.withAlphaComponent(0.10)
        color.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 6, dy: 0.5), xRadius: 7, yRadius: 7).fill()
    }
    override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }
}

final class ExplorerCell: NSView {
    static let identifier = NSUserInterfaceItemIdentifier("ExplorerCell")
    private let chevron = NSImageView()
    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let dot = NSView()
    private var depth = 0
    private var showsChevron = false
    private var showsDot = false
    private var isNote = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        identifier = Self.identifier
        for v in [chevron, icon] as [NSImageView] { v.imageScaling = .scaleProportionallyDown; addSubview(v) }
        chevron.contentTintColor = .secondaryLabelColor
        icon.contentTintColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingMiddle
        label.font = .systemFont(ofSize: 12.5)
        label.cell?.truncatesLastVisibleLine = true
        addSubview(label)
        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
        dot.layer?.cornerRadius = 3.5
        addSubview(dot)
    }
    required init?(coder: NSCoder) { fatalError() }

    func configure(_ row: FolderRow, dirty: Bool, tooltip: String) {
        depth = row.depth
        isNote = row.isNote
        showsChevron = row.canExpand
        showsDot = dirty
        label.stringValue = row.label
        label.textColor = row.isNote ? .tertiaryLabelColor : .labelColor
        label.font = row.isNote ? NSFontManager.shared.convert(.systemFont(ofSize: 12), toHaveTrait: .italicFontMask) : .systemFont(ofSize: 12.5)
        icon.isHidden = row.isNote
        let sym = FileGlyph.symbol(name: row.name, isFolder: row.kind == .folder, isLoop: row.isLoop)
        icon.image = NSImage(systemSymbolName: sym, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        chevron.isHidden = !row.canExpand
        let name = row.isExpanded ? "chevron.down" : "chevron.right"
        chevron.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        dot.isHidden = !dirty
        toolTip = tooltip
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height, x0 = 14.0 + CGFloat(depth) * 13
        chevron.frame = NSRect(x: x0 - 12, y: (h - 12) / 2, width: 12, height: 12)
        icon.frame = NSRect(x: x0 + 3, y: (h - 14) / 2, width: 14, height: 14)
        let labelX = isNote ? x0 + 3 : x0 + 23
        let trailing: CGFloat = showsDot ? 24 : 12
        label.frame = NSRect(x: labelX, y: (h - 16) / 2, width: max(10, bounds.width - labelX - trailing), height: 16)
        dot.frame = NSRect(x: bounds.width - 19, y: (h - 7) / 2, width: 7, height: 7)
    }
}

struct ExplorerTable: NSViewRepresentable {
    @ObservedObject var editor: EditorModel
    @ObservedObject var folder: FolderModel

    func makeCoordinator() -> Coordinator { Coordinator(editor: editor, folder: folder) }

    func makeNSView(context: Context) -> NSScrollView {
        let c = context.coordinator
        let table = ExplorerTableView()
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        col.resizingMask = .autoresizingMask
        table.addTableColumn(col)
        table.headerView = nil
        table.rowHeight = 24
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.style = .plain
        table.backgroundColor = .clear
        table.focusRingType = .none
        table.allowsMultipleSelection = false
        table.allowsEmptySelection = true
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = c
        table.delegate = c
        table.onFocus = { [weak c] on in c?.focusChanged(on) }
        table.onKey = { [weak c] e in c?.handleKey(e) ?? false }
        table.onClick = { [weak c] row, count in c?.clicked(row, count: count) }
        table.menuForRow = { [weak c] row in c?.menu(for: row) }
        c.table = table
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        c.update(editor: editor, folder: folder)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) { context.coordinator.update(editor: editor, folder: folder) }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var editor: EditorModel
        var folder: FolderModel
        weak var table: ExplorerTableView?
        private var rows: [FolderRow] = []
        private var dirty: Set<String> = []
        private var suppress = false
        private var lastScroll = 0
        private var lastFocus = 0

        init(editor: EditorModel, folder: FolderModel) { self.editor = editor; self.folder = folder; lastScroll = folder.scrollToken; lastFocus = editor.explorerFocusToken }

        func update(editor: EditorModel, folder: FolderModel) {
            self.editor = editor; self.folder = folder
            guard let table = table else { return }
            let newDirty = editor.dirtyRelativePaths()
            if folder.rows != rows || newDirty != dirty {
                rows = folder.rows; dirty = newDirty
                table.reloadData()
            }
            let want = folder.selection.flatMap { id in rows.firstIndex { $0.id == id } }
            if table.selectedRow != (want ?? -1) {
                suppress = true
                if let w = want { table.selectRowIndexes([w], byExtendingSelection: false) } else { table.deselectAll(nil) }
                suppress = false
            }
            if folder.scrollToken != lastScroll { lastScroll = folder.scrollToken; if let w = want { table.scrollRowToVisible(w) } }
            if editor.explorerFocusToken != lastFocus {
                lastFocus = editor.explorerFocusToken
                DispatchQueue.main.async { [weak self] in self?.takeKeyboard() }
            }
        }

        /// Shift+Cmd+E: the table takes the keyboard, with a row selected (the open file's, else the first).
        private func takeKeyboard() {
            guard let table = table, table.window != nil else { return }
            table.window?.makeFirstResponder(table)
            if table.selectedRow < 0, !rows.isEmpty {
                let i = rows.firstIndex { $0.kind != .note } ?? 0
                folder.selection = rows[i].id
                table.selectRowIndexes([i], byExtendingSelection: false)
            }
            if table.selectedRow >= 0 { table.scrollRowToVisible(table.selectedRow) }
        }

        func focusChanged(_ on: Bool) { if editor.explorerFocused != on { editor.explorerFocused = on } }

        // MARK: Data source and delegate

        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let cell = (tableView.makeView(withIdentifier: ExplorerCell.identifier, owner: nil) as? ExplorerCell) ?? ExplorerCell(frame: .zero)
            let r = rows[row]
            let isDirty = r.kind == .file ? dirty.contains(r.id) : (r.kind == .folder && !r.isExpanded && dirty.contains { $0.hasPrefix(r.id + "/") })
            cell.configure(r, dirty: isDirty, tooltip: tooltip(r))
            return cell
        }

        func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { ExplorerRowView() }
        func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { rows.indices.contains(row) && !rows[row].isNote }
        func tableView(_ tableView: NSTableView, typeSelectStringFor tableColumn: NSTableColumn?, row: Int) -> String? { rows.indices.contains(row) ? rows[row].label : nil }

        func tableViewSelectionDidChange(_ notification: Notification) {
            guard !suppress, let table = table else { return }
            let id = rows.indices.contains(table.selectedRow) ? rows[table.selectedRow].id : nil
            if folder.selection != id { folder.selection = id }
        }

        private func tooltip(_ r: FolderRow) -> String {
            switch r.kind {
            case .note: return ""
            case .folder: return folder.url(for: r.id).path + (r.isLoop ? "\nA link to a parent folder: not opened" : "")
            case .file: return folder.url(for: r.id).path + "\n" + EditorPage.size(r.size)
            }
        }

        // MARK: Clicks and keys

        /// A click: a file opens as a preview tab and the keyboard stays here; a double click keeps the tab and moves to the editor;
        /// a folder opens or closes.
        func clicked(_ row: Int, count: Int) {
            guard rows.indices.contains(row) else { return }
            let r = rows[row]
            switch r.kind {
            case .note: return
            case .folder: if r.canExpand, count == 1 { folder.toggle(r.id) }
            case .file: editor.open(folder.url(for: r.id), preview: count == 1, focus: count == 1 ? .explorer : .editor)
            }
        }

        func handleKey(_ e: NSEvent) -> Bool {
            let flags = e.modifierFlags.intersection([.command, .control, .option, .shift])
            var mods: KeyModifiers = []
            if flags.contains(.command) { mods.insert(.command) }
            if flags.contains(.control) { mods.insert(.control) }
            if flags.contains(.option) { mods.insert(.option) }
            if flags.contains(.shift) { mods.insert(.shift) }
            // A chord with Command is the app's (the menus took it first); anything else belongs to the focused view, which is this one.
            if KeyRoute.app == KeyRule.route(KeyChord(e.charactersIgnoringModifiers ?? "", mods)) { return false }
            guard flags.isEmpty, let table = table else { return false }
            let row = table.selectedRow
            let r = rows.indices.contains(row) ? rows[row] : nil
            switch e.keyCode {
            case 124:   // right: open a folder, then step into it
                guard let r = r, r.canExpand else { return true }
                if !r.isExpanded { folder.setExpanded(r.id, true) } else if rows.indices.contains(row + 1), rows[row + 1].depth > r.depth { select(row + 1) }
                return true
            case 123:   // left: close a folder, else step out to the folder above
                guard let r = r else { return true }
                if r.kind == .folder && r.isExpanded { folder.setExpanded(r.id, false) } else if let p = parentRow(of: row) { select(p) }
                return true
            case 36, 76:   // return: open the file and go to the editor; a folder opens or closes
                guard let r = r else { return true }
                if r.kind == .folder { if r.canExpand { folder.toggle(r.id) } } else if r.kind == .file { editor.open(folder.url(for: r.id), preview: false, focus: .editor) }
                return true
            case 49:   // space: preview the file and stay
                guard let r = r else { return true }
                if r.kind == .folder { if r.canExpand { folder.toggle(r.id) } } else if r.kind == .file { editor.open(folder.url(for: r.id), preview: true, focus: .explorer) }
                return true
            case 53:   // escape: back to the editor
                editor.focusEditor()
                return true
            case 115: if let i = rows.firstIndex(where: { $0.kind != .note }) { select(i) }; return true   // home
            case 119: if let i = rows.lastIndex(where: { $0.kind != .note }) { select(i) }; return true     // end
            default: return false
            }
        }

        private func parentRow(of row: Int) -> Int? {
            guard rows.indices.contains(row), rows[row].depth > 0 else { return nil }
            return (0..<row).reversed().first { rows[$0].depth == rows[row].depth - 1 && rows[$0].kind == .folder }
        }

        private func select(_ row: Int) {
            guard let table = table, rows.indices.contains(row) else { return }
            table.selectRowIndexes([row], byExtendingSelection: false)
            table.scrollRowToVisible(row)
        }

        // MARK: Right-click menu

        func menu(for row: Int) -> NSMenu? {
            guard rows.indices.contains(row), !rows[row].isNote else { return nil }
            let r = rows[row]
            let m = NSMenu()
            func item(_ title: String, _ action: Selector, key: String = "", mods: NSEvent.ModifierFlags = []) {
                let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
                i.keyEquivalentModifierMask = mods
                i.target = self; i.representedObject = r.id
                m.addItem(i)
            }
            if r.kind == .file {
                item("Open", #selector(openRow(_:)))
                item("Open and Keep Tab", #selector(openAndKeep(_:)))
            } else if r.canExpand {
                item(r.isExpanded ? "Collapse" : "Expand", #selector(toggleRow(_:)))
            }
            m.addItem(.separator())
            item("Reveal in Finder", #selector(revealInFinder(_:)))
            m.addItem(.separator())
            item("Copy Path", #selector(copyPath(_:)), key: "c", mods: [.command, .option])
            item("Copy Relative Path", #selector(copyRelativePath(_:)), key: "c", mods: [.command, .option, .shift])
            return m
        }

        private func target(_ sender: Any?) -> (FolderRow, URL)? {
            guard let id = (sender as? NSMenuItem)?.representedObject as? String, let r = folder.row(id) else { return nil }
            return (r, folder.url(for: id))
        }
        @objc private func openRow(_ s: Any?) { if let (r, u) = target(s), r.kind == .file { editor.open(u, preview: true, focus: .editor) } }
        @objc private func openAndKeep(_ s: Any?) { if let (r, u) = target(s), r.kind == .file { editor.open(u, preview: false, focus: .editor) } }
        @objc private func toggleRow(_ s: Any?) { if let (r, _) = target(s) { folder.toggle(r.id) } }
        @objc private func revealInFinder(_ s: Any?) { if let (_, u) = target(s) { NSWorkspace.shared.activateFileViewerSelecting([u]) } }
        @objc private func copyPath(_ s: Any?) { if let (_, u) = target(s) { editor.copyPath(relative: false, of: u) } }
        @objc private func copyRelativePath(_ s: Any?) { if let (_, u) = target(s) { editor.copyPath(relative: true, of: u) } }
    }
}

// MARK: - Go to File

struct QuickOpenView: View {
    @ObservedObject var model: QuickOpenModel
    let editor: EditorModel
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            Color.black.opacity(0.28).ignoresSafeArea().onTapGesture { editor.closeQuickOpen() }
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Go to a file in \(model.root.lastPathComponent)", text: $model.query)
                        .textFieldStyle(.plain).font(.system(size: 17)).focused($focused)
                        .onSubmit { open() }
                }
                .padding(14)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 1) {
                            ForEach(Array(model.results.enumerated()), id: \.element) { i, path in
                                HStack(spacing: 8) {
                                    Image(systemName: FileGlyph.symbol(name: path, isFolder: false)).font(.system(size: 12)).foregroundStyle(.secondary).frame(width: 16)
                                    Text((path as NSString).lastPathComponent).font(.system(size: 13.5, weight: .medium)).lineLimit(1)
                                    Text((path as NSString).deletingLastPathComponent).font(.system(size: 11.5)).foregroundStyle(.secondary)
                                        .lineLimit(1).truncationMode(.head)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(i == model.index ? Color.accentColor.opacity(0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .contentShape(Rectangle())
                                .onTapGesture { model.index = i; open() }
                                .id(path)
                            }
                            if model.results.isEmpty {
                                Text(model.loading ? "Reading the folder…" : "No match").foregroundStyle(.secondary).padding(20)
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 360)
                    .onChange(of: model.index) { _, i in if model.results.indices.contains(i) { proxy.scrollTo(model.results[i]) } }
                }
                Divider()
                HStack(spacing: 14) {
                    Text("↑↓ move").font(.system(size: 11)); Text("↩ open").font(.system(size: 11)); Text("esc close").font(.system(size: 11))
                    Spacer()
                }
                .foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 8)
            }
            .frame(width: 600)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.35), radius: 28, y: 12)
            .frame(maxHeight: .infinity, alignment: .top).padding(.top, 90)
            .onKeyPress(.upArrow) { model.move(-1); return .handled }
            .onKeyPress(.downArrow) { model.move(1); return .handled }
            .onKeyPress(.escape) { editor.closeQuickOpen(); return .handled }
        }
        .onAppear { focused = true }
    }

    private func open() {
        guard let rel = model.chosen else { return }
        let url = model.root.appendingPathComponent(rel)
        editor.closeQuickOpen()
        editor.open(url, focus: .editor)
    }
}
