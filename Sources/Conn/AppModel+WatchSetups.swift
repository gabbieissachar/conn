// Watch column setups (README "Watch view"): presets saved by name, loaded by name, and the notices around them. What a setup is and
// the rules for it are `WatchSetups` (ConnCore); what is kept is `WatchModel.setups`.
import SwiftUI
import ConnCore

enum WatchPresetSheet: String, Identifiable {
    case save, manage
    var id: String { rawValue }
}

extension AppModel {
    /// Tell the column model which remembered sessions no longer exist: an id the lite page could not open, and a Campus conversation
    /// the feed no longer lists (only while Campus is live and has answered, so a signed-out Campus never empties a setup).
    func wireWatchSetups() {
        watch.isGone = { [weak self] session in
            guard let self = self else { return false }
            return WatchSetup.isGone(session, campusKnown: self.campus.link == .live && self.campus.asOf != nil, campusHas: { self.campus.conversation($0) != nil })
        }
    }

    /// What a column holds, in words: the agent's name, the starred or recorded name, or the Campus conversation's title.
    func watchColumnLabel(_ session: String) -> String {
        if let id = CampusColumn.id(of: session) { return campus.conversation(id)?.title ?? "Campus conversation" }
        if let a = agent(forSession: session) { return a.name }
        return stars.label(for: session, agentNames: agentNamesBySession)
    }

    func toastWatchGone(_ gone: [String]) {
        let n = gone.count
        toast(n == 1 ? "A remembered conversation is gone, so its column is free" : "\(n) remembered conversations are gone, so their columns are free")
    }

    /// Save what the columns hold under a name. True when it was kept (the sheet closes); a refusal is said in a notice.
    @discardableResult
    func saveWatchPreset(name: String) -> Bool {
        switch watch.savePreset(name: name) {
        case .saved(let p): toast("Saved the preset \(privacy ? "" : p.name)".trimmingCharacters(in: .whitespaces)); objectWillChange.send(); return true
        case .replaced(let p): toast("Replaced the preset \(privacy ? "" : p.name)".trimmingCharacters(in: .whitespaces)); objectWillChange.send(); return true
        case .refused(let why): toast(why.message); return false
        }
    }

    /// Load a preset: Watch turns on (if it was off) with the preset's count and every column in its place. A session that no longer
    /// exists leaves its column to the normal fill rule.
    func loadWatchPreset(_ id: String) {
        guard let p = watch.setups.preset(id: id) else { toast(WatchSetups.Refusal.unknownPreset.message); return }
        let gone = watch.apply(p.setup)
        if !watchOn { watchOn = true } else if !gone.isEmpty { watch.fill(with: watchCandidates()) }
        if gone.isEmpty { toast("Loaded the preset \(privacy ? "" : p.name)".trimmingCharacters(in: .whitespaces)) } else { toastWatchGone(gone) }
        objectWillChange.send()
    }

    @discardableResult
    func renameWatchPreset(_ id: String, to name: String) -> Bool {
        if let why = watch.renamePreset(id: id, to: name) { toast(why.message); return false }
        objectWillChange.send()
        return true
    }

    func deleteWatchPreset(_ id: String) {
        if watch.deletePreset(id: id) { objectWillChange.send() }
    }
}
