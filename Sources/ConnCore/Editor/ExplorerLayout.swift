// Small pure rules of the Editor view's Explorer: how wide it can be, when the Reader column steps aside for it, where a preview
// tab goes, and the list of recent folders.
import Foundation

public enum ExplorerLayout {
    public static let defaultWidth = 250.0
    public static let minWidth = 160.0
    public static let maxWidth = 480.0
    /// The editor column is never allowed to shrink below this because of the Explorer: the Reader column steps aside first.
    public static let minEditorWidth = 520.0
    /// The sidebar (250) and its divider.
    public static let sidebarSpan = 251.0

    public static func clamped(_ width: Double) -> Double { min(maxWidth, max(minWidth, width)) }

    /// Whether the Reader column should give way: the Editor view shows the Explorer and, with the Reader beside them, the editor
    /// would be under `minEditorWidth` points. `readerWidth` is the Reader column's own width.
    public static func readerStepsAside(windowWidth: Double, sidebarVisible: Bool, explorerVisible: Bool, explorerWidth: Double, readerWidth: Double) -> Bool {
        guard explorerVisible else { return false }
        let editor = windowWidth - (sidebarVisible ? sidebarSpan : 0) - (clamped(explorerWidth) + 1) - (readerWidth + 1)
        return editor < minEditorWidth
    }
}

/// Where a file opened as a preview goes in the tab strip: in place of the one preview tab, or at the end.
public enum PreviewSlot {
    public enum Placement: Equatable, Sendable { case replace(Int), append }
    public static func place(previewFlags: [Bool]) -> Placement {
        previewFlags.firstIndex(of: true).map { .replace($0) } ?? .append
    }
}

public enum RecentFolders {
    public static let limit = 10
    /// `path` first, any earlier copy of it removed, at most `limit` entries.
    public static func adding(_ path: String, to list: [String]) -> [String] {
        Array(([path] + list.filter { $0 != path }).prefix(limit))
    }
    /// Paths that still exist, in order.
    public static func existing(_ list: [String], fileManager fm: FileManager = .default) -> [String] {
        list.filter { var d: ObjCBool = false; return fm.fileExists(atPath: $0, isDirectory: &d) && d.boolValue }
    }
}
