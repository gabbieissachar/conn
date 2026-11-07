// Campus in Conn, slice 1: reading. The fixtures are the stand-in Campus's (invented content built from the API shapes in the scout
// report): no real conversation text, names or ids.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

private func data(_ s: String) -> Data { Data(s.utf8) }

@Suite("Campus: reading the private API's answers") struct CampusParseTests {
    @Test func spacesComeFromPrivateAndShared() throws {
        let list = try #require(CampusSpace.parseList(data(#"{"running":true,"newPrivateSpace":false,"private":[{"folderName":"default","displayName":"My space","colour":"blue"}],"shared":[{"folderName":"growth-ops","displayName":"Growth Ops","readOnly":true},{"folderName":"../etc","displayName":"bad"}]}"#)))
        #expect(list.map(\.id) == ["private/default", "team/growth-ops"])
        #expect(list[1].isTeam && list[1].readOnly && list[0].displayName == "My space")
    }

    @Test func aConversationListMapsToTheFourMarks() throws {
        let space = CampusSpace(kind: "private", folder: "default", displayName: "My space")
        let rows = try #require(CampusConversation.parseList(data(#"""
        {"conversations":[
          {"id":"ses_a1","title":"Asks","updatedAt":1793000000000,"working":false,"needsYou":true,"unread":false},
          {"id":"ses_b2","title":"Runs","updatedAt":"2026-11-07T09:00:00Z","working":true,"needsYou":false,"unread":false},
          {"id":"ses_c3","title":"Finished","working":false,"needsYou":false,"unread":true},
          {"id":"ses_d4","title":"","working":false,"needsYou":false,"unread":false},
          {"id":"bad id/../","title":"dropped"}],"hasMore":false,"partial":false}
        """#), space: space))
        #expect(rows.map(\.state) == [.blocked, .working, .done, .idle])
        #expect(rows.map(\.id) == ["ses_a1", "ses_b2", "ses_c3", "ses_d4"])
        #expect(rows[3].title == "Untitled conversation" && rows[0].spaceName == "My space")
        #expect(rows[0].updatedAt == Date(timeIntervalSince1970: 1_793_000_000) && rows[1].updatedAt != nil)
    }

    @Test func statusMapsBusyNeedsYouIdle() {
        #expect(CampusStatus.parse(data(#"{"state":"busy","unread":false}"#))?.run == .busy)
        #expect(CampusStatus.parse(data(#"{"state":"needs_you","unread":true,"parked":[],"held":[]}"#)) == CampusStatus(run: .needsYou, unread: true))
        #expect(CampusStatus.parse(data(#"{"state":"idle"}"#))?.run == .idle)
        #expect(CampusStatus.parse(data(#"{"state":"weird"}"#))?.run == .unknown("weird"))
        #expect(CampusStatus.parse(data("not json")) == nil)
    }

    @Test func aFormIsReadWhateverItsOptionsLookLike() throws {
        let forms = CampusForm.parseOpenForms(data(#"""
        {"sessionIDs":["ses_a1"],"permissions":[],"forms":[
          {"id":"frm_1","questions":[{"question":"Which week?","options":[{"label":"Last"},{"text":"This"},"Dates"]},{"question":"Format?","options":["Bullets","Table"]}]},
          {"id":"frm_2","questions":[]},{"questions":[{"question":"no id"}]}]}
        """#))
        #expect(forms.count == 1)
        let f = try #require(forms.first)
        #expect(f.questions.map(\.text) == ["Which week?", "Format?"] && f.questions[0].options == ["Last", "This", "Dates"])
        #expect(f.tag == "Answer sheet · 2 questions" && f.asText == "Which week? Format?")
        let single = try #require(CampusForm.parse(CampusJSON.parse(#"{"form":{"formID":"frm_9","questions":[{"text":"Go?","choices":["Yes","No"]}]}}"#)!))
        #expect(single.tag == "Question · 2 options" && single.id == "frm_9")
    }

    @Test func messagesAreReadOldestFirstAsItems() throws {
        let items = try #require(CampusTimeline.items(fromMessages: data(#"""
        {"data":[
          {"id":"m3","type":"idle","outcome":"done"},
          {"id":"m2","type":"assistant","tokens":{"input":2100,"output":96},"content":[
             {"type":"reasoning","text":"Think first."},
             {"type":"tool","name":"read","input":{"filePath":"notes/index.md"},"output":"ok","status":"completed","duration":300},
             {"type":"tool","name":"shell","input":{"command":"ls"},"status":"error"},
             {"type":"text","text":"Here is the answer."}]},
          {"id":"m1","type":"user","text":"Do the thing."},
          {"id":"m0","type":"model-switched"}],"cursor":{"previous":null,"next":null}}
        """#)))
        #expect(items.map(\.kind) == [.user, .step, .reasoning, .tool, .tool, .text, .idle])
        #expect(items[1].detail == "in 2.1k · out 96" && items[3].argument == "notes/index.md" && items[3].detail == "300 ms")
        #expect(items[4].toolStatus == .failed && items[5].text == "Here is the answer.")
        #expect(CampusTimeline.items(fromMessages: data("[]")) == nil)
    }

    @Test func aLinkToAConversationIsRecognisedOnlyOnCampusHost() throws {
        let ok = URL(string: "https://campus.example.test/spaces/team/growth-ops/conversations/ses_x1y2")!
        let r = try #require(CampusClient.conversationLink(ok, campusHost: "campus.example.test"))
        #expect(r.kind == "team" && r.folder == "growth-ops" && r.id == "ses_x1y2")
        #expect(CampusClient.conversationLink(ok, campusHost: "other.test") == nil)
        #expect(CampusClient.conversationLink(URL(string: "https://campus.example.test/spaces/other/x/conversations/ses_1234")!, campusHost: "campus.example.test") == nil)
        #expect(CampusClient.conversationLink(URL(string: "https://campus.example.test/campus/artifacts/a1")!, campusHost: "campus.example.test") == nil)
        #expect(CampusClient.webURL(base: URL(string: "https://campus.example.test")!, kind: "private", folder: "default", id: "ses_x1y2")?.absoluteString == "https://campus.example.test/spaces/private/default/conversations/ses_x1y2")
        #expect(CampusClient.webURL(base: URL(string: "https://campus.example.test")!, kind: "private", folder: "../x", id: "ses_x1y2") == nil)
    }
}

@Suite("Campus: the event stream") struct CampusStreamTests {
    private func frame(_ type: String, _ sid: String = "ses_a1", _ extra: String = "") -> String {
        "data: {\"id\":\"evt_1\",\"created\":1793000000000,\"type\":\"\(type)\",\"data\":{\"sessionID\":\"\(sid)\"\(extra)},\"durable\":{\"aggregateID\":\"\(sid)\",\"seq\":7,\"version\":1}}\n\n"
    }

    @Test func framesSurviveAnySplitAndHeartbeatsAreIgnored() {
        var r = CampusSSEReader()
        let text = ": heartbeat\n\n" + frame("session.step.started") + frame("session.text.delta", "ses_b2", ",\"delta\":\"hi\"")
        var got: [CampusFrame] = []
        for ch in text { got += r.feed(String(ch)) }       // one character at a time
        #expect(got.map(\.type) == ["session.step.started", "session.text.delta"])
        #expect(got[1].sessionID == "ses_b2" && got[1].data["delta"].string == "hi" && got[0].seq == 7)
        #expect(got[0].created == Date(timeIntervalSince1970: 1_793_000_000))
        var r2 = CampusSSEReader()
        #expect(r2.feed(frame("a.b").replacingOccurrences(of: "\n", with: "\r\n")).count == 1)
    }

    @Test func junkAndHugeBlocksAreDroppedNotFollowed() {
        var r = CampusSSEReader()
        #expect(r.feed("data: not json\n\ndata: {\"no\":\"type\"}\n\nevent: x\n\n").isEmpty)
        #expect(r.feed(String(repeating: "x", count: CampusSSEReader.maxBlock + 10)).isEmpty && r.dropped == 1)
        #expect(r.feed(frame("ok.after")).count == 1)
    }
}

@Suite("Campus: a run on the timeline") struct CampusTimelineTests {
    private func run(ask: Bool) async -> [CampusFrame] {
        let world = FakeCampusWorld()
        world.stepDelay = 0.005
        var reader = CampusSSEReader()
        var frames: [CampusFrame] = []
        let stream = world.subscribe()
        world.startRun("ses_fakeRates01", userText: "Compare them.", ask: ask)
        for await t in stream {
            frames += reader.feed(t)
            if frames.contains(where: { $0.type == (ask ? "form.created" : "session.idle") }) { break }
        }
        return frames
    }

    @Test func aRunBuildsStepsToolsReasoningTextAndAQuestion() async throws {
        var tl = CampusTimeline()
        tl.backfill([], fetchedAt: Date(timeIntervalSince1970: 0))
        for f in await run(ask: true) { tl.apply(f) }
        let kinds = tl.items.map(\.kind)
        #expect(kinds == [.user, .step, .reasoning, .tool, .tool, .step, .text, .form])
        #expect(tl.items[2].text == "Two tables, so read both first and then diff them merchant by merchant." && tl.items[2].streaming == false)
        #expect(tl.items[3].tool == "read" && tl.items[3].argument == "rates/table-a.csv" && tl.items[3].toolStatus == .ok && tl.items[3].detail == "400 ms")
        #expect(tl.items[4].tool == "shell" && tl.items[4].output == "14 of 20 merchants: B higher" && tl.items[1].detail == "in 2.1k · out 96")
        #expect(tl.items[6].text.hasPrefix("Table B pays more on 14 of the 20 merchants."))
        let f = try #require(tl.openForm)
        #expect(f.questions.first?.options == ["Top 5 by volume", "Biggest rate gaps", "All 20 in a table"])
        #expect(tl.live == "")
    }

    @Test func aFinishedRunEndsOnceAndNothingStreamsAnyMore() async {
        var tl = CampusTimeline()
        tl.backfill([], fetchedAt: Date(timeIntervalSince1970: 0))
        for f in await run(ask: false) { tl.apply(f) }
        #expect(tl.items.last?.kind == .idle && tl.items.filter { $0.kind == .idle }.count == 1)
        #expect(tl.items.allSatisfy { !$0.streaming } && tl.openForm == nil)
    }

    @Test func framesOlderThanTheBackfillAreNotAppliedTwice() {
        var tl = CampusTimeline()
        var user = CampusItem(id: "u", kind: .user); user.text = "Old question"
        tl.backfill([user], fetchedAt: Date(timeIntervalSince1970: 1_793_000_100))
        tl.apply(CampusFrame(created: Date(timeIntervalSince1970: 1_793_000_000), type: "session.step.started"))      // before the fetch: already in the backfill
        #expect(tl.items.count == 1)
        tl.apply(CampusFrame(created: Date(timeIntervalSince1970: 1_793_000_200), type: "session.step.started"))
        #expect(tl.items.map(\.kind) == [.user, .step])
    }

    @Test func stopMarksRunningToolsAsStopped() {
        var tl = CampusTimeline()
        tl.backfill([], fetchedAt: .distantPast)
        tl.apply(CampusFrame(type: "session.tool.input.started", data: CampusJSON.parse(#"{"callID":"c1","tool":"shell"}"#)!))
        tl.stopRun(stoppedByPerson: true)
        #expect(tl.items.map(\.kind) == [.tool, .stopped] && tl.items[0].toolStatus == .aborted)
    }
}
