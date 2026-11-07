// A small JSON value for Campus payloads. Campus's API is private and unversioned (scout report section 3), so every reader in this
// folder is tolerant: a missing key is nil, a wrong type is nil, an unknown key is ignored. Nothing here ever throws on a Campus answer.
import Foundation

public enum CampusJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CampusJSON])
    case object([String: CampusJSON])

    public init(any: Any?) {
        switch any {
        case let n as NSNumber: self = CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { CampusJSON(any: $0) })
        case let o as [String: Any]: self = .object(o.mapValues { CampusJSON(any: $0) })
        default: self = .null
        }
    }

    public static func parse(_ data: Data) -> CampusJSON? {
        guard let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        return CampusJSON(any: any)
    }

    public static func parse(_ text: String) -> CampusJSON? { text.data(using: .utf8).flatMap(parse) }

    public subscript(key: String) -> CampusJSON { if case .object(let o) = self { return o[key] ?? .null }; return .null }
    public subscript(index: Int) -> CampusJSON { if case .array(let a) = self, a.indices.contains(index) { return a[index] }; return .null }

    /// The first of these keys that holds a value.
    public func first(_ keys: String...) -> CampusJSON {
        for k in keys { let v = self[k]; if v != .null { return v } }
        return .null
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var number: Double? { if case .number(let n) = self { return n }; return nil }
    public var int: Int? { number.map { Int($0) } }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [CampusJSON] { if case .array(let a) = self { return a }; return [] }
    public var object: [String: CampusJSON]? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { self == .null }

    /// A time: epoch milliseconds or seconds, or an ISO string.
    public var date: Date? {
        if let n = number, n > 0 { return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n) }
        guard let s = string, !s.isEmpty else { return nil }
        let t = s.replacingOccurrences(of: "(\\.\\d{3})\\d+", with: "$1", options: .regularExpression)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: t) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: t)
    }

    /// Plain text of a value that may be a string, a list of strings or of `{text}` parts.
    public var plainText: String {
        switch self {
        case .string(let s): return s
        case .array(let a): return a.map(\.plainText).filter { !$0.isEmpty }.joined(separator: "\n")
        case .object: return first("text", "content", "value", "message").plainText
        default: return ""
        }
    }
}
