// The `conn` shell command: a link in ~/.local/bin to the script inside Conn.app (File > Install 'conn' Command in PATH).
// The decisions are pure and tested; the menu item only shows them. Nothing here ever overwrites a file that is not a link to a Conn script.
import Foundation

public enum CommandInstall {
    /// Where the script sits inside the app bundle, below Contents/Resources.
    public static let scriptSuffix = "/Contents/Resources/bin/conn"
    public static let commandName = "conn"

    public enum State: Equatable, Sendable {
        /// Nothing at the link path.
        case notInstalled
        /// A link to this app's script.
        case installed
        /// A link to a Conn script that is somewhere else, or gone (the app moved or was deleted): safe to replace.
        case stale(pointsTo: String)
        /// Something else is there. It is never touched.
        case occupied(String)
    }

    public static func state(link: URL, script: URL, fileManager fm: FileManager = .default) -> State {
        if let dest = try? fm.destinationOfSymbolicLink(atPath: link.path) {
            let resolved = dest.hasPrefix("/") ? dest : link.deletingLastPathComponent().appendingPathComponent(dest).path
            if URL(fileURLWithPath: resolved).standardizedFileURL.path == script.standardizedFileURL.path { return .installed }
            if resolved.hasSuffix(scriptSuffix) { return .stale(pointsTo: resolved) }
            return .occupied("a link to \(resolved)")
        }
        if fm.fileExists(atPath: link.path) {
            var isDir: ObjCBool = false
            _ = fm.fileExists(atPath: link.path, isDirectory: &isDir)
            return .occupied(isDir.boolValue ? "a folder" : "a file")
        }
        return .notInstalled
    }

    /// Makes the link, creating the folder if needed. Throws rather than replace anything that is not a stale link of ours.
    public static func install(link: URL, script: URL, fileManager fm: FileManager = .default) throws {
        switch state(link: link, script: script, fileManager: fm) {
        case .installed: return
        case .occupied(let what): throw InstallError.occupied(link.path, what)
        case .stale: try fm.removeItem(at: link)
        case .notInstalled: break
        }
        try fm.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: link, withDestinationURL: script)
    }

    /// Removes the link when it is ours (current or stale). Anything else is left alone.
    @discardableResult
    public static func uninstall(link: URL, script: URL, fileManager fm: FileManager = .default) throws -> Bool {
        switch state(link: link, script: script, fileManager: fm) {
        case .installed, .stale: try fm.removeItem(at: link); return true
        case .notInstalled: return false
        case .occupied(let what): throw InstallError.occupied(link.path, what)
        }
    }

    public enum InstallError: Error, CustomStringConvertible, Equatable {
        case occupied(String, String)
        public var description: String {
            switch self { case .occupied(let p, let w): return "\(p) is already \(w), so Conn left it alone." }
        }
    }

    /// Whether `~/.local/bin` is probably on the shell's PATH: in this process's PATH, or named in a shell start-up file.
    /// Conn is started by Finder, so its own PATH is short; the files are the best evidence without starting a shell.
    public static func likelyOnPath(directory: URL, environmentPath: String?, home: URL, fileManager fm: FileManager = .default) -> Bool {
        if let p = environmentPath, p.split(separator: ":").contains(where: { URL(fileURLWithPath: String($0)).standardizedFileURL.path == directory.standardizedFileURL.path }) { return true }
        let rel = directory.path.hasPrefix(home.path + "/") ? String(directory.path.dropFirst(home.path.count + 1)) : directory.path
        for f in [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"] {
            if let text = try? String(contentsOf: home.appendingPathComponent(f), encoding: .utf8), text.contains(rel) { return true }
        }
        return false
    }
}
