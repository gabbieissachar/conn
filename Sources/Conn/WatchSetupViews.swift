// The Watch presets' menu items (Layout > Watch, and the Watch bar's bookmark button) and the sheet that names a preset or lists them.
import SwiftUI
import ConnCore

/// Save, load, rename and delete. The same three items sit in the Layout menu and in the Watch bar's menu.
struct WatchPresetMenuItems: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var watch: WatchModel

    var body: some View {
        Button("Save Column Setup as Preset\u{2026}") { app.watchPresetSheet = .save }.disabled(watch.layout.openCount == 0)
        Menu("Load Preset") {
            let presets = watch.setups.presets
            ForEach(presets) { p in Button("\(p.name) (\(p.setup.count) columns)") { app.loadWatchPreset(p.id) } }
            if presets.isEmpty { Button("No Presets Yet") {}.disabled(true) }
        }
        Button("Rename or Delete Presets\u{2026}") { app.watchPresetSheet = .manage }.disabled(watch.setups.presets.isEmpty)
    }
}

struct WatchPresetSheetView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var watch: WatchModel
    let kind: WatchPresetSheet

    var body: some View {
        Group {
            switch kind {
            case .save: SaveForm(watch: watch)
            case .manage: ManageList(watch: watch)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(width: 420)
        .accessibilityElement(children: .contain)
    }

    private struct SaveForm: View {
        @EnvironmentObject var app: AppModel
        @ObservedObject var watch: WatchModel
        @State private var name = ""
        @FocusState private var focused: Bool

        private var clean: String? { WatchSetups.cleanName(name) }
        private var replaces: Bool { clean.map { n in watch.setups.presets.contains { $0.name.caseInsensitiveCompare(n) == .orderedSame } } ?? false }

        var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                Text("Save column setup as preset").font(.system(size: 14, weight: .semibold))
                Text("\(watch.count) columns: " + watch.layout.slots.map { $0.map { app.watchColumnLabel($0.session) } ?? "free" }.joined(separator: ", "))
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3).redacted(reason: app.privacy ? .placeholder : [])
                TextField("Name", text: $name).textFieldStyle(.roundedBorder).focused($focused)
                    .onSubmit { save() }.accessibilityIdentifier("watch-preset-name")
                if replaces { Label("A preset with this name is replaced", systemImage: "arrow.triangle.2.circlepath").font(.system(size: 11)).foregroundStyle(Color.orange) }
                HStack {
                    Text("Keeps which conversation is in which column. No text.").font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { app.watchPresetSheet = nil }.keyboardShortcut(.cancelAction).accessibilityIdentifier("watch-preset-cancel")
                    Button("Save") { save() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                        .disabled(clean == nil).accessibilityIdentifier("watch-preset-save")
                }
            }
            .onAppear { focused = true }
            .accessibilityIdentifier("watch-preset-save-sheet")
        }

        private func save() { if app.saveWatchPreset(name: name) { app.watchPresetSheet = nil } }
    }

    private struct ManageList: View {
        @EnvironmentObject var app: AppModel
        @ObservedObject var watch: WatchModel
        @State private var renaming: String?
        @State private var draft = ""
        @FocusState private var focused: Bool

        var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                Text("Watch presets").font(.system(size: 14, weight: .semibold))
                if watch.setups.presets.isEmpty {
                    Text("No presets yet. Save the columns you have with Save Column Setup as Preset.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(watch.setups.presets) { p in row(p) }
                    }
                }
                .frame(maxHeight: 280)
                HStack {
                    Spacer()
                    Button("Done") { app.watchPresetSheet = nil }.keyboardShortcut(.defaultAction).accessibilityIdentifier("watch-preset-done")
                }
            }
            .accessibilityIdentifier("watch-preset-manage-sheet")
        }

        @ViewBuilder private func row(_ p: WatchPreset) -> some View {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    if renaming == p.id {
                        TextField("Name", text: $draft).textFieldStyle(.roundedBorder).focused($focused)
                            .onSubmit { commit(p) }.accessibilityIdentifier("watch-preset-rename-field")
                    } else {
                        Text(p.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        Text("\(p.setup.count) columns: " + p.setup.columns.map { $0.map { app.watchColumnLabel($0) } ?? "free" }.joined(separator: ", "))
                            .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                            .redacted(reason: app.privacy ? .placeholder : [])
                    }
                }
                Spacer(minLength: 4)
                if renaming == p.id {
                    Button("Save") { commit(p) }.accessibilityIdentifier("watch-preset-rename-commit")
                    Button("Cancel") { renaming = nil }
                } else {
                    Button("Load") { app.loadWatchPreset(p.id); app.watchPresetSheet = nil }.accessibilityIdentifier("watch-preset-load")
                    Button { draft = p.name; renaming = p.id; focused = true } label: { Image(systemName: "pencil") }
                        .buttonStyle(.borderless).help("Rename").accessibilityIdentifier("watch-preset-rename")
                    Button { app.deleteWatchPreset(p.id) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless).help("Delete").accessibilityIdentifier("watch-preset-delete")
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        }

        private func commit(_ p: WatchPreset) { if app.renameWatchPreset(p.id, to: draft) { renaming = nil } }
    }
}
