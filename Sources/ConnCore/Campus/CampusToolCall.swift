// What a Campus tool call carries, read the way Campus's own page shows it: the name ("execute"), a short title ("campus.search"), the input (a `code` block of
// JavaScript, a command, a file), the result (usually JSON) and the state. Campus's API is private and unversioned, so the keys are looked up under the places
// opencode v2 puts them, flat on the event or part (`input`, `output`) and nested under `state` (`state.input`, `state.output`), with the result as text parts
// (`content: [{type:"text", text}]`) or as a value (`structured`). Nothing here throws on a shape it does not know: the field is just empty.
import Foundation

extension CampusItem {
    /// How a block of a tool call's text is shown: as plain text, as code, or as JSON (already pretty-printed).
    public enum Format: String, Equatable, Sendable { case text, code, json }
}

public enum CampusToolCall {
    /// The longest input and result kept for display. The rest is cut with a line that says how much (the page and the native card show that line).
    public static let inputLimit = 6_000
    public static let outputLimit = 16_000

    static let inputKeys = ["input", "args", "arguments", "parameters"]
    /// Keys whose single string value is code, not a command or a word.
    static let codeKeys: Set<String> = ["code", "script", "source", "js", "javascript", "python", "sql"]

    // MARK: input

    /// The input of a call or of a message's tool part, wherever it is: the event's own `input`, or `state.input` of a part.
    static func inputValue(_ d: CampusJSON) -> CampusJSON {
        for k in inputKeys { let v = d[k]; if !v.isNull { return v } }
        for k in inputKeys { let v = d["state"][k]; if !v.isNull { return v } }
        return .null
    }

    /// The input as text to read and its format. One string field is the string itself (a field called `code` is code); anything with several fields is pretty JSON.
    public static func input(_ d: CampusJSON) -> (text: String, format: CampusItem.Format) {
        var v = inputValue(d)
        if let s = v.string, let parsed = CampusJSON.parse(s), parsed.object != nil { v = parsed }
        if let s = v.string { return (limit(s, inputLimit), .text) }
        guard let o = v.object, !o.isEmpty else { return ("", .text) }
        if o.count == 1, let (k, value) = o.first, let s = value.string { return (limit(s, inputLimit), codeKeys.contains(k.lowercased()) ? .code : .text) }
        return (limit(CampusJSONText.pretty(v), inputLimit), .json)
    }

    // MARK: title

    /// The short name of what a call does: the title Campus gives it, else (for a code call) the tools the code calls, as `campus.search`.
    public static func title(_ d: CampusJSON, code: String) -> String {
        for place in [d, d["state"], d["metadata"], d["state"]["metadata"]] {
            if let t = place.first("title", "label").string?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return String(t.prefix(80)) }
        }
        return derivedTitle(code: code)
    }

    static let callPattern = try? NSRegularExpression(pattern: #"\btools\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\("#)
    /// The distinct `tools.<name>(` calls in a piece of code, in order ("campus.search", "campus.read, slack.post"), or "" when there is none.
    static func derivedTitle(code: String) -> String {
        guard !code.isEmpty, let re = callPattern else { return "" }
        let ns = code as NSString
        var names: [String] = []
        for m in re.matches(in: code, range: NSRange(location: 0, length: ns.length)) where m.numberOfRanges > 1 {
            let name = ns.substring(with: m.range(at: 1))
            if !names.contains(name) { names.append(name) }
        }
        guard !names.isEmpty else { return "" }
        return names.prefix(3).joined(separator: ", ") + (names.count > 3 ? " +\(names.count - 3)" : "")
    }

    // MARK: result

    /// The result of a call (a success, a failure, a part that has finished): its text, and whether that text is JSON. Nil when the frame carries none.
    public static func output(_ d: CampusJSON) -> (text: String, format: CampusItem.Format)? {
        let state = d["state"]
        for v in [d["output"], d["result"], state["output"], state["result"]] where !v.isNull {
            let r = render(v); if !r.text.isEmpty { return clipped(r) }
        }
        for v in [d["content"], state["content"]] where !v.isNull {
            let r = render(v); if !r.text.isEmpty { return clipped(r) }
        }
        for v in [d["structured"], state["structured"]] where !v.isNull {
            let r = render(v); if !r.text.isEmpty { return clipped(r) }
        }
        for v in [d["error"], state["error"]] where !v.isNull {
            let s = v.plainText; if !s.isEmpty { return clipped((s, .text)) }
        }
        return nil
    }

    private static func clipped(_ r: (text: String, format: CampusItem.Format)) -> (text: String, format: CampusItem.Format) { (limit(r.text, outputLimit), r.format) }

    /// A value as text: a string as it is (JSON text re-indented), a list of text parts joined, anything else as pretty JSON.
    static func render(_ v: CampusJSON) -> (text: String, format: CampusItem.Format) {
        switch v {
        case .string(let s):
            if let p = CampusJSONText.prettyIfJSON(s) { return (p, .json) }
            return (s, .text)
        case .array(let a):
            let parts = a.compactMap { textPart($0) }
            if !parts.isEmpty && parts.count == a.count {
                if parts.count == 1 { return render(.string(parts[0])) }
                return (parts.joined(separator: "\n"), .text)
            }
            return a.isEmpty ? ("", .text) : (CampusJSONText.pretty(v), .json)
        case .object(let o):
            if let t = textPart(v) { return render(.string(t)) }
            return o.isEmpty ? ("", .text) : (CampusJSONText.pretty(v), .json)
        case .number(let n): return (n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n), .text)
        case .bool(let b): return (b ? "true" : "false", .text)
        case .null: return ("", .text)
        }
    }

    /// The text of a content block (`{type:"text", text}`, or a bare string); nil for anything else (a file block, a structured value).
    private static func textPart(_ v: CampusJSON) -> String? {
        if let s = v.string { return s }
        if let o = v.object, o["type"]?.string == "text", let s = o["text"]?.string { return s }
        return nil
    }

    // MARK: time

    /// How long the call ran, in milliseconds, from a duration key or from the part's `time` (`ran` and `completed`, or `start` and `end`).
    public static func milliseconds(_ d: CampusJSON) -> Double? {
        if let ms = d.first("duration", "durationMs", "elapsed").number { return ms }
        for t in [d["time"], d["state"]["time"]] {
            if let a = t.first("ran", "start", "started").number, let b = t.first("completed", "end", "ended").number, b >= a { return b - a }
        }
        return nil
    }

    // MARK: cutting

    /// 4000 as "4,000", whatever the Mac's language is (the line is part of the text the page shows).
    static func grouped(_ n: Int) -> String {
        var out = ""
        for (i, c) in String(n).reversed().enumerated() { if i > 0, i % 3 == 0 { out.append(",") }; out.append(c) }
        return String(out.reversed())
    }

    /// `s` cut to `n` characters, with a last line that says how much was left out (the card and the page show it as part of the text).
    static func limit(_ s: String, _ n: Int) -> String {
        guard s.count > n else { return s }
        let rest = s.count - n
        return String(s.prefix(n)) + "\n… \(grouped(rest)) more character\(rest == 1 ? "" : "s") not shown"
    }
}

/// JSON text, indented the way a person reads it (two spaces, one key per line). A value that is already text is re-indented without moving a key, so a result keeps
/// the order its tool wrote; a value that was parsed (a dictionary) has no order left and comes out with its keys sorted.
public enum CampusJSONText {
    /// A parsed value as indented JSON, keys sorted.
    public static func pretty(_ v: CampusJSON) -> String {
        let any = foundation(v)
        guard any is [Any] || any is [String: Any], let d = try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys, .withoutEscapingSlashes]),
              let compact = String(data: d, encoding: .utf8) else { return v.plainText }
        return indent(compact)
    }

    /// `text` as indented JSON when it is a JSON object or list (and nothing else), with its own order; nil otherwise.
    public static func prettyIfJSON(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let f = t.first, f == "{" || f == "[", let data = t.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) != nil else { return nil }
        return indent(t)
    }

    private static func foundation(_ v: CampusJSON) -> Any {
        switch v {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map(foundation)
        case .object(let o): return o.mapValues(foundation)
        }
    }

    /// Re-indent JSON text: a newline and two spaces per level after `{`, `[` and `,`, a space after `:`, strings untouched, an empty `{}` or `[]` kept whole.
    static func indent(_ text: String) -> String {
        var out = ""
        var level = 0
        var inString = false, escaped = false
        let chars = Array(text)
        func newline() { out.append("\n"); out.append(String(repeating: "  ", count: level)) }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if inString {
                out.append(c)
                if escaped { escaped = false } else if c == "\\" { escaped = true } else if c == "\"" { inString = false }
            } else {
                switch c {
                case "\"": inString = true; out.append(c)
                case "{", "[":
                    var j = i + 1
                    while j < chars.count, chars[j].isWhitespace { j += 1 }
                    if j < chars.count, chars[j] == (c == "{" ? "}" : "]") { out.append(c); out.append(chars[j]); i = j } else { out.append(c); level += 1; newline() }
                case "}", "]": level = max(0, level - 1); newline(); out.append(c)
                case ",": out.append(c); newline()
                case ":": out.append(": ")
                default: if !c.isWhitespace { out.append(c) }
                }
            }
            i += 1
        }
        return out
    }
}
