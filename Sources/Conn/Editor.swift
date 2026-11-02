// The plain text and markdown editor (decision B4): open, edit, save. Not a code editor: no language services, no tabs
// of project state, just files. Documents are ConnCore.TextFile; this file owns the open-document list, the panels and
// the NSTextView.
import SwiftUI
import AppKit
import ConnCore

extension TextFile: Identifiable { public var id: ObjectIdentifier { ObjectIdentifier(self) } }

@MainActor
final class EditorModel: ObservableObject {
    @Published var docs: [TextFile] = []
    @Published var selectedID: ObjectIdentifier?
    @Published var wrapLines = true
    @Published var fontSize: CGFloat = 13
    @Published var alert: String?
    private let defaultsKey = "conn.openFiles"
    private var diskTimer: Timer?

    init() {
        diskTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.docs.forEach { $0.checkDisk() } }
        }
    }

    var current: TextFile? { docs.first { $0.id == selectedID } }
    var dirtyDocs: [TextFile] { docs.filter { $0.isDirty } }

    func restoreSession() {
        guard let paths = UserDefaults.standard.stringArray(forKey: defaultsKey) else { return }
        for p in paths { open(URL(fileURLWithPath: p), quiet: true) }
    }

    private func persist() {
        UserDefaults.standard.set(docs.compactMap { $0.url?.path }, forKey: defaultsKey)
    }

    func newDocument() {
        let d = TextFile()
        docs.append(d)
        selectedID = d.id
    }

    /// `startingIn`: where the panel opens (the selected agent's working directory), if it exists.
    func showOpenPanel(startingIn dir: String? = nil) {
        let panel = NSOpenPanel()
        if let d = dir, !d.isEmpty, FileManager.default.fileExists(atPath: d) { panel.directoryURL = URL(fileURLWithPath: d) }
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.message = "Open a text or markdown file"
        guard panel.runModal() == .OK else { return }
        panel.urls.forEach { open($0) }
    }

    func open(_ url: URL, quiet: Bool = false) {
        if let existing = docs.first(where: { $0.url?.standardizedFileURL == url.standardizedFileURL }) { selectedID = existing.id; return }
        do {
            let d = try TextFile(opening: url)
            docs.append(d)
            selectedID = d.id
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            persist()
        } catch {
            if !quiet { alert = "\(error)" }
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
        persist()
    }

    func saveAs(_ d: TextFile) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = d.title
        panel.message = "Save as a text or markdown file"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try d.saveAs(url); NSDocumentController.shared.noteNewRecentDocumentURL(url) } catch { alert = "\(error)" }
        persist()
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
            docs.remove(at: i)
            if selectedID == d.id { selectedID = docs.indices.contains(i) ? docs[i].id : docs.last?.id }
        }
        persist()
        return true
    }

    /// For the quit prompt: true if it is fine to quit.
    func confirmQuit() -> Bool {
        for d in dirtyDocs { selectedID = d.id; if !close(d) { return false } }
        return true
    }

    func reload(_ d: TextFile) { do { try d.reloadFromDisk() } catch { alert = "\(error)" } }
}

// MARK: - Views

struct EditorTabStrip: View {
    @ObservedObject var model: EditorModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(model.docs) { d in EditorTab(doc: d, selected: d.id == model.selectedID, model: model) }
                Button { model.newDocument() } label: { Image(systemName: "plus") }.buttonStyle(.borderless).help("New document (⌘N)")
                Button { model.showOpenPanel() } label: { Image(systemName: "folder") }.buttonStyle(.borderless).help("Open file (⌘O)")
            }
            .padding(.horizontal, 10)
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
            Image(systemName: doc.isMarkdown ? "text.alignleft" : "doc.text").font(.system(size: 11)).foregroundStyle(.secondary)
            Text(doc.title).font(.system(size: 12, weight: selected ? .semibold : .regular)).lineLimit(1)
            if doc.isDirty { Circle().fill(Color.orange).frame(width: 7, height: 7).help("Unsaved changes") }
            Button { model.close(doc) } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }.buttonStyle(.borderless)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(selected ? Color.primary.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .contentShape(Rectangle())
        .help(doc.url?.path ?? "Not saved yet")
        .onTapGesture { model.selectedID = doc.id }
    }
}

struct EditorArea: View {
    @ObservedObject var model: EditorModel

    var body: some View {
        VStack(spacing: 0) {
            EditorTabStrip(model: model)
            Divider()
            if let d = model.current {
                EditorPage(doc: d, model: model).id(d.id)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "doc.text").font(.system(size: 30)).foregroundStyle(.tertiary)
                    Text("No file open").font(.system(size: 14, weight: .medium))
                    Text("Open a text or markdown file, or start a new one.").font(.system(size: 12)).foregroundStyle(.secondary)
                    HStack {
                        Button("Open…") { model.showOpenPanel() }
                        Button("New") { model.newDocument() }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .alert("Editor", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: { Text(model.alert ?? "") }
    }
}

struct EditorPage: View {
    @ObservedObject var doc: TextFile
    @ObservedObject var model: EditorModel

    var body: some View {
        VStack(spacing: 0) {
            if doc.changedOnDisk {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text("This file changed on disk.").font(.system(size: 12))
                    Spacer()
                    Button("Reload") { model.reload(doc) }
                    Button("Keep Mine") { model.save(doc) }.help("Saves your version over the one on disk, after asking")
                }
                .padding(.horizontal, 12).padding(.vertical, 6).background(Color.orange.opacity(0.12))
            }
            PlainTextEditor(doc: doc, model: model)
            Divider()
            HStack(spacing: 12) {
                Text(doc.url?.deletingLastPathComponent().path ?? "Not saved yet").lineLimit(1).truncationMode(.head)
                Spacer()
                Text("\(doc.text.count) characters")
                Toggle("Wrap", isOn: $model.wrapLines).toggleStyle(.checkbox).controlSize(.small)
                Button(doc.isDirty ? "Save" : "Saved") { model.save(doc) }.disabled(!doc.isDirty && doc.url != nil).controlSize(.small)
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
            .padding(.horizontal, 12).frame(height: 26)
        }
    }
}

/// NSTextView in a scroll view: plain text, no smart substitutions, undo, find bar, optional wrapping.
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
        applyWrap(tv, scroll: scroll)
        DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        // An external change (reload from disk) replaces the text; typing already updated the model, so equal text is skipped.
        if tv.string != doc.text { context.coordinator.suppress = true; tv.string = doc.text; context.coordinator.suppress = false }
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
            guard !suppress, let tv = notification.object as? NSTextView else { return }
            if doc.text != tv.string { doc.text = tv.string }
        }
    }
}
