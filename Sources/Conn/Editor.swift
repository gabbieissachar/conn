// The plain text and markdown editor (decision B4): open, edit, save, and browse a folder. Not a code editor: no language
// services, no project state, just files. Documents are ConnCore.TextFile; this file owns the open-document list, the opened
// folder, the panels and the NSTextView. The Explorer's tree and table are in Explorer.swift.
import SwiftUI
import AppKit
import Combine
import ConnCore

extension TextFile: Identifiable { public var id: ObjectIdentifier { ObjectIdentifier(self) } }

/// Where the keyboard goes after a file is opened.
enum OpenFocus { case editor, explorer }

@MainActor
final class EditorModel: ObservableObject {
    @Published var docs: [TextFile] = []
    @Published var selectedID: ObjectIdentifier? { didSet { if selectedID != oldValue { followActiveTab() } } }
    @Published var wrapLines = true
    @Published var fontSize: CGFloat = 13
    @Published var alert: String?
    /// The opened folder (one per window). Open tabs stay open when it changes.
    @Published private(set) var folder: FolderModel?
    /// Folders opened before, newest first.
    @Published private(set) var recentFolders: [String] = []
    /// Paths of documents with unsaved changes, for the dots in the Explorer.
    @Published private(set) var dirtyPaths: Set<String> = []
    /// True while the Explorer's table has the keyboard (the copy-path keys then act on its selected row).
    @Published var explorerFocused = false
    /// The Go to File panel, while it is up.
    @Published var quickOpen: QuickOpenModel?
    /// Counts up to ask the Explorer's table for the keyboard.
    @Published private(set) var explorerFocusToken = 0
    /// Tree options, remembered across launches.
    @Published var showHiddenFiles: Bool { didSet { folder?.setShowHidden(showHiddenFiles); defaults.set(showHiddenFiles, forKey: Keys.showHidden) } }
    @Published var compactFolders: Bool { didSet { folder?.setCompact(compactFolders); defaults.set(compactFolders, forKey: Keys.compact) } }
    @Published var followActiveFile: Bool { didSet { defaults.set(followActiveFile, forKey: Keys.follow); if followActiveFile { followActiveTab() } } }

    /// Where Copy Path writes. A check points it at a private pasteboard so it never replaces the person's clipboard.
    var pasteboard: NSPasteboard = .general
    /// One line and an optional second line of text shown briefly at the bottom of the window (set by the app model).
    var toast: (String, String?) -> Void = { _, _ in }
    /// Asks the window to show the Explorer (set by the app model, which owns whether it is visible).
    var showExplorer: () -> Void = {}
    weak var activeTextView: NSTextView?

    enum Keys {
        static let openFiles = "conn.openFiles"
        static let folder = "conn.explorer.folder"
        static let expanded = "conn.explorer.expanded"   // [folder path: [expanded paths]]
        static let recent = "conn.explorer.recentFolders"
        static let showHidden = "conn.explorer.showHidden"
        static let compact = "conn.explorer.compact"
        static let follow = "conn.explorer.followActiveFile"
    }

    private let defaults: UserDefaults
    private var diskTimer: Timer?
    private var docSinks: [ObjectIdentifier: AnyCancellable] = [:]
    private var focusEditorOnAppear = true
    /// A request from outside (the `conn` command, a drop, Open With) arrived before the last session was restored: it wins.
    private var outsideFolderRequested = false
    private var outsideOpened = false
    /// The remembered open files are written back only after they were read: a request from outside that arrives first must not
    /// replace the list with its own file before the session is restored.
    private var sessionRestored = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        showHiddenFiles = defaults.object(forKey: Keys.showHidden) as? Bool ?? false
        compactFolders = defaults.object(forKey: Keys.compact) as? Bool ?? true
        followActiveFile = defaults.object(forKey: Keys.follow) as? Bool ?? true
        recentFolders = defaults.stringArray(forKey: Keys.recent) ?? []
        diskTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.docs.forEach { $0.checkDisk() } }
        }
    }

    var current: TextFile? { docs.first { $0.id == selectedID } }
    var dirtyDocs: [TextFile] { docs.filter { $0.isDirty } }

    // MARK: Session

    /// Brings back the last folder and open files. A folder asked for from outside before this ran wins over the remembered one;
    /// the remembered files stay, behind the one that was asked for.
    func restoreSession() {
        if !outsideFolderRequested, let p = defaults.string(forKey: Keys.folder) {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue { _ = openFolder(URL(fileURLWithPath: p), focus: nil, remember: false, quiet: true) }
        }
        for p in defaults.stringArray(forKey: Keys.openFiles) ?? [] { open(URL(fileURLWithPath: p), quiet: true, select: false) }
        sessionRestored = true
        if selectedID == nil { selectedID = docs.last?.id }
        persistFiles()
    }

    private func persistFiles() {
        guard sessionRestored else { return }
        defaults.set(docs.compactMap { $0.url?.path }, forKey: Keys.openFiles)
    }

    private func persistFolder() {
        guard let f = folder else { defaults.removeObject(forKey: Keys.folder); return }
        defaults.set(f.root.path, forKey: Keys.folder)
        var all = defaults.dictionary(forKey: Keys.expanded) as? [String: [String]] ?? [:]
        all[f.root.path] = f.expanded
        if all.count > 30 { for k in all.keys.sorted().prefix(all.count - 30) where k != f.root.path { all[k] = nil } }
        defaults.set(all, forKey: Keys.expanded)
    }

    // MARK: Folder

    /// Opens `url` as the Explorer's folder. `focus`: where the keyboard goes (nil leaves it). False, with an alert, when it cannot be read.
    @discardableResult
    func openFolder(_ url: URL, focus: OpenFocus? = .explorer, remember: Bool = true, quiet: Bool = false) -> Bool {
        let saved = (defaults.dictionary(forKey: Keys.expanded) as? [String: [String]])?[url.resolvingSymlinksInPath().path] ?? []
        let model = FolderModel(root: url, expanded: Set(saved), showHidden: showHiddenFiles, compact: compactFolders)
        guard model.isReadable else {
            if !quiet { alert = "Conn cannot read the folder “\(url.lastPathComponent)”. If macOS asked for access to it, allow it in System Settings, Privacy & Security, Files and Folders." }
            return false
        }
        folder?.stop()
        model.onChange = { [weak self] in self?.persistFolder() }
        model.start()
        folder = model
        if remember {
            recentFolders = RecentFolders.adding(model.root.path, to: recentFolders)
            defaults.set(recentFolders, forKey: Keys.recent)
        }
        persistFolder()
        showExplorer()
        followActiveTab()
        if focus == .explorer { focusExplorer() }
        return true
    }

    func closeFolder() {
        folder?.stop()
        folder = nil
        explorerFocused = false
        persistFolder()
    }

    /// Open Folder… (Shift+Cmd+O): a panel that picks folders only.
    func showOpenFolderPanel(startingIn dir: String? = nil) {
        let panel = NSOpenPanel()
        startDirectory(panel, dir)
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder to browse in the Editor"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        openFromOutside([url])
    }

    private func startDirectory(_ panel: NSOpenPanel, _ dir: String?) {
        if let d = dir, !d.isEmpty, FileManager.default.fileExists(atPath: d) { panel.directoryURL = URL(fileURLWithPath: d) }
    }

    /// The one way anything outside the editor asks it to open paths: the `conn` command, Finder's Open With and a drop on the Dock
    /// icon, a drop on the window, Open… and Open Recent. The first folder becomes the Explorer's folder, files open as tabs
    /// (kept, not previews: the person named them), and nothing unsaved is ever touched.
    @discardableResult
    func openFromOutside(_ urls: [URL]) -> OpenRequest {
        let req = OpenRequest(urls: urls)
        if let f = req.folder { outsideFolderRequested = true; _ = openFolder(f, focus: .explorer) }
        for file in req.files { outsideOpened = true; open(file, focus: req.folder == nil ? .editor : .explorer) }
        if !req.skipped.isEmpty {
            let names = req.skipped.prefix(3).map { "“\($0.lastPathComponent)”" }.joined(separator: ", ")
            alert = "Conn could not open \(names)\(req.skipped.count > 3 ? " and \(req.skipped.count - 3) more" : ""): not found, or not a file or folder it can show."
        }
        if req.ignoredFolders > 0, let f = req.folder {
            toast("Opened \(f.lastPathComponent)", "Ignored \(req.ignoredFolders) more folder\(req.ignoredFolders == 1 ? "" : "s"): a window shows one folder")
        }
        return req
    }

    // MARK: Documents

    func newDocument() {
        let d = TextFile()
        track(d)
        docs.append(d)
        selectedID = d.id
    }

    /// Open… (Cmd+O): files and folders in one panel. `startingIn`: where the panel opens (the selected agent's working directory).
    func showOpenPanel(startingIn dir: String? = nil) {
        let panel = NSOpenPanel()
        startDirectory(panel, dir)
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.message = "Open files, or a folder to browse"
        guard panel.runModal() == .OK else { return }
        openFromOutside(panel.urls)
    }

    /// `preview`: a preview tab, replaced by the next preview and pinned by the first edit. `focus`: where the keyboard goes.
    /// `select: false` is for restoring a session.
    @discardableResult
    func open(_ url: URL, quiet: Bool = false, preview: Bool = false, focus: OpenFocus = .editor, select: Bool = true) -> TextFile? {
        if let existing = docs.first(where: { $0.url?.standardizedFileURL == url.standardizedFileURL }) {
            if !preview { existing.isPreview = false }
            guard select else { return existing }
            let already = selectedID == existing.id
            focusEditorOnAppear = focus == .editor
            selectedID = existing.id
            if already { followActiveTab(); if focus == .editor { DispatchQueue.main.async { [weak self] in self?.focusEditor() } } }
            return existing
        }
        do {
            let d = try TextFile.open(url)
            d.isPreview = preview
            track(d)
            if preview, case .replace(let i) = PreviewSlot.place(previewFlags: docs.map(\.isPreview)) {
                docSinks[docs[i].id] = nil
                docs[i] = d
            } else {
                docs.append(d)
            }
            if select { focusEditorOnAppear = focus == .editor; selectedID = d.id }
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            persistFiles()
            refreshDirty()
            return d
        } catch {
            if !quiet { alert = "\(error)" }
            return nil
        }
    }

    func save(_ d: TextFile) {
        if d.url == nil { saveAs(d); return }
        do { try d.save() } catch TextFileError.changedOnDisk {
            let a = NSAlert()
            a.messageText = "\(d.title) changed on disk"
            a.informativeText = "Another program saved a newer version after you opened it. Overwriting loses those changes."
            a.addButton(withTitle: "Cancel"); a.addButton(withTitle: "Overwrite"); a.addButton(withTitle: "Reload from Disk")
            switch a.runModal() {
            case .alertSecondButtonReturn: do { try d.save(overwrite: true) } catch { alert = "\(error)" }
            case .alertThirdButtonReturn: do { try d.reloadFromDisk() } catch { alert = "\(error)" }
            default: break
            }
        } catch { alert = "\(error)" }
        persistFiles()
    }

    func saveAs(_ d: TextFile) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = d.title
        panel.message = "Save as a text or markdown file"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try d.saveAs(url); NSDocumentController.shared.noteNewRecentDocumentURL(url) } catch { alert = "\(error)" }
        persistFiles()
    }

    /// Returns false if the user cancelled.
    @discardableResult
    func close(_ d: TextFile) -> Bool {
        if d.isDirty {
            let a = NSAlert()
            a.messageText = "Save changes to \(d.title)?"
            a.informativeText = "Your changes are lost if you don't save them."
            a.addButton(withTitle: "Save"); a.addButton(withTitle: "Cancel"); a.addButton(withTitle: "Don't Save")
            switch a.runModal() {
            case .alertFirstButtonReturn:
                save(d)
                if d.isDirty { return false }
            case .alertSecondButtonReturn: return false
            default: break
            }
        }
        if let i = docs.firstIndex(where: { $0.id == d.id }) {
            docSinks[d.id] = nil
            docs.remove(at: i)
            if selectedID == d.id { focusEditorOnAppear = true; selectedID = docs.indices.contains(i) ? docs[i].id : docs.last?.id }
        }
        persistFiles()
        refreshDirty()
        return true
    }

    /// For the quit prompt: true if it is fine to quit.
    func confirmQuit() -> Bool {
        for d in dirtyDocs { selectedID = d.id; if !close(d) { return false } }
        return true
    }

    func reload(_ d: TextFile) { do { try d.reloadFromDisk() } catch { alert = "\(error)" } }

    /// Shift+Cmd+] and Shift+Cmd+[.
    func cycleTab(_ delta: Int) {
        guard docs.count > 1, let i = docs.firstIndex(where: { $0.id == selectedID }) else { return }
        focusEditorOnAppear = true
        selectedID = docs[(i + delta + docs.count) % docs.count].id
    }

    /// Keep a preview tab: the same as a double click on it.
    func keepOpen(_ d: TextFile) { d.isPreview = false }

    // MARK: Unsaved marks

    /// Watches a document so its unsaved mark reaches the Explorer's rows.
    private func track(_ d: TextFile) {
        docSinks[d.id] = d.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.refreshDirty() } }
    }

    private func refreshDirty() {
        let now = Set(docs.filter { $0.isDirty }.compactMap { $0.url?.path })
        if now != dirtyPaths { dirtyPaths = now }
    }

    /// Unsaved files as paths below the opened folder.
    func dirtyRelativePaths() -> Set<String> {
        guard let f = folder else { return [] }
        return Set(docs.filter { $0.isDirty }.compactMap { $0.url }.compactMap { f.tree.relativePath(of: $0) }.filter { !$0.isEmpty })
    }

    // MARK: Focus

    /// A text view that has just appeared takes the keyboard unless the file was opened from the Explorer and stays there.
    func consumeFocusOnAppear() -> Bool { defer { focusEditorOnAppear = true }; return focusEditorOnAppear }

    func focusEditor() {
        guard let tv = activeTextView, let w = tv.window else { return }
        w.makeFirstResponder(tv)
    }

    func focusExplorer() {
        showExplorer()
        explorerFocusToken += 1
    }

    /// Shift+Cmd+E: the Explorer takes the keyboard, or gives it back to the editor.
    func toggleExplorerFocus() {
        if explorerFocused { focusEditor() } else { focusExplorer() }
    }

    // MARK: Following the active tab

    private func followActiveTab() {
        guard followActiveFile, let f = folder, let url = current?.url else { return }
        if !f.reveal(url) { f.selection = nil }
    }

    func revealActiveFile() {
        guard let f = folder, let url = current?.url else { return }
        showExplorer()
        if !f.reveal(url) { toast("That file is not in the opened folder", nil) }
    }

    func revealInExplorer(_ d: TextFile) {
        guard let f = folder, let url = d.url else { return }
        showExplorer()
        if !f.reveal(url) { toast("That file is not in the opened folder", nil) }
    }

    // MARK: Copy path

    /// What Copy Path acts on: the Explorer's selected row while it has the keyboard, otherwise the open file.
    var copyTarget: URL? {
        if explorerFocused, let f = folder, let id = f.selection { return f.url(for: id) }
        return current?.url
    }

    func copyPath(relative: Bool, of url: URL? = nil) {
        let result = PathCopy.copy(url ?? copyTarget, relative: relative, folder: folder?.root)
        guard let text = result.text else { toast(result.title, nil); return }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        toast(result.title, text)
    }

    func copyPath(of d: TextFile, relative: Bool) { copyPath(relative: relative, of: d.url) }

    // MARK: Go to File

    func showQuickOpen() {
        guard let f = folder else { toast("Open a folder first", "Go to File searches the opened folder"); return }
        quickOpen = QuickOpenModel(root: f.root)
    }

    func closeQuickOpen() { quickOpen = nil }
}

// MARK: - Views

struct EditorTabStrip: View {
    @ObservedObject var model: EditorModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.docs) { d in EditorTab(doc: d, selected: d.id == model.selectedID, model: model).id(d.id) }
                    Button { model.newDocument() } label: { Image(systemName: "plus") }.buttonStyle(.borderless).help("New document (⌘N)")
                    Button { model.showOpenPanel() } label: { Image(systemName: "folder") }.buttonStyle(.borderless).help("Open a file or folder (⌘O)")
                }
                .padding(.horizontal, 10)
            }
            // With many tabs (the Explorer makes that easy) the active one is brought into view.
            .onChange(of: model.selectedID) { _, id in
                // After the new tab has been laid out, so a tab that was just added is not left half out of view.
                if let id = id { DispatchQueue.main.async { withAnimation { proxy.scrollTo(id, anchor: .center) } } }
            }
        }
        .frame(height: 36)
    }
}

struct EditorTab: View {
    @ObservedObject var doc: TextFile
    let selected: Bool
    let model: EditorModel

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: FileGlyph.symbol(name: doc.title, isFolder: false)).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(doc.title).font(.system(size: 12, weight: selected ? .semibold : .regular))
                .italic(doc.isPreview).strikethrough(doc.deletedOnDisk)
                .lineLimit(1).truncationMode(.middle)
            if doc.isDirty { Circle().fill(Color.orange).frame(width: 7, height: 7).help("Unsaved changes") }
            Button { model.close(doc) } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }.buttonStyle(.borderless)
        }
        .frame(maxWidth: 220)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(selected ? Color.primary.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .contentShape(Rectangle())
        .help(doc.url?.path ?? "Not saved yet")
        .onTapGesture { model.selectedID = doc.id }
        .simultaneousGesture(TapGesture(count: 2).onEnded { model.keepOpen(doc) })
        .contextMenu { TabMenu(doc: doc, model: model, selected: selected) }
    }
}

/// The right-click menu of a tab (and the one on the editor's footer path, minus the first items).
struct TabMenu: View {
    @ObservedObject var doc: TextFile
    let model: EditorModel
    let selected: Bool

    var body: some View {
        Button("Close") { model.close(doc) }
        if doc.isPreview { Button("Keep Open") { model.keepOpen(doc) } }
        Divider()
        // The keys act on the open file, so only its own tab shows them.
        Button("Copy Path") { model.copyPath(of: doc, relative: false) }
            .keyboardShortcut(selected ? KeyEquivalent("c") : nil, modifiers: [.command, .option]).disabled(doc.url == nil)
        Button("Copy Relative Path") { model.copyPath(of: doc, relative: true) }
            .keyboardShortcut(selected ? KeyEquivalent("c") : nil, modifiers: [.command, .option, .shift]).disabled(doc.url == nil)
        Divider()
        Button("Reveal in Explorer") { model.revealInExplorer(doc) }
            .disabled(doc.url.flatMap { model.folder?.tree.relativePath(of: $0) } == nil)
        Button("Reveal in Finder") { if let u = doc.url { NSWorkspace.shared.activateFileViewerSelecting([u]) } }.disabled(doc.url == nil)
    }
}

extension View {
    /// `keyboardShortcut` that can be absent.
    @ViewBuilder func keyboardShortcut(_ key: KeyEquivalent?, modifiers: EventModifiers) -> some View {
        if let k = key { self.keyboardShortcut(k, modifiers: modifiers) } else { self }
    }
}

struct EditorArea: View {
    @ObservedObject var model: EditorModel
    @EnvironmentObject var app: AppModel

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                if app.explorerVisible {
                    // The editor column is never squeezed below 300 pt by the Explorer, whatever width was dragged to.
                    let width = min(ExplorerLayout.clamped(app.explorerWidth), max(ExplorerLayout.minWidth, geo.size.width - 300))
                    ExplorerPanel(editor: model).frame(width: width)
                    ColumnHandle(width: Binding(get: { CGFloat(app.explorerWidth) }, set: { app.explorerWidth = Double($0) }),
                                 min: CGFloat(ExplorerLayout.minWidth), max: CGFloat(ExplorerLayout.maxWidth), growsWithDragRight: true)
                }
                editorColumn
            }
        }
        .alert("Editor", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: { Text(model.alert ?? "") }
    }

    private var editorColumn: some View {
        VStack(spacing: 0) {
            EditorTabStrip(model: model)
            Divider()
            if let d = model.current {
                EditorPage(doc: d, model: model).id(d.id)
            } else {
                EmptyEditor(model: model)
            }
        }
        .frame(minWidth: 280)
    }
}

struct EmptyEditor: View {
    @ObservedObject var model: EditorModel
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.text").font(.system(size: 30)).foregroundStyle(.tertiary)
            Text("No file open").font(.system(size: 14, weight: .medium))
            Text(model.folder == nil ? "Open a folder to browse it, a file, or start a new one." : "Choose a file in the Explorer, or start a new one.")
                .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack {
                if model.folder == nil { Button("Open Folder…") { model.showOpenFolderPanel(startingIn: app.selectedAgent?.cwd) } }
                Button("Open…") { model.showOpenPanel(startingIn: app.selectedAgent?.cwd) }
                Button("New") { model.newDocument() }
            }
            if model.folder == nil {
                RecentFoldersList(model: model, limit: 5).padding(.top, 8)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct RecentFoldersList: View {
    @ObservedObject var model: EditorModel
    let limit: Int

    var body: some View {
        let recents = RecentFolders.existing(model.recentFolders).prefix(limit)
        if !recents.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text("RECENT FOLDERS").font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary).padding(.bottom, 2)
                ForEach(Array(recents), id: \.self) { path in
                    Button { model.openFromOutside([URL(fileURLWithPath: path)]) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "folder").font(.system(size: 11)).foregroundStyle(.secondary)
                            Text((path as NSString).lastPathComponent).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                            Text((path as NSString).abbreviatingWithTildeInPath).font(.system(size: 11)).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.head)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help(path)
                }
            }
            .frame(maxWidth: 360, alignment: .leading)
        }
    }
}

struct EditorPage: View {
    @ObservedObject var doc: TextFile
    @ObservedObject var model: EditorModel

    var body: some View {
        VStack(spacing: 0) {
            if doc.deletedOnDisk {
                banner("This file was deleted from disk. The text is still here.") {
                    Button("Close") { model.close(doc) }
                    Button("Save to Restore") { model.save(doc) }.help("Writes the file back where it was")
                }
            } else if doc.changedOnDisk {
                banner("This file changed on disk.") {
                    Button("Reload") { model.reload(doc) }
                    Button("Keep Mine") { model.save(doc) }.help("Saves your version over the one on disk, after asking")
                }
            }
            if doc.kind == .large {
                banner("Large file: showing the first \(Self.size(TextFile.headLimit)) of \(Self.size(doc.totalBytes)), read-only.", color: .secondary) { fileButtons }
            }
            if doc.kind == .binary {
                BinaryPlaceholder(doc: doc)
            } else {
                PlainTextEditor(doc: doc, model: model)
            }
            Divider()
            HStack(spacing: 12) {
                pathButton
                Spacer()
                if doc.kind == .text {
                    Text("\(doc.text.count) characters")
                    Toggle("Wrap", isOn: $model.wrapLines).toggleStyle(.checkbox).controlSize(.small)
                    Button(doc.isDirty ? "Save" : "Saved") { model.save(doc) }.disabled(!doc.isDirty && doc.url != nil).controlSize(.small)
                } else {
                    Text("Read-only")
                }
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
            .padding(.horizontal, 12).frame(height: 26)
        }
    }

    /// The footer path: the full path with the file name, cut from the left so the name stays. A click copies it; a right click offers both copies.
    private var pathButton: some View {
        Button { model.copyPath(of: doc, relative: false) } label: {
            Text(doc.url?.path ?? "Not saved yet").lineLimit(1).truncationMode(.head)
        }
        .buttonStyle(.plain)
        .disabled(doc.url == nil)
        .help(doc.url == nil ? "Not saved yet" : "Click to copy the path")
        .contextMenu {
            Button("Copy Path") { model.copyPath(of: doc, relative: false) }.disabled(doc.url == nil)
            Button("Copy Relative Path") { model.copyPath(of: doc, relative: true) }.disabled(doc.url == nil)
            Button("Reveal in Finder") { if let u = doc.url { NSWorkspace.shared.activateFileViewerSelecting([u]) } }.disabled(doc.url == nil)
        }
    }

    @ViewBuilder private var fileButtons: some View {
        Button("Reveal in Finder") { if let u = doc.url { NSWorkspace.shared.activateFileViewerSelecting([u]) } }
        Button("Open in Default App") { if let u = doc.url { NSWorkspace.shared.open(u) } }
    }

    private func banner<Buttons: View>(_ text: String, color: Color = .orange, @ViewBuilder buttons: () -> Buttons) -> some View {
        HStack(spacing: 8) {
            Image(systemName: color == .orange ? "exclamationmark.triangle.fill" : "info.circle.fill").foregroundStyle(color)
            Text(text).font(.system(size: 12)).lineLimit(2)
            Spacer()
            buttons()
        }
        .padding(.horizontal, 12).padding(.vertical, 6).background(color.opacity(0.12))
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

/// What a click on a file that is not text opens: its name, its kind and size, and the two things a person can do with it.
struct BinaryPlaceholder: View {
    @ObservedObject var doc: TextFile

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: FileGlyph.symbol(name: doc.title, isFolder: false)).font(.system(size: 34)).foregroundStyle(.tertiary)
            Text(doc.title).font(.system(size: 14, weight: .medium)).lineLimit(2).truncationMode(.middle).multilineTextAlignment(.center)
            Text("\(doc.url.map { $0.pathExtension.isEmpty ? "File" : "\($0.pathExtension.uppercased()) file" } ?? "File") · \(EditorPage.size(doc.totalBytes))")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            Text("Conn's editor shows text. This file is not text it can show.").font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                Button("Open in Default App") { if let u = doc.url { NSWorkspace.shared.open(u) } }
                Button("Reveal in Finder") { if let u = doc.url { NSWorkspace.shared.activateFileViewerSelecting([u]) } }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// NSTextView in a scroll view: plain text, no smart substitutions, undo, find bar, optional wrapping. Read-only for a large file.
struct PlainTextEditor: NSViewRepresentable {
    @ObservedObject var doc: TextFile
    @ObservedObject var model: EditorModel

    func makeCoordinator() -> Coordinator { Coordinator(doc: doc) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasVerticalScroller = true
        let tv = scroll.documentView as! NSTextView
        tv.isRichText = false
        tv.allowsUndo = true
        tv.isEditable = !doc.isReadOnly
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isAutomaticLinkDetectionEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.usesFindBar = true
        tv.isIncrementalSearchingEnabled = true
        tv.textContainerInset = NSSize(width: 12, height: 10)
        tv.font = NSFont.monospacedSystemFont(ofSize: model.fontSize, weight: .regular)
        tv.delegate = context.coordinator
        tv.string = doc.text
        context.coordinator.textView = tv
        model.activeTextView = tv
        applyWrap(tv, scroll: scroll)
        if model.consumeFocusOnAppear() { DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) } }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        // An external change (reload from disk) replaces the text; typing already updated the model, so equal text is skipped.
        if tv.string != doc.text { context.coordinator.suppress = true; tv.string = doc.text; context.coordinator.suppress = false }
        tv.isEditable = !doc.isReadOnly
        tv.font = NSFont.monospacedSystemFont(ofSize: model.fontSize, weight: .regular)
        applyWrap(tv, scroll: scroll)
    }

    private func applyWrap(_ tv: NSTextView, scroll: NSScrollView) {
        if model.wrapLines {
            tv.isHorizontallyResizable = false
            tv.textContainer?.widthTracksTextView = true
            tv.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
            scroll.hasHorizontalScroller = false
        } else {
            tv.isHorizontallyResizable = true
            tv.textContainer?.widthTracksTextView = false
            tv.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            scroll.hasHorizontalScroller = true
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        let doc: TextFile
        weak var textView: NSTextView?
        var suppress = false
        init(doc: TextFile) { self.doc = doc }
        func textDidChange(_ notification: Notification) {
            guard !suppress, !doc.isReadOnly, let tv = notification.object as? NSTextView else { return }
            if doc.text != tv.string { doc.text = tv.string }
        }
    }
}
