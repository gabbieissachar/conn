// What `conn .`, a drop on the window, File > Open and "Open With" ask Conn to open: some paths, sorted into the one folder the
// window can show and the files that become tabs. Pure (it only looks at the disk), so tests cover every shape of request.
import Foundation

public struct OpenRequest: Equatable, Sendable {
    /// The first folder in the request, symlinks resolved. A window shows one folder, so later folders are only counted.
    public var folder: URL?
    /// Files in the order given, each once.
    public var files: [URL] = []
    /// Folders after the first, which this window does not open.
    public var ignoredFolders = 0
    /// Paths that are gone, and packages (an app or a bundle is not a folder to browse).
    public var skipped: [URL] = []

    public var isEmpty: Bool { folder == nil && files.isEmpty }

    public init(urls: [URL], fileManager fm: FileManager = .default) {
        var seen = Set<String>()
        for raw in urls where raw.isFileURL {
            let url = raw.standardizedFileURL
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else { skipped.append(url); continue }
            if isDir.boolValue {
                if (try? url.resourceValues(forKeys: [.isPackageKey]))?.isPackage == true { skipped.append(url); continue }
                let real = url.resolvingSymlinksInPath()
                if !seen.insert(real.path).inserted { continue }
                if folder == nil { folder = real } else { ignoredFolders += 1 }
            } else {
                if !seen.insert(url.path).inserted { continue }
                files.append(url)
            }
        }
    }
}
