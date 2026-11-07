// The Campus event stream (`GET /api/events`, scout report section 3.5): one Server-Sent Events stream per person. Frames are
// `data: <json>` blocks separated by a blank line; `: heartbeat` comment lines keep it alive. A frame looks like
// `{id: "evt_...", created: <ms>, type, location?: {directory}, data: {sessionID, ...}, durable?: {aggregateID, seq, version}}`.
// The reader below is incremental (bytes arrive in any split) and bounded (one block is never allowed to grow past 1 MB).
import Foundation

public struct CampusFrame: Equatable, Sendable {
    public var id: String
    public var created: Date?
    public var type: String
    public var sessionID: String?
    public var data: CampusJSON
    public var seq: Int?

    public init(id: String = "", created: Date? = nil, type: String, sessionID: String? = nil, data: CampusJSON = .null, seq: Int? = nil) {
        self.id = id; self.created = created; self.type = type; self.sessionID = sessionID; self.data = data; self.seq = seq
    }

    /// A frame from its JSON, or nil when it is not an object with a `type`.
    public static func parse(_ json: CampusJSON) -> CampusFrame? {
        guard let type = json["type"].string, !type.isEmpty else { return nil }
        let data = json["data"]
        let sid = data["sessionID"].string ?? data["sessionId"].string ?? json["durable"]["aggregateID"].string
        return CampusFrame(id: json["id"].string ?? "", created: json["created"].date, type: type, sessionID: sid, data: data, seq: json["durable"]["seq"].int)
    }
}

/// Splits stream text into frames. `feed` returns the frames that the new text completed and whether any bytes (a heartbeat counts) arrived.
public struct CampusSSEReader: Sendable {
    public static let maxBlock = 1_000_000
    private var buffer = ""
    public private(set) var dropped = 0
    public init() {}

    public mutating func feed(_ chunk: String) -> [CampusFrame] {
        buffer += chunk.replacingOccurrences(of: "\r\n", with: "\n")
        var out: [CampusFrame] = []
        while let r = buffer.range(of: "\n\n") {
            let block = String(buffer[..<r.lowerBound])
            buffer.removeSubrange(..<r.upperBound)
            if let f = Self.frame(in: block) { out.append(f) }
        }
        if buffer.utf8.count > Self.maxBlock { buffer = ""; dropped += 1 }
        return out
    }

    static func frame(in block: String) -> CampusFrame? {
        var payload: [String] = []
        for line in block.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("data:") { payload.append(String(line.dropFirst(5)).trimmingCharacters(in: .init(charactersIn: " "))) }
        }
        guard !payload.isEmpty, let json = CampusJSON.parse(payload.joined(separator: "\n")) else { return nil }
        return CampusFrame.parse(json)
    }

    public mutating func reset() { buffer = "" }
}
