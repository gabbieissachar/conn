// The keys Conn types into the embedded Herdr client to move it, read from the config that client runs with.
//
// Conn's sidebar moves the embedded client by typing Herdr's own keys into the client's pty (never the session-wide socket
// focus commands, which move every attached client). Which bytes those are depends on the client's key bindings, so they
// are read from the same file the client reads (the config Conn generated, or the one the person named) and fall back to
// Herdr's defaults for a key the file does not set. A binding this file cannot turn into bytes is reported, never guessed.
//
// What the keys are for, in Herdr 0.9.5:
//   prefix, then the workspace picker key   opens workspace navigation; there 1...9 jumps to that workspace at once,
//                                           Down moves the selection one workspace and Enter takes it
//   prefix, then a digit (`switch_tab`)     jumps to tab 1...9 of the workspace the client is on
//   prefix, then the next-tab key           moves one tab on (used to reach tab 10 and beyond from tab 9)
import Foundation

public struct HerdrClientKeymap: Equatable, Sendable {
    /// The bytes of the prefix key.
    public var prefix: [UInt8]
    /// The key typed after the prefix to open workspace navigation.
    public var workspacePicker: [UInt8]
    /// The key that moves the workspace selection down while workspace navigation is open (no prefix).
    public var navigateDown: [UInt8]
    /// The key typed after the prefix to move to the next tab.
    public var nextTab: [UInt8]

    public init(prefix: [UInt8], workspacePicker: [UInt8], navigateDown: [UInt8], nextTab: [UInt8]) {
        self.prefix = prefix; self.workspacePicker = workspacePicker; self.navigateDown = navigateDown; self.nextTab = nextTab
    }

    public static let enter: [UInt8] = [0x0d]

    /// Herdr's defaults: prefix ctrl+b, workspace navigation on `w`, next tab on `n`, Down arrow in navigation.
    public static let defaults = HerdrClientKeymap(prefix: [0x02], workspacePicker: Array("w".utf8), navigateDown: [0x1b, 0x5b, 0x42], nextTab: Array("n".utf8))

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case unsupported(action: String, binding: String)

        public var description: String {
            switch self {
            case .unsupported(let action, let binding):
                return "Conn cannot drive the Herdr client from its sidebar: the \(action) key (\(binding)) is not one Conn can type. Use a prefix-and-letter binding for it, or turn the client's own config off."
            }
        }
    }

    /// The map for a config file's text (nil or empty: Herdr's defaults). Throws for a key written in a form this cannot type.
    public static func parse(config: String?) throws -> HerdrClientKeymap {
        let keys = config.map(keysTable) ?? [:]
        let prefixSpec = keys["prefix"]?.first ?? "ctrl+b"
        guard let prefix = keyBytes(prefixSpec), prefix != [0x1b] else { throw Failure.unsupported(action: "prefix", binding: prefixSpec) }

        func prefixed(_ action: String, default fallback: String) throws -> [UInt8] {
            let values = keys[action] ?? [fallback]
            for v in values where v.hasPrefix("prefix+") {
                if let b = keyBytes(String(v.dropFirst("prefix+".count))) { return b }
            }
            throw Failure.unsupported(action: action, binding: values.joined(separator: ", "))
        }
        func direct(_ action: String, default fallback: String) throws -> [UInt8] {
            let values = keys[action] ?? [fallback]
            for v in values where !v.hasPrefix("prefix+") {
                if let b = keyBytes(v) { return b }
            }
            throw Failure.unsupported(action: action, binding: values.joined(separator: ", "))
        }
        // Jumping to a tab by number is prefix, then the digit itself. Any other form of this binding cannot be typed here.
        let switchTab = keys["switch_tab"] ?? ["prefix+1..9"]
        guard switchTab.contains("prefix+1..9") else { throw Failure.unsupported(action: "switch_tab", binding: switchTab.joined(separator: ", ")) }

        return HerdrClientKeymap(prefix: prefix, workspacePicker: try prefixed("workspace_picker", default: "prefix+w"),
                                 navigateDown: try direct("navigate_workspace_down", default: "down"),
                                 nextTab: try prefixed("next_tab", default: "prefix+n"))
    }

    /// The map for the config file a client starts with. `configPath` nil means the client reads Herdr's own config (the one
    /// `HERDR_CONFIG_PATH`, `XDG_CONFIG_HOME` or `~/.config/herdr` names); a missing file means Herdr's defaults.
    public static func load(configPath: URL?, home: String = NSHomeDirectory(), environment: [String: String] = ProcessInfo.processInfo.environment,
                            fileManager: FileManager = .default) throws -> HerdrClientKeymap {
        let file = configPath ?? HerdrClientConfig.defaultSourceConfig(environment: environment, home: home)
        guard fileManager.fileExists(atPath: file.path), let attrs = try? fileManager.attributesOfItem(atPath: file.path),
              ((attrs[.size] as? NSNumber)?.intValue ?? 0) <= HerdrClientConfig.maxBytes,
              let data = fileManager.contents(atPath: file.path), let text = String(data: data, encoding: .utf8) else { return defaults }
        return try parse(config: text)
    }

    // MARK: - Key names to bytes

    private static let named: [String: [UInt8]] = [
        "space": [0x20], "tab": [0x09], "enter": [0x0d], "esc": [0x1b], "minus": Array("-".utf8), "comma": Array(",".utf8),
        "plus": Array("+".utf8), "period": Array(".".utf8), "slash": Array("/".utf8), "backslash": Array("\\".utf8),
        "semicolon": Array(";".utf8), "backtick": Array("`".utf8), "ampersand": Array("&".utf8), "equals": Array("=".utf8),
        "up": [0x1b, 0x5b, 0x41], "down": [0x1b, 0x5b, 0x42], "right": [0x1b, 0x5b, 0x43], "left": [0x1b, 0x5b, 0x44],
        "f1": [0x1b, 0x4f, 0x50], "f2": [0x1b, 0x4f, 0x51], "f3": [0x1b, 0x4f, 0x52], "f4": [0x1b, 0x4f, 0x53],
        "f5": Array("\u{1b}[15~".utf8), "f6": Array("\u{1b}[17~".utf8), "f7": Array("\u{1b}[18~".utf8), "f8": Array("\u{1b}[19~".utf8),
        "f9": Array("\u{1b}[20~".utf8), "f10": Array("\u{1b}[21~".utf8), "f11": Array("\u{1b}[23~".utf8), "f12": Array("\u{1b}[24~".utf8),
    ]

    /// The bytes a terminal sends for one Herdr key name, or nil for a key this cannot type (alt, cmd, super and other
    /// chords, or a name it does not know). `ctrl+letter` is the control byte; `shift+letter` is the capital.
    static func keyBytes(_ spec: String) -> [UInt8]? {
        let s = spec.trimmingCharacters(in: .whitespaces).lowercased()
        if let b = named[s] { return b }
        if s.count == 1, let c = s.unicodeScalars.first, c.value > 0x20, c.value < 0x7f { return [UInt8(c.value)] }
        if s.hasPrefix("ctrl+") {
            let rest = String(s.dropFirst(5))
            if rest == "space" { return [0x00] }
            if rest.count == 1, let c = rest.unicodeScalars.first, c.value >= 0x61, c.value <= 0x7a { return [UInt8(c.value - 0x60)] }
            return nil
        }
        if s.hasPrefix("shift+") {
            let rest = String(s.dropFirst(6))
            if rest.count == 1, let c = rest.unicodeScalars.first, c.value >= 0x61, c.value <= 0x7a { return [UInt8(c.value - 0x20)] }
        }
        return nil
    }

    // MARK: - Reading the [keys] table

    /// The values of the `[keys]` table as lowercase strings (a key set to a list gives every entry, in order). Only a
    /// single-line `name = "x"` or `name = ["x", "y"]` (or one spread over lines) is read; other tables are left alone.
    static func keysTable(_ text: String) -> [String: [String]] {
        var result: [String: [String]] = [:]
        var inKeys = false
        var pending: (name: String, text: String)?
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let line = stripComment(raw).trimmingCharacters(in: .whitespaces)
            if var p = pending {
                p.text += " " + line
                if line.contains("]") { result[p.name] = strings(in: p.text); pending = nil } else { pending = p }
                continue
            }
            if line.hasPrefix("[") {
                inKeys = line.range(of: #"^\[\s*keys\s*\]$"#, options: .regularExpression) != nil
                continue
            }
            guard inKeys, let eq = line.firstIndex(of: "=") else { continue }
            let name = line[..<eq].trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("[") && !value.contains("]") { pending = (name, value); continue }
            result[name] = strings(in: value)
        }
        return result.filter { !$0.value.isEmpty }
    }

    /// Every double- or single-quoted string in `value`, lowercased.
    private static func strings(in value: String) -> [String] {
        var out: [String] = []
        var current = ""
        var quote: Character?
        for ch in value {
            if let q = quote {
                if ch == q { out.append(current.lowercased()); current = ""; quote = nil } else { current.append(ch) }
            } else if ch == "\"" || ch == "'" {
                quote = ch
            }
        }
        return out
    }

    private static func stripComment(_ line: String) -> String {
        var quote: Character?
        for i in line.indices {
            let ch = line[i]
            if let q = quote { if ch == q { quote = nil } }
            else if ch == "\"" || ch == "'" { quote = ch }
            else if ch == "#" { return String(line[..<i]) }
        }
        return line
    }
}
