import Testing
import Foundation
@testable import ConnCore

/// A Campus tool call as Campus's own page shows it ("execute campus.search", Done): the call's input (a `code` block of JavaScript), its result (JSON) and its state.
/// The shapes are invented from opencode v2's message schema (nested `state`, a result in `content[]` and `structured`) and from the flat shape the older tests use.
@Suite struct CampusToolCallTests {
    static let code = "const searches = [ { q: \"UHS app home screen\", k: \"UHS home screen placement app\" }, { q: \"Config Center feature flags\", k: \"Config Center flag owner\" } ];\nconst out = [];\nfor (const s of searches) {\n  const r = await tools.campus.search({ query: s.q, keywords: s.k, limit: 10 });\n  out.push({ q: s.q, hits: (r.hits || []).map(h => ({ path: h.path, heading: h.heading })) });\n}\nreturn out;"
    static let result = #"[{"q":"UHS app home screen","hits":[{"path":"product/dine-out/reference/product-and-user-flow","heading":null,"link":"https://campus.example.test/kb/product/dine-out","snippet":"Dine Out - Product and user flow"}]},{"q":"Config Center feature flags","hits":[]}]"#

    static func frame(_ type: String, _ json: String) -> CampusFrame { CampusFrame(type: type, data: CampusJSON.parse(json)!) }

    /// The run as the stream tells it: the name first, the input when the call is made, and the result under `content` and `structured`.
    static func streamed() -> CampusTimeline {
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        let input = String(data: try! JSONSerialization.data(withJSONObject: ["code": code]), encoding: .utf8)!
        t.apply(frame("session.tool.input.started", #"{"callID":"call_1","name":"execute"}"#))
        t.apply(frame("session.tool.called", #"{"callID":"call_1","tool":"execute","input":\#(input)}"#))
        let text = String(data: try! JSONSerialization.data(withJSONObject: [["type": "text", "text": result]]), encoding: .utf8)!
        t.apply(frame("session.tool.success", #"{"callID":"call_1","content":\#(text),"structured":\#(result)}"#))
        return t
    }

    @Test func theInputAndTheResultOfAStreamedCallAreKept() throws {
        let tool = try #require(Self.streamed().items.first { $0.kind == .tool })
        #expect(tool.tool == "execute" && tool.toolStatus == .ok)
        #expect(tool.input == Self.code && tool.inputFormat == .code)
        #expect(tool.argument.contains("const searches"))
        #expect(tool.title == "campus.search")
        #expect(tool.outputFormat == .json && tool.output.contains("\"hits\""))
    }

    @Test func aResultKeepsTheOrderItsToolWroteItInAndIsIndented() throws {
        let tool = try #require(Self.streamed().items.first { $0.kind == .tool })
        #expect(tool.output.hasPrefix("[\n  {\n    \"q\": \"UHS app home screen\",\n    \"hits\": [\n      {\n        \"path\": \"product/dine-out/reference/product-and-user-flow\",\n        \"heading\": null,"))
        #expect(tool.output.hasSuffix("\"hits\": []\n  }\n]"))
    }

    @Test func aResultThatCameOnlyAsAValueIsIndentedWithSortedKeys() throws {
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        t.apply(Self.frame("session.tool.called", #"{"callID":"c","tool":"execute","input":{"code":"return tools.campus.search({query:'x'})"}}"#))
        t.apply(Self.frame("session.tool.success", #"{"callID":"c","structured":{"q":"x","hits":[{"path":"a/b"}],"notSearched":false}}"#))
        let tool = try #require(t.items.first)
        #expect(tool.output == "{\n  \"hits\": [\n    {\n      \"path\": \"a/b\"\n    }\n  ],\n  \"notSearched\": false,\n  \"q\": \"x\"\n}" && tool.outputFormat == .json)
    }

    @Test func aMessagesToolPartKeepsItsInputItsResultItsTimeAndItsState() throws {
        let input = String(data: try JSONSerialization.data(withJSONObject: ["code": Self.code]), encoding: .utf8)!
        let text = String(data: try JSONSerialization.data(withJSONObject: [["type": "text", "text": Self.result]]), encoding: .utf8)!
        let json = #"{"data":[{"type":"assistant","id":"m2","content":[{"type":"tool","callID":"call_1","name":"execute","state":{"status":"completed","input":\#(input),"content":\#(text)},"time":{"created":1000,"ran":1100,"completed":2400}},{"type":"tool","callID":"call_2","name":"execute","state":{"status":"error","input":{"code":"return tools.slack.post({})"},"error":{"type":"tool","message":"slack is not connected"}}}]},{"type":"user","id":"m1","text":"Find it"}]}"#
        let items = try #require(CampusTimeline.items(fromMessages: Data(json.utf8))).filter { $0.kind == .tool }
        #expect(items.count == 2)
        #expect(items[0].input == Self.code && items[0].title == "campus.search" && items[0].toolStatus == .ok && items[0].detail == "1.3s")
        #expect(items[0].outputFormat == .json && items[0].output.contains("\"snippet\": \"Dine Out - Product and user flow\""))
        #expect(items[1].toolStatus == .failed && items[1].output == "slack is not connected" && items[1].title == "slack.post")
    }

    @Test func theTitleCampusGivesBeatsTheOneReadFromTheCode() throws {
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        t.apply(Self.frame("session.tool.called", #"{"callID":"c","tool":"execute","title":"Search the Knowledge Base","input":{"code":"return tools.campus.search({})"}}"#))
        #expect(t.items.first?.title == "Search the Knowledge Base")
        #expect(CampusToolCall.derivedTitle(code: "await tools.a.b(1); await tools.c.d(2); await tools.a.b(3); tools.e.f(); tools.g.h()") == "a.b, c.d, e.f +1")
        #expect(CampusToolCall.derivedTitle(code: "const tools2 = 1; return mytools.a.b(1)") == "")
    }

    @Test func aLongResultIsCutWithALineThatSaysHowMuchWasLeftOut() throws {
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        t.apply(Self.frame("session.tool.called", #"{"callID":"c","tool":"shell","input":{"command":"cat big.log"}}"#))
        let big = String(repeating: "0123456789", count: 2_000)
        t.apply(Self.frame("session.tool.success", #"{"callID":"c","output":"\#(big)"}"#))
        let tool = try #require(t.items.first)
        #expect(tool.output.count < 16_100 && tool.output.hasSuffix("\n… 4,000 more characters not shown"))
        #expect(tool.input == "cat big.log" && tool.inputFormat == .text)
    }

    @Test func severalInputFieldsAreShownAsJSONAndOneStringFieldAsItself() throws {
        #expect(CampusToolCall.input(CampusJSON.parse(#"{"input":{"filePath":"/w/a.csv"}}"#)!) == ("/w/a.csv", .text))
        let many = CampusToolCall.input(CampusJSON.parse(#"{"input":{"command":"ls","description":"List","timeout":5}}"#)!)
        #expect(many.format == .json && many.text == "{\n  \"command\": \"ls\",\n  \"description\": \"List\",\n  \"timeout\": 5\n}")
        #expect(CampusToolCall.input(CampusJSON.parse(#"{"input":"{\"code\":\"return 1\"}"}"#)!) == ("return 1", .code))
        #expect(CampusToolCall.input(CampusJSON.parse(#"{"tool":"x"}"#)!).text.isEmpty)
    }

    @Test func theIndenterKeepsStringsAndOrderAndEmptyContainers() throws {
        let text = #"{"b":1,"a":[1,2,{"c":"x,y:{[\"q\"]}"}],"e":{},"f":[ ],"g":null,"h":-1.5e3}"#
        let want = "{\n  \"b\": 1,\n  \"a\": [\n    1,\n    2,\n    {\n      \"c\": \"x,y:{[\\\"q\\\"]}\"\n    }\n  ],\n  \"e\": {},\n  \"f\": [],\n  \"g\": null,\n  \"h\": -1.5e3\n}"
        #expect(CampusJSONText.prettyIfJSON(text) == want)
        #expect(CampusJSONText.prettyIfJSON("plain words") == nil && CampusJSONText.prettyIfJSON("{broken") == nil && CampusJSONText.prettyIfJSON("42") == nil)
    }

    @Test func theEmbedPageGetsTheTitleTheWholeInputAndTheResultAsJSON() throws {
        let embed = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.json(id: "c", timeline: Self.streamedWithReply(), working: false).utf8)) as? [String: Any])
        let reply = try #require((embed["blocks"] as? [[String: Any]])?.last)
        let tool = try #require((reply["tools"] as? [[String: Any]])?.first)
        #expect(tool["tool"] as? String == "execute" && tool["status"] as? String == "ok" && tool["title"] as? String == "campus.search")
        #expect(tool["argument"] as? String == Self.code && tool["input"] as? String == Self.code && tool["inputFormat"] as? String == "code")
        #expect((tool["output"] as? String)?.contains("\"hits\": [") == true && tool["outputFormat"] as? String == "json")
    }

    @Test func aToolWithOneInputFieldKeepsTheOldFieldsAndAddsNoTitle() throws {
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        t.apply(Self.frame("session.tool.called", #"{"callID":"c","tool":"read","input":{"filePath":"/w/a.csv"}}"#))
        t.apply(Self.frame("session.tool.success", #"{"callID":"c","output":"20 rows","duration":12}"#))
        t.apply(Self.frame("session.text.delta", #"{"delta":"ok"}"#))
        let embed = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.json(id: "c", timeline: t, working: false).utf8)) as? [String: Any])
        let tool = try #require(((embed["blocks"] as? [[String: Any]])?.last?["tools"] as? [[String: Any]])?.first)
        #expect(Set(tool.keys) == ["tool", "argument", "output", "status", "detail", "input", "inputFormat", "outputFormat"])
        #expect(tool["argument"] as? String == "/w/a.csv" && tool["output"] as? String == "20 rows" && tool["detail"] as? String == "12 ms" && tool["title"] == nil)
    }

    static func streamedWithReply() -> CampusTimeline {
        var t = streamed()
        t.apply(frame("session.text.delta", #"{"delta":"Found it."}"#))
        return t
    }
}
