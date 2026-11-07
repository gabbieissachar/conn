// Campus in Conn: the JSON the reader's embed page takes (E9=a). The page is pmos's; these tests pin Conn's half of its contract (README "The embed page" in
// the reader): the same fields `CampusTimeline.blocks()` has, markdown sent as the markdown it is, an open question left to Conn's own buttons.
import Testing
import Foundation
import ConnCore

private func parse(_ s: String) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any])
}

private func timeline(_ messages: String) throws -> CampusTimeline {
    let items = try #require(CampusTimeline.items(fromMessages: Data(messages.utf8)))
    var t = CampusTimeline()
    t.backfill(items, fetchedAt: Date(timeIntervalSince1970: 1_793_000_000))
    return t
}

// Newest first, as Campus answers (`order=desc`).
private let messages = #"""
{"data":[
 {"type":"assistant","id":"m3","content":[{"type":"text","text":"Done. The table is below."},
   {"type":"form","id":"frm_open","questions":[{"question":"Split by state?","options":["Yes","No"]}]}]},
 {"type":"assistant","id":"m2","content":[
   {"type":"tool","name":"bash","input":{"command":"python3 summarise.py"},"status":"error","output":"ERROR: no such file"},
   {"type":"tool","name":"read","input":{"filePath":"/workspace/a.csv"},"status":"completed","output":"market,redeemed","duration":12},
   {"type":"text","text":"## Summary\n\nSingapore grew **6%**.\n\n| Market | Change |\n|---|---|\n| SG | +6% |"}]},
 {"type":"user","id":"m1","text":"Summarise last week"}
]}
"""#

@Suite("Campus: the conversation as the reader's embed page takes it") struct CampusEmbedJSONTests {
    @Test func aConversationIsItsBlocksInReadingOrder() throws {
        let root = try parse(CampusEmbed.json(id: "ses_a1", timeline: try timeline(messages), working: false))
        #expect(root["id"] as? String == "ses_a1")
        #expect(root["live"] == nil)
        let blocks = try #require(root["blocks"] as? [[String: Any]])
        #expect(blocks.map { $0["kind"] as? String } == ["user", "reply"])
        #expect(blocks[0]["text"] as? String == "Summarise last week")
        #expect(blocks.allSatisfy { ($0["id"] as? String)?.isEmpty == false })
    }

    @Test func markdownGoesAcrossAsMarkdownAndToolsKeepTheirFields() throws {
        let root = try parse(CampusEmbed.json(id: "ses_a1", timeline: try timeline(messages), working: false))
        let reply = try #require((root["blocks"] as? [[String: Any]])?.last)
        let texts = try #require(reply["texts"] as? [String])
        #expect(texts.count == 2 && texts[0].hasPrefix("## Summary") && texts[0].contains("| SG | +6% |") && texts[1] == "Done. The table is below.")
        let tools = try #require(reply["tools"] as? [[String: Any]])
        #expect(tools.map { $0["tool"] as? String } == ["bash", "read"])
        #expect(tools.map { $0["status"] as? String } == ["failed", "ok"])
        #expect(tools[0]["argument"] as? String == "python3 summarise.py" && tools[0]["output"] as? String == "ERROR: no such file")
        #expect(tools[1]["argument"] as? String == "/workspace/a.csv" && tools[1]["detail"] as? String == "12 ms")
        #expect(reply["stopped"] as? Bool == false)
    }

    @Test func anOpenQuestionStaysWithConnsButtonsAnAnsweredOneGoesAcross() throws {
        var t = try timeline(messages)
        #expect(t.openForm?.id == "frm_open")
        var reply = try #require((try parse(CampusEmbed.json(id: "c", timeline: t, working: false))["blocks"] as? [[String: Any]])?.last)
        #expect(reply["form"] == nil)
        t.answerForm("frm_open", text: "Yes")
        reply = try #require((try parse(CampusEmbed.json(id: "c", timeline: t, working: false))["blocks"] as? [[String: Any]])?.last)
        let form = try #require(reply["form"] as? [String: Any])
        #expect(form["id"] as? String == "frm_open" && form["status"] as? String == "answered" && form["answer"] as? String == "Yes")
        let q = try #require((form["questions"] as? [[String: Any]])?.first)
        #expect(q["text"] as? String == "Split by state?" && q["options"] as? [String] == ["Yes", "No"])
    }

    @Test func aReplyThatHoldsOnlyAnOpenQuestionIsLeftOut() throws {
        let only = #"{"data":[{"type":"assistant","id":"m9","content":[{"type":"form","id":"frm_x","questions":[{"question":"Which?","options":["A","B"]}]}]},{"type":"user","id":"m8","text":"Go"}]}"#
        let blocks = try #require(try parse(CampusEmbed.json(id: "c", timeline: try timeline(only), working: false))["blocks"] as? [[String: Any]])
        #expect(blocks.map { $0["kind"] as? String } == ["user"])
    }

    @Test func theWorkingLineIsThereOnlyWhileTheRunGoes() throws {
        var t = try timeline(messages)
        t.apply(CampusFrame(type: "session.tool.input.started", data: CampusJSON.parse(#"{"callID":"c1","tool":"read"}"#)!))
        t.apply(CampusFrame(type: "session.tool.called", data: CampusJSON.parse(#"{"callID":"c1","tool":"read","input":{"filePath":"/w/table-a.csv"}}"#)!))
        #expect(try parse(CampusEmbed.json(id: "c", timeline: t, working: true))["live"] as? String == "reading table-a.csv")
        #expect(try parse(CampusEmbed.json(id: "c", timeline: t, working: false))["live"] == nil)
        #expect(try parse(CampusEmbed.json(id: "c", timeline: try timeline(messages), working: true))["live"] as? String == "starting")
    }

    @Test func aStreamingReplyAndAStoppedRunAreCarried() throws {
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        t.apply(CampusFrame(type: "session.text.delta", data: CampusJSON.parse(#"{"delta":"Working on **it**"}"#)!))
        var reply = try #require((try parse(CampusEmbed.json(id: "c", timeline: t, working: true))["blocks"] as? [[String: Any]])?.first)
        #expect(reply["streaming"] as? Bool == true && (reply["texts"] as? [String]) == ["Working on **it**"])
        t.stopRun(stoppedByPerson: true)
        reply = try #require((try parse(CampusEmbed.json(id: "c", timeline: t, working: false))["blocks"] as? [[String: Any]])?.first)
        #expect(reply["stopped"] as? Bool == true && reply["streaming"] as? Bool == false)
    }

    @Test func sameConversationSameTextSoTheViewCanSkipASend() throws {
        let t = try timeline(messages)
        #expect(CampusEmbed.json(id: "c", timeline: t, working: false) == CampusEmbed.json(id: "c", timeline: t, working: false))
    }

    @Test func anEmptyConversationIsAnEmptyList() throws {
        let root = try parse(CampusEmbed.json(id: "c", timeline: CampusTimeline(), working: false))
        #expect((root["blocks"] as? [Any])?.isEmpty == true)
    }

    @Test func textThatNeedsEscapingSurvivesTheTrip() throws {
        let nasty = "Quote \" and backslash \\ and newline\nand \u{2028} line separator </script>"
        var t = CampusTimeline()
        t.backfill([], fetchedAt: .distantPast)
        t.appendUser(nasty)
        let block = try #require((try parse(CampusEmbed.json(id: "c", timeline: t, working: false))["blocks"] as? [[String: Any]])?.first)
        #expect(block["text"] as? String == nasty)
    }
}
