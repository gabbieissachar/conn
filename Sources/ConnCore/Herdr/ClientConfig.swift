// The config file the embedded Herdr client starts with.
//
// The Herdr client mode runs `herdr session attach` in a pty. Herdr reads that client's presentation settings from the file
// `HERDR_CONFIG_PATH` names, so a client started with its own file can hide Herdr's sidebar (Conn already draws the
// sidebar) without touching `~/.config/herdr/config.toml`, which every other Herdr client and the server read.
//
// Two rules hold here and nowhere else is allowed to bend them:
//   - a config path is only ever one Conn wrote itself, or one the person named that lives in Conn's own Application
//     Support folder or a temporary folder: never the Herdr config folder, never a path that only looks like it is elsewhere;
//   - the path is checked every time before use, and a path that fails is reported, not replaced by another one.
// The generated file is the person's own Herdr config with those two `[ui]` keys set (a client config replaces the whole
// config, so without the rest the client would lose their prefix key, theme and keybindings). Their config is only read.
// This file never runs `herdr server reload-config` and never writes outside Conn's folder.
import Foundation

public enum HerdrClientConfig {
    /// A folder under Conn's Application Support folder, so the generated file never sits beside Herdr's own config.
    public static let supportSubdirectory = "herdr-client"
    public static let hiddenSidebarFileName = "hidden-sidebar.toml"
    /// Largest config file a custom path may name: a Herdr config is a few kilobytes, a larger file is not one.
    public static let maxBytes = 64 * 1024

    /// `ui.sidebar_start_collapsed` starts the client with the sidebar collapsed, and `hidden` keeps the collapsed sidebar
    /// from leaving a thin rail. Herdr's own prefix key then `b` still shows and hides it.
    public static let hiddenSidebarKeys = ["sidebar_start_collapsed = true", "sidebar_collapsed_mode = \"hidden\""]
    private static let generatedHeader = """
    # Written by Conn for its embedded Herdr client: the Herdr config below with the sidebar keys under [ui] set to hide it.
    # The server and every other client keep reading the original. Conn rewrites this file each time it starts the client.

    """

    /// The generated file for a person's config text `base` (nil or empty: no config, only the sidebar keys). The two keys are
    /// set under `[ui]` (replacing the person's own values for them) and every other line is kept. Returns nil for a config
    /// whose `ui` table is spelled in a way this line-based edit cannot touch safely (dotted `ui.key` or inline `ui = {}`
    /// keys, or two `[ui]` headers), so a file that Herdr might read differently is never written.
    public static func hiddenSidebarContents(merging base: String?) -> String? {
        let keyNames = Set(hiddenSidebarKeys.compactMap { $0.split(separator: " ").first.map(String.init) })
        let ui = hiddenSidebarKeys.map { $0 + "\n" }.joined()
        guard let base = base, !base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return generatedHeader + "[ui]\n" + ui
        }
        var out: [String] = []
        var inUI = false, sawUI = false, sawHeader = false
        for line in base.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if let name = tableName(t) {
                sawHeader = true
                inUI = (name == "ui")
                if inUI {
                    if sawUI { return nil }
                    sawUI = true
                    out.append(line)
                    out.append(contentsOf: hiddenSidebarKeys)
                    continue
                }
            } else if inUI, let key = t.split(separator: "=", maxSplits: 1).first.map({ $0.trimmingCharacters(in: .whitespaces) }), keyNames.contains(key) {
                continue
            } else if !sawHeader, t.range(of: "^ui\\s*[.=]", options: .regularExpression) != nil || t.range(of: "^\"ui\"\\s*[.=]", options: .regularExpression) != nil {
                return nil
            }
            out.append(line)
        }
        var text = out.joined(separator: "\n")
        if !sawUI { text += (text.hasSuffix("\n") ? "" : "\n") + "\n[ui]\n" + ui }
        return generatedHeader + text + (text.hasSuffix("\n") ? "" : "\n")
    }

    private static let tableHeader = try! NSRegularExpression(pattern: #"^(\[\[?)\s*([A-Za-z0-9_. "-]+?)\s*\]\]?\s*(#.*)?$"#)

    /// The table a `[name]` header line opens, or nil for any other line. An `[[array]]` header is named "[[array]]", so it
    /// is never taken for the `ui` table.
    private static func tableName(_ trimmed: String) -> String? {
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard trimmed.hasPrefix("["), let m = tableHeader.firstMatch(in: trimmed, range: range),
              let open = Range(m.range(at: 1), in: trimmed), let name = Range(m.range(at: 2), in: trimmed) else { return nil }
        return trimmed[open] == "[[" ? "[[\(trimmed[name])]]" : String(trimmed[name])
    }

    /// Where Herdr reads its own config: `HERDR_CONFIG_PATH`, else `$XDG_CONFIG_HOME/herdr/config.toml`, else `~/.config/herdr/config.toml`.
    public static func defaultSourceConfig(environment: [String: String] = ProcessInfo.processInfo.environment,
                                           home: String = NSHomeDirectory()) -> URL {
        if let p = environment["HERDR_CONFIG_PATH"], p.hasPrefix("/") { return URL(fileURLWithPath: p) }
        if let x = environment["XDG_CONFIG_HOME"], x.hasPrefix("/") { return URL(fileURLWithPath: x).appendingPathComponent("herdr/config.toml") }
        return herdrConfigDirectory(home: home).appendingPathComponent("config.toml")
    }

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case notAbsolute(String)
        case unprintable
        case insideHerdrConfig(String)
        case outsideAllowedFolders(String)
        case notFound(String)
        case notAFile(String)
        case tooLarge(String)
        case notText(String)
        case cannotWrite(String)
        case cannotMerge(String)

        public var description: String {
            switch self {
            case .notAbsolute(let p): return "The Herdr client config path must be absolute: \(p)"
            case .unprintable: return "The Herdr client config path has a control character in it."
            case .insideHerdrConfig(let p): return "The Herdr client config must not be in Herdr's own config folder: \(p)"
            case .outsideAllowedFolders(let p): return "The Herdr client config must be in Conn's Application Support folder or a temporary folder: \(p)"
            case .notFound(let p): return "The Herdr client config does not exist: \(p)"
            case .notAFile(let p): return "The Herdr client config is not a regular file: \(p)"
            case .tooLarge(let p): return "The Herdr client config is larger than \(HerdrClientConfig.maxBytes / 1024) KB: \(p)"
            case .notText(let p): return "The Herdr client config is not UTF-8 text: \(p)"
            case .cannotWrite(let p): return "Conn could not write the Herdr client config: \(p)"
            case .cannotMerge(let p): return "Conn could not hide Herdr's sidebar by editing \(p) (its ui settings are written in a form Conn does not edit). Turn the option off, or point Conn at a client config with --client-config."
            }
        }
    }

    public static func supportDirectory(home: String = NSHomeDirectory()) -> URL {
        ConnMigration.stateDirectory(home: home).appendingPathComponent(supportSubdirectory, isDirectory: true)
    }

    /// Herdr's own config folder: the one place a client config of Conn's must never be written or read from.
    public static func herdrConfigDirectory(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent(".config/herdr", isDirectory: true)
    }

    /// Folders a custom config path may be in.
    public static func allowedFolders(home: String = NSHomeDirectory(), temporaryDirectory: String = NSTemporaryDirectory()) -> [URL] {
        [ConnMigration.stateDirectory(home: home), URL(fileURLWithPath: temporaryDirectory, isDirectory: true),
         URL(fileURLWithPath: "/tmp", isDirectory: true)]
    }

    /// Check a config path and return the URL to hand to the client. Symlinks are followed before any folder check, so a
    /// link inside an allowed folder that points at Herdr's config (or anywhere else outside the allowed folders) fails.
    public static func validate(_ path: String, home: String = NSHomeDirectory(), temporaryDirectory: String = NSTemporaryDirectory(),
                                fileManager: FileManager = .default) throws -> URL {
        guard path.hasPrefix("/") else { throw Failure.notAbsolute(path) }
        guard !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw Failure.unprintable }
        let resolved = resolve(URL(fileURLWithPath: path))
        if isInside(resolved, resolve(herdrConfigDirectory(home: home))) || isInside(URL(fileURLWithPath: path).standardizedFileURL, herdrConfigDirectory(home: home)) {
            throw Failure.insideHerdrConfig(path)
        }
        guard allowedFolders(home: home, temporaryDirectory: temporaryDirectory).contains(where: { isInside(resolved, resolve($0)) }) else {
            throw Failure.outsideAllowedFolders(path)
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: resolved.path, isDirectory: &isDirectory) else { throw Failure.notFound(path) }
        guard !isDirectory.boolValue, let attrs = try? fileManager.attributesOfItem(atPath: resolved.path),
              (attrs[.type] as? FileAttributeType) == .typeRegular else { throw Failure.notAFile(path) }
        guard ((attrs[.size] as? NSNumber)?.intValue ?? 0) <= maxBytes else { throw Failure.tooLarge(path) }
        guard let data = fileManager.contents(atPath: resolved.path), let text = String(data: data, encoding: .utf8),
              !text.unicodeScalars.contains("\0") else { throw Failure.notText(path) }
        return resolved
    }

    /// Write the hidden-sidebar config into Conn's own folder (only when its contents differ) and return its checked path.
    /// `sourceConfig` is the person's Herdr config, read (never written) so the client keeps its prefix key, theme and keys.
    @discardableResult
    public static func writeHiddenSidebar(home: String = NSHomeDirectory(), temporaryDirectory: String = NSTemporaryDirectory(),
                                          sourceConfig: URL? = nil, fileManager: FileManager = .default) throws -> URL {
        let source = sourceConfig ?? defaultSourceConfig(home: home)
        var base: String?
        if fileManager.fileExists(atPath: source.path) {
            guard let attrs = try? fileManager.attributesOfItem(atPath: source.path), ((attrs[.size] as? NSNumber)?.intValue ?? 0) <= maxBytes else {
                throw Failure.tooLarge(source.path)
            }
            guard let data = fileManager.contents(atPath: source.path), let text = String(data: data, encoding: .utf8) else { throw Failure.notText(source.path) }
            base = text
        }
        guard let contents = hiddenSidebarContents(merging: base) else { throw Failure.cannotMerge(source.path) }
        let dir = supportDirectory(home: home)
        // Refuse before writing anything if Conn's folder is a link into Herdr's config folder.
        if isInside(resolve(dir), resolve(herdrConfigDirectory(home: home))) { throw Failure.insideHerdrConfig(dir.path) }
        let file = dir.appendingPathComponent(hiddenSidebarFileName)
        do {
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if (fileManager.contents(atPath: file.path).flatMap { String(data: $0, encoding: .utf8) }) != contents {
                try contents.write(to: file, atomically: true, encoding: .utf8)
                try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            }
        } catch {
            throw Failure.cannotWrite(file.path)
        }
        return try validate(file.path, home: home, temporaryDirectory: temporaryDirectory, fileManager: fileManager)
    }

    /// The config the client should start with: the custom path if one was named, else the generated hidden-sidebar file when
    /// `hideSidebar` is on, else nil (the client reads Herdr's own config, as any Herdr client does).
    public static func resolve(hideSidebar: Bool, custom: String?, home: String = NSHomeDirectory(),
                               temporaryDirectory: String = NSTemporaryDirectory(), sourceConfig: URL? = nil,
                               fileManager: FileManager = .default) throws -> URL? {
        if let custom = custom, !custom.isEmpty {
            return try validate(custom, home: home, temporaryDirectory: temporaryDirectory, fileManager: fileManager)
        }
        guard hideSidebar else { return nil }
        return try writeHiddenSidebar(home: home, temporaryDirectory: temporaryDirectory, sourceConfig: sourceConfig, fileManager: fileManager)
    }

    /// Follow symlinks even where the path does not exist yet: resolve the nearest folder that does, then put the rest back.
    private static func resolve(_ url: URL) -> URL {
        var existing = url.standardizedFileURL
        var rest: [String] = []
        while existing.path != "/", !FileManager.default.fileExists(atPath: existing.path) {
            rest.insert(existing.lastPathComponent, at: 0)
            existing = existing.deletingLastPathComponent()
        }
        return rest.reduce(existing.resolvingSymlinksInPath()) { $0.appendingPathComponent($1) }.standardizedFileURL
    }

    private static func isInside(_ child: URL, _ folder: URL) -> Bool {
        let c = child.standardizedFileURL.path, f = folder.standardizedFileURL.path
        return c == f || c.hasPrefix(f.hasSuffix("/") ? f : f + "/")
    }
}
