// Campus in Conn: a permission the agent asks for (a command to run, a file to write) is shown and answered in Conn like a question (task conn-fix-queue-2, Nathan's
// item 4: "how can we enable the user permission handling right in Conn", and "need to surface the permission ask in transcript view also").
// The read shapes are the ones a live thread returned (ROADMAP N38: `GET .../requests` lists `permissions[]`, `.../permission` and `.../form` answer `{data: [...]}`), the reply is
// `POST .../permission/<id>/reply {"decision"}` (a guess until a person answers one); everything runs against the stand-in Campus, with no real Campus.
import Testing
import Foundation
@testable import ConnCore
import FakeCampusKit

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    // A wall-clock deadline with room: the suites run in parallel and one of them holds the main actor for about 20 s (see the other Campus suites).
    let end = Date().addingTimeInterval(max(timeout, 30))
    while !cond() && Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
    return cond()
}

@MainActor private func liveStore(hold: Double = 0.05) async -> (CampusStore, FakeCampusAuth, FakeCampusWorld) {
    let world = FakeCampusWorld()
    world.stepDelay = 0.01
    let auth = FakeCampusAuth(world: world)
    let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
    s.holdSeconds = hold; s.statusDelay = 0.02
    await s.refresh()
    return (s, auth, world)
}

private func json(_ s: String) -> CampusJSON { CampusJSON.parse(s)! }

@Suite("Campus permissions: reading one") struct CampusPermissionReadTests {
    @Test func aPermissionRequestIsOneQuestionWithItsChoicesAsOptions() throws {
        let f = try #require(CampusForm.parsePermission(json(#"{"id":"per_1","permission":"bash","patterns":["curl https://example.test","ls /tmp"]}"#)))
        #expect(f.id == "per_1" && f.isPermission && f.isOpen && f.permission?.name == "bash")
        #expect(f.questions.count == 1 && f.questions[0].text == "Allow bash: curl https://example.test, ls /tmp" && f.questions[0].options == ["Allow once", "Reject"])
        #expect(f.asText == "Allow bash: curl https://example.test, ls /tmp" && f.tag == "Permission · bash")
        #expect(f.permission?.value(for: "Allow once") == "once" && f.permission?.value(for: "Reject") == "reject" && f.permission?.value(for: "Always allow") == nil)
    }

    @Test func itIsFoundWhereverCampusPutsIt() throws {
        // opencode's event: the request under `permission`; another shape: under `request`; and the object bare.
        let nested = try #require(CampusForm.parsePermission(json(#"{"sessionID":"ses_a","permission":{"id":"per_n","permission":"edit","patterns":["src/app.swift"]}}"#)))
        #expect(nested.id == "per_n" && nested.permission?.name == "edit" && nested.asText == "Allow edit: src/app.swift")
        let req = try #require(CampusForm.parsePermission(json(#"{"request":{"requestID":"per_r","type":"webfetch","pattern":"https://example.test/a"}}"#)))
        #expect(req.id == "per_r" && req.permission?.name == "webfetch" && req.permission?.patterns == ["https://example.test/a"])
        // No id, no name and no pattern, an id that cannot go into a path: nothing true to show or answer, so nothing is read.
        #expect(CampusForm.parsePermission(json(#"{"permission":"bash","patterns":["x"]}"#)) == nil)
        #expect(CampusForm.parsePermission(json(#"{"id":"per_x"}"#)) == nil)
        #expect(CampusForm.parsePermission(json(#"{"id":"../per","permission":"bash"}"#)) == nil)
    }

    @Test func aStandingGrantIsNotOfferedAndTheChoicesCampusListsAreKept() throws {
        let strings = try #require(CampusForm.parsePermission(json(#"{"id":"per_s","permission":"bash","options":["once","always","reject"]}"#)))
        #expect(strings.questions[0].options == ["Allow once", "Reject"] && strings.permission?.value(for: "Allow once") == "once")
        let objects = try #require(CampusForm.parsePermission(json(#"{"id":"per_o","permission":"bash","choices":[{"label":"Run it","value":"once"},{"label":"Always","value":"always"},{"label":"No","value":"reject"}]}"#)))
        #expect(objects.questions[0].options == ["Run it", "No"] && objects.permission?.value(for: "Run it") == "once" && objects.permission?.value(for: "No") == "reject")
        // Only a standing grant listed: nothing Conn may offer, so the defaults.
        let only = try #require(CampusForm.parsePermission(json(#"{"id":"per_a","permission":"bash","options":["always"]}"#)))
        #expect(only.questions[0].options == ["Allow once", "Reject"])
    }

    @Test func nothingOfWhatIsAskedForIsCutAndAHiddenTailCannotBeAllowed() throws {
        // A long command is shown whole (the part past a cut could be the part that matters).
        let medium = String(repeating: "x", count: 1_500)
        let f = try #require(CampusForm.parsePermission(json(#"{"id":"per_l","permission":"bash","patterns":["\#(medium)"]}"#)))
        #expect(f.asText == "Allow bash: " + medium && f.questions[0].options == ["Allow once", "Reject"])
        // Past what anyone reads on a card, only Reject is offered, and the text is still whole.
        let huge = String(repeating: "y", count: 2_500)
        let g = try #require(CampusForm.parsePermission(json(#"{"id":"per_h","permission":"bash","patterns":["\#(huge)"]}"#)))
        #expect(g.asText == "Allow bash: " + huge && g.questions[0].options == ["Reject"] && g.permission?.value(for: "Allow once") == nil)
    }

    @Test func onlyPrintableAsciiAndLatinLettersPassAndTheLimitCountsWhatIsShown() throws {
        // Accented Latin letters read as they are; a Cyrillic look-alike, a no-break space, a combining mark and a soft hyphen are tokens.
        let f = try #require(CampusForm.parsePermission(json(#"{"id":"per_a","permission":"bash","patterns":["ls café/\u0430\u00a0x\u0301\u00ad"]}"#)))
        #expect(f.asText == "Allow bash: ls café/<U+0430><U+00A0>x<U+0301><U+00AD>")
        // The kind is shown the same way, and counts toward the limit with the escapes as shown: 300 look-alikes are 2,400 characters on the card.
        let g = try #require(CampusForm.parsePermission(json(#"{"id":"per_b","permission":"ba\u202esh","patterns":["\#(String(repeating: "\u{430}", count: 300))"]}"#)))
        #expect(g.asText.hasPrefix("Allow ba<U+202E>sh: <U+0430>") && g.questions[0].options == ["Reject"])
        #expect(g.permission?.tooLongToApprove == true)
    }

    @Test func lettersThatPassForAsciiAreTokensEvenAmongTheLatinOnes() throws {
        // ɑ (U+0251), dotless ı (U+0131), the click letters ǀ (U+01C0) and ǃ (U+01C3), kra ĸ and long s ſ look like a, i, l, !, k and f/s; é, ñ, ł and ß read as they are.
        let f = try #require(CampusForm.parsePermission(json(#"{"id":"per_h","permission":"bash","patterns":["\u0251\u0131\u01c0\u01c3\u0138\u017f \u00e9\u00f1\u0142\u00df"]}"#)))
        #expect(f.asText == "Allow bash: <U+0251><U+0131><U+01C0><U+01C3><U+0138><U+017F> éñłß")
    }

    @Test func lineBreaksControlsAndBidiOverridesAreMadeVisible() throws {
        let f = try #require(CampusForm.parsePermission(json(#"{"id":"per_c","permission":"bash","patterns":["echo ok\nrm -rf ~\u202e txt.exe\u200b"]}"#)))
        #expect(f.asText == "Allow bash: echo ok⏎rm -rf ~<U+202E> txt.exe<U+200B>")
        #expect(!f.asText.contains("\n") && !f.asText.unicodeScalars.contains("\u{202E}"))
    }

    @Test func theOpenRequestsListAPermissionFirstAndTheBridgesReadStaysQuestionsOnly() throws {
        let body = Data(#"{"sessionIDs":["ses_a"],"permissions":[{"id":"per_1","permission":"bash","patterns":["ls"]}],"forms":[{"id":"frm_1","questions":[{"question":"Which week?","options":["A","B"]}]}]}"#.utf8)
        let all = CampusForm.parseOpenRequests(body)
        #expect(all.map(\.id) == ["per_1", "frm_1"] && all[0].isPermission && !all[1].isPermission)
        #expect(CampusForm.parseOpenForms(body).map(\.id) == ["frm_1"])
        // `GET .../permission` may answer the permissions themselves, as a list.
        let bare = Data(#"[{"id":"per_2","permission":"edit","patterns":["a.txt"]}]"#.utf8)
        #expect(CampusForm.parseOpenRequests(bare, permissionsOnly: true).map(\.id) == ["per_2"])
        #expect(CampusForm.parseOpenRequests(bare).isEmpty)
    }

    /// The real answers of a thread that stopped on a permission (live, 2026-11-12), with the names and paths invented: `/form` was `{"data":[]}`, `/permission` `{"data":[...]}`, `/requests`
    /// `{sessionIDs, permissions, forms}`. Conn read only `/form` and found nothing, so the bridge said "no question could be read" and the card never appeared.
    static let liveItem = #"{"id":"per_demo0001","sessionID":"ses_demo0001","action":"shell","resources":["ls -la /workspace/spaces/team/Demo_Team/files/ 2>/dev/null","cat /workspace/spaces/team/Demo_Team/AGENTS.md 2>/dev/null","head -60"],"save":["ls *","cat *","head *"],"source":{"type":"tool","messageID":"msg_demo0001","id":"chatcmpl-tool-demo0001"},"message":"This changes a file the team’s Team Instance takes in as trusted (its instructions, agents, agent config or skills), so the person approves each change."}"#

    @Test func theLivePermissionShapeIsReadFromRequestsAndFromThePermissionRoute() throws {
        let requests = Data(#"{"sessionIDs":["ses_demo0001"],"permissions":[\#(Self.liveItem)],"forms":[]}"#.utf8)
        let fromRequests = try #require(CampusForm.parseOpenRequests(requests).first)
        #expect(fromRequests.id == "per_demo0001" && fromRequests.isPermission && fromRequests.isOpen && fromRequests.permission?.name == "shell")
        #expect(fromRequests.asText == "Allow shell: ls -la /workspace/spaces/team/Demo_Team/files/ 2>/dev/null, cat /workspace/spaces/team/Demo_Team/AGENTS.md 2>/dev/null, head -60")
        #expect(fromRequests.tag == "Permission · shell")
        // It comes from a tool call, so until that call's own command is read only Reject is on offer, and the card says why.
        #expect(fromRequests.permission?.needsConfirmation == true && fromRequests.questions[0].options == ["Reject"] && fromRequests.permission?.notice.contains("only Reject") == true)
        // Campus's reason travels with it, as plain text: the typographic apostrophe is not printable ASCII, so it shows as a token, never silently.
        #expect(fromRequests.permission?.reasonShown.hasPrefix("This changes a file the team<U+2019>s Team Instance takes in as trusted") == true)
        let route = Data(#"{"data":[\#(Self.liveItem)]}"#.utf8)
        #expect(CampusForm.parseOpenRequests(route, permissionsOnly: true).map(\.id) == ["per_demo0001"])
        // `/form` answered `{"data":[]}` and lists no permission: it is forms only.
        #expect(CampusForm.parseOpenForms(Data(#"{"data":[]}"#.utf8)).isEmpty && CampusForm.parseOpenRequests(Data(#"{"data":[]}"#.utf8)).isEmpty)
        // Its forms, when it has some, are in `data`.
        #expect(CampusForm.parseOpenForms(Data(#"{"data":[{"id":"frm_1","questions":[{"question":"Which week?","options":["A","B"]}]}]}"#.utf8)).map(\.id) == ["frm_1"])
    }

    /// `resources` is Campus's split of the command, not the command: here `ls -la x`, `cat y`, `head -60` stand for `ls -la x; cat y | head -60`, and a call could say `ls` in its
    /// resources and run something else. The card shows and grants what the tool call itself says (found by `source.messageID` and `source.id`).
    @Test func anAskFromAToolCallIsShownAndGrantedAgainstTheCallsOwnCommand() throws {
        let ask = try #require(CampusForm.parsePermission(json(Self.liveItem)))
        let msgs = { (id: String, tool: String, cmd: String) in Data(#"{"data":[{"id":"\#(id)","type":"assistant","content":[{"type":"tool","id":"\#(tool)","name":"shell","state":{"status":"running","input":{"command":"\#(cmd)"}}}]}]}"#.utf8) }
        let real = CampusPermission.toolCommands(inMessages: msgs("msg_demo0001", "chatcmpl-tool-demo0001", "ls -la /workspace/demo; cat /workspace/demo/AGENTS.md | head -60"))!
        let ok = ask.confirmed(calls: real)
        #expect(ok.asText == "Allow shell: ls -la /workspace/demo; cat /workspace/demo/AGENTS.md | head -60" && ok.questions[0].options == ["Allow once", "Reject"] && ok.permission?.notice == "")
        #expect(ok.permission?.value(for: "Allow once") == "once")
        // The resources say `ls`; the call runs something else: the card shows what runs.
        let swapped = ask.confirmed(calls: CampusPermission.toolCommands(inMessages: msgs("msg_demo0001", "chatcmpl-tool-demo0001", "rm -rf /workspace/demo"))!)
        #expect(swapped.asText == "Allow shell: rm -rf /workspace/demo" && !swapped.asText.contains("ls -la"))
        // Not found, another call, or another message: nothing more is offered.
        for calls in [[], CampusPermission.toolCommands(inMessages: msgs("msg_demo0001", "chatcmpl-tool-other", "ls"))!, CampusPermission.toolCommands(inMessages: msgs("msg_other", "chatcmpl-tool-demo0001", "ls"))!] {
            let f = ask.confirmed(calls: calls)
            #expect(f == ask && f.questions[0].options == ["Reject"] && f.permission?.value(for: "Allow once") == nil)
        }
        // A command too long to read on a card keeps Reject only, shown whole; and the input is never the reader's clipped copy.
        let huge = String(repeating: "a", count: CampusPermission.approvableLimit + 50)
        let big = ask.confirmed(calls: CampusPermission.toolCommands(inMessages: msgs("msg_demo0001", "chatcmpl-tool-demo0001", huge))!)
        #expect(big.asText == "Allow shell: " + huge && big.questions[0].options == ["Reject"] && big.permission?.notice.contains("Too long") == true)
        // An empty `resources` falls through to opencode's `patterns`.
        let fall = try #require(CampusForm.parsePermission(json(#"{"id":"per_f","action":"edit","resources":[],"patterns":["notes/b.md"]}"#)))
        #expect(fall.asText == "Allow edit: notes/b.md")
        // An ask that names no tool call (a file edit with its path) is read as before.
        let edit = try #require(CampusForm.parsePermission(json(#"{"id":"per_e","action":"edit","resources":["notes/a.md"]}"#)))
        #expect(edit.permission?.needsConfirmation == false && edit.questions[0].options == ["Allow once", "Reject"])
    }

    /// The messages of that thread (invented text, the live structure): the tool that waits on the permission is a `shell` part with `state.status: "running"`, `executed: false` and
    /// `state.input.command`; the one before it is `completed` with its output in `state.content[]`. Both show as tool steps with their input, the waiting one still running.
    @Test func theToolCallThatWaitsOnThePermissionShowsAsARunningStepWithItsCommand() throws {
        let data = Data(#"{"data":[{"id":"msg_2","type":"assistant","content":[{"type":"tool","id":"chatcmpl-tool-2","name":"shell","executed":false,"state":{"status":"running","input":{"command":"ls -la /workspace/demo; cat /workspace/demo/AGENTS.md | head -60"},"metadata":{}},"time":{"created":1000,"ran":1100}}]},{"id":"msg_1","type":"assistant","content":[{"type":"tool","id":"chatcmpl-tool-1","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"find /workspace/demo -maxdepth 2 | head -50"},"content":[{"type":"text","text":"/workspace/demo\n/workspace/demo/AGENTS.md\n"}],"metadata":{"status":"completed","exit":0}},"time":{"created":10,"ran":20,"completed":30}}],"finish":"tool-calls"}],"cursor":{}}"#.utf8)
        let tools = try #require(CampusTimeline.items(fromMessages: data)).filter { $0.kind == .tool }
        #expect(tools.count == 2 && tools.allSatisfy { $0.tool == "shell" })
        let waiting = try #require(tools.first { $0.toolStatus == .running })
        #expect(waiting.input.contains("cat /workspace/demo/AGENTS.md") && waiting.output.isEmpty)
        let done = try #require(tools.first { $0.toolStatus == .ok })
        #expect(done.input.hasPrefix("find /workspace/demo") && done.output.contains("/workspace/demo/AGENTS.md"))
    }

    @Test func aLongReasonIsCutButWhatIsGrantedIsNot() throws {
        let long = String(repeating: "word ", count: 200)
        let f = try #require(CampusForm.parsePermission(json(#"{"id":"per_r","action":"shell","resources":["ls"],"message":"\#(long)"}"#)))
        #expect(f.permission?.reasonShown.count == CampusPermission.reasonLimit + 1 && f.permission?.reasonShown.hasSuffix("…") == true && f.asText == "Allow shell: ls")
    }

    @Test func aMessagesPermissionPartIsOpenUntilItCarriesItsReply() throws {
        let data = Data(#"{"data":[{"type":"assistant","id":"m1","content":[{"type":"permission","id":"per_a","permission":"bash","patterns":["ls"]},{"type":"permission","id":"per_b","permission":"edit","patterns":["a.txt"],"reply":"once"},{"type":"permission","id":"per_c","permission":"edit","patterns":["b.txt"],"decision":"reject"}]}]}"#.utf8)
        let forms = try #require(CampusTimeline.items(fromMessages: data)).compactMap(\.form)
        #expect(forms.map(\.id) == ["per_a", "per_b", "per_c"])
        #expect(forms[0].status == .open && forms[1].status == .answered("Allow once") && forms[2].status == .answered("Reject"))
    }
}

@Suite("Campus permissions: the transcript") struct CampusPermissionTranscriptTests {
    private func loaded() -> CampusTimeline { var t = CampusTimeline(); t.backfill([], fetchedAt: .distantPast); return t }

    @Test func theAskStandsInTheTranscriptWhereTheAgentStoppedAndKeepsTheAnswer() throws {
        var t = loaded()
        t.apply(CampusFrame(type: "session.step.started"))
        t.apply(CampusFrame(type: "session.text.delta", data: json(#"{"delta":"I will fetch the page."}"#)))
        t.apply(CampusFrame(type: "permission.asked", data: json(#"{"id":"per_1","permission":"bash","patterns":["curl https://example.test"]}"#)))
        #expect(t.items.last?.kind == .form && t.openForm?.id == "per_1" && t.openForm?.isPermission == true)
        // The same frame twice is one ask.
        t.apply(CampusFrame(type: "permission.asked", data: json(#"{"id":"per_1","permission":"bash","patterns":["curl https://example.test"]}"#)))
        #expect(t.items.filter { $0.kind == .form }.count == 1)
        // The person's answer, then Campus's event for it: the person's words stay.
        t.answerForm("per_1", text: "Allow once")
        t.apply(CampusFrame(type: "permission.replied", data: json(#"{"permissionID":"per_1","reply":"once"}"#)))
        let form = try #require(t.items.last { $0.kind == .form }?.form)
        #expect(form.status == .answered("Allow once") && t.openForm == nil)
        #expect(t.plainText().contains("Campus asks: Allow bash: curl https://example.test"))
    }

    @Test func anAnswerGivenInCampusClosesItWithCampusesWordsOrAsAnsweredInCampus() throws {
        var t = loaded()
        t.apply(CampusFrame(type: "permission.asked", data: json(#"{"id":"per_1","permission":"bash","patterns":["ls"]}"#)))
        t.apply(CampusFrame(type: "permission.replied", data: json(#"{"permissionID":"per_1","reply":"reject"}"#)))
        #expect(t.items.last?.form?.status == .answered("Reject"))
        t.apply(CampusFrame(type: "permission.asked", data: json(#"{"id":"per_2","permission":"bash","patterns":["ls"]}"#)))
        t.apply(CampusFrame(type: "permission.resolved", data: json(#"{"id":"per_2"}"#)))
        #expect(t.items.last?.form?.status == .resolved)
    }

    @Test func anAskCampusNoLongerListsIsClosedAndComesBackIfCampusListsItAgain() throws {
        var t = loaded()
        let ask = try #require(CampusForm.parsePermission(json(#"{"id":"per_1","permission":"bash","patterns":["ls"]}"#)))
        let first = t.showRequest(ask)
        let again = t.showRequest(ask)                              // already there
        #expect(first && again == false)
        let closed = t.resolveOpenForms(except: "per_other")
        #expect(closed && t.items.last?.form?.status == .resolved)
        let reopened = t.showRequest(ask)                           // listed again: open again, still one item
        #expect(reopened && t.openForm?.id == "per_1" && t.items.filter { $0.kind == .form }.count == 1)
        // One the person answered stays answered.
        t.answerForm("per_1", text: "Reject")
        let stays = t.showRequest(ask)
        #expect(stays == false && t.items.last?.form?.status == .answered("Reject"))
        let nothing = t.resolveOpenForms()
        #expect(nothing == false)
    }

    @Test func thePageGetsOnlyAFinishedAskWithItsChoiceFilledInAndNeverAnOpenOne() throws {
        var t = loaded()
        t.apply(CampusFrame(type: "session.text.delta", data: json(#"{"delta":"Fetching."}"#)))
        t.apply(CampusFrame(type: "permission.asked", data: json(#"{"id":"per_1","permission":"bash","patterns":["curl https://example.test"]}"#)))
        func form(_ t: CampusTimeline) throws -> [String: Any]? {
            let root = try #require(JSONSerialization.jsonObject(with: Data(CampusEmbed.json(id: "ses_a", timeline: t, working: false).utf8)) as? [String: Any])
            let blocks = try #require(root["blocks"] as? [[String: Any]])
            return blocks.compactMap { $0["form"] as? [String: Any] }.first
        }
        #expect(try form(t) == nil)                                 // open: Conn's own card has the buttons
        t.answerForm("per_1", text: "Allow once")
        let done = try #require(try form(t))
        #expect(done["status"] as? String == "answered" && done["answer"] as? String == "Allow once")
        let q = try #require((done["questions"] as? [[String: Any]])?.first)
        #expect(q["text"] as? String == "Allow bash: curl https://example.test" && q["pick"] as? String == "Allow once" && q["options"] as? [String] == ["Allow once", "Reject"])
        var other = loaded()
        other.apply(CampusFrame(type: "permission.asked", data: json(#"{"id":"per_2","permission":"bash","patterns":["ls"]}"#)))
        other.resolveOpenForms()
        let r = try #require(try form(other))
        #expect(r["status"] as? String == "answered" && r["answer"] as? String == "in Campus")
    }
}

@Suite("Campus permissions: the feed and the answer, on the stand-in") @MainActor struct CampusPermissionFeedTests {
    @Test func theLiveShapeReachesTheRowTheTranscriptAndTheWriteGate() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", name: "shell", patterns: ["ls -la /tmp", "head -60"], command: "ls -la /tmp | head -60", announce: false)
        // The stand-in lists it like the live service did: `/form` has `{data: []}`, `/requests` and `/permission` have the permission, and the waiting tool call is in the messages.
        await s.refresh()
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) })
        let f = try #require(s.openForms["ses_fakeRates01"])
        #expect(f.asText == "Allow shell: ls -la /tmp | head -60" && f.permission?.reasonShown.contains("approves each change") == true && f.questions[0].options == ["Allow once", "Reject"])
        #expect(s.conversation("ses_fakeRates01")?.ask?.tag == "Permission · shell")
    }

    @Test func aToolCallThatCannotBeFoundLeavesOnlyRejectAndTheEventIsUpgradedOnceTheCommandIsRead() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", patterns: ["ls -la /tmp"], withTool: false, announce: false)
        await s.refresh()
        #expect(await until { s.openForms["ses_fakeRates01"]?.isPermission == true })
        #expect(s.openForms["ses_fakeRates01"]?.questions[0].options == ["Reject"] && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == true)
        // The same ask by event, with its call among the messages: shown with Reject only at once, then with the command it runs.
        world.askPermission("ses_fakeDigest02", patterns: ["ls"], command: "ls -la /home", permissionID: "per_ev1", announce: false)
        s.retain("ses_fakeDigest02")
        #expect(await until { s.timeline("ses_fakeDigest02")?.loaded == true })
        s.handle(CampusFrame(type: "permission.asked", sessionID: "ses_fakeDigest02", data: json(#"{"id":"per_ev1","sessionID":"ses_fakeDigest02","action":"shell","resources":["ls"],"source":{"type":"tool","messageID":"msg_ask_per_ev1","id":"chatcmpl-tool-per_ev1"}}"#)))
        #expect(await until { s.openForms["ses_fakeDigest02"]?.asText == "Allow shell: ls -la /home" && s.openForms["ses_fakeDigest02"]?.questions[0].options == ["Allow once", "Reject"] })
        #expect(s.timeline("ses_fakeDigest02")?.openForm?.asText == "Allow shell: ls -la /home" && s.timeline("ses_fakeDigest02")?.openForm?.questions[0].options == ["Allow once", "Reject"])
    }

    @Test func aThreadThatWaitsOnAPermissionNeedsYouWithTheAskOnItsRow() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        let c = try #require(s.conversation("ses_fakeRates01"))
        #expect(c.needsYou && c.state == .blocked)
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) })
        let ask = try #require(s.conversation("ses_fakeRates01")?.ask)
        #expect(ask.text == "Allow shell: curl https://example.test" && ask.tag == "Permission · shell")
        // It counts everywhere a question counts: the asks list (sidebar, AGENTS header, Cmd+J, the menu bar), and the row's state, which a Watch column's header shows.
        #expect(s.asks.map(\.id).contains("ses_fakeRates01") && s.asks.count == 2 && s.asks(inTeam: false) == 2)
        #expect(s.attentionOrder.prefix(2).allSatisfy { $0.state == .blocked })
    }

    @Test func theEventPutsItOnTheRowAndInTheShownTranscriptAtOnce() async throws {
        let (s, _, world) = await liveStore()
        s.retain("ses_fakeRates01")
        #expect(await until { s.timeline("ses_fakeRates01")?.loaded == true })
        s.handle(CampusFrame(type: "permission.asked", sessionID: "ses_fakeRates01", data: json(#"{"sessionID":"ses_fakeRates01","id":"per_ev","permission":"edit","patterns":["notes/week-46.md"]}"#)))
        let c = try #require(s.conversation("ses_fakeRates01"))
        #expect(c.needsYou && !c.working && c.ask?.tag == "Permission · edit" && s.openForms["ses_fakeRates01"]?.id == "per_ev")
        #expect(s.timeline("ses_fakeRates01")?.openForm?.id == "per_ev")
        _ = world
    }

    @Test func anAskOnlyTheListingKnowsIsAddedToTheTranscriptWhenItIsShown() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        s.retain("ses_fakeRates01")
        #expect(await until { (s.timeline("ses_fakeRates01")?.openForm?.isPermission == true && s.timeline("ses_fakeRates01")?.openForm?.permission?.needsConfirmation == false) })
        #expect(s.timeline("ses_fakeRates01")?.items.last?.kind == .form)
    }

    @Test func allowingOnceSendsTheDecisionAfterTheUndoWindowAndTheTranscriptKeepsTheAnswer() async throws {
        let (s, _, world) = await liveStore()
        s.writesEnabled = true
        s.retain("ses_fakeRates01")
        #expect(await until { s.timeline("ses_fakeRates01")?.loaded == true })
        s.start()
        #expect(await until { world.subscriberCount == 1 })
        world.askPermission("ses_fakeRates01", announce: true)
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) && s.timeline("ses_fakeRates01")?.openForm != nil })
        let form = try #require(s.openForms["ses_fakeRates01"])
        let c = try #require(s.conversation("ses_fakeRates01"))
        s.pick(form, question: 0, option: "Allow once")
        #expect(s.answer(form, in: c) == nil)
        #expect(s.held?.label == "Permission for Compare two cashback rate tables: Allow once")
        #expect(await until { world.writes().count == 1 })
        let w = world.writes()
        #expect(w[0].hasPrefix("POST /api/spaces/private/default/conversations/ses_fakeRates01/permission/\(form.id)/reply") && w[0].contains("\"decision\":\"once\"") && !w[0].contains("/form/"))
        #expect(await until { s.timeline("ses_fakeRates01")?.items.last(where: { $0.kind == .form })?.form?.status == .answered("Allow once") })
        #expect(s.openForms["ses_fakeRates01"] == nil)
        // The run goes on and ends, and the row no longer needs the person; the record stays in the transcript.
        #expect(await until { s.conversation("ses_fakeRates01")?.needsYou == false && s.conversation("ses_fakeRates01")?.working == false })
        #expect(s.timeline("ses_fakeRates01")?.items.contains { $0.form?.status == .answered("Allow once") } == true)
        s.stop()
    }

    @Test func aSecondAskAfterTheFirstWasAnsweredIsShownAndAnsweredToo() async throws {
        let (s, _, world) = await liveStore()
        s.writesEnabled = true
        world.stepDelay = 0.2
        s.retain("ses_fakeEmail05")
        #expect(await until { s.timeline("ses_fakeEmail05")?.loaded == true })
        s.start()
        #expect(await until { world.subscriberCount == 1 })
        world.askPermission("ses_fakeEmail05")
        #expect(await until { (s.openForms["ses_fakeEmail05"]?.isPermission == true && s.openForms["ses_fakeEmail05"]?.permission?.needsConfirmation == false) })
        var form = try #require(s.openForms["ses_fakeEmail05"])
        s.pick(form, question: 0, option: "Allow once")
        #expect(s.answer(form, in: try #require(s.conversation("ses_fakeEmail05"))) == nil)
        #expect(await until { s.conversation("ses_fakeEmail05")?.working == false && s.timeline("ses_fakeEmail05")?.items.last?.kind == .idle && world.conversation("ses_fakeEmail05")?.state == "idle" })
        let firstID = form.id
        #expect(await until { s.held == nil })
        world.askPermission("ses_fakeEmail05")
        #expect(await until { (s.openForms["ses_fakeEmail05"]?.isPermission == true && s.openForms["ses_fakeEmail05"]?.permission?.needsConfirmation == false) && s.openForms["ses_fakeEmail05"]?.id != firstID })
        #expect(s.conversation("ses_fakeEmail05")?.needsYou == true)
        form = try #require(s.openForms["ses_fakeEmail05"])
        s.pick(form, question: 0, option: "Reject")
        #expect(s.answer(form, in: try #require(s.conversation("ses_fakeEmail05"))) == nil)
        #expect(await until { world.writes().count == 2 })
        #expect(world.writes()[1].contains("\"decision\":\"reject\""))
        #expect(await until { s.timeline("ses_fakeEmail05")?.items.compactMap(\.form).map(\.status) == [.answered("Allow once"), .answered("Reject")] })
        s.stop()
    }

    @Test func rejectingSendsRejectAndEndsTheRun() async throws {
        let (s, _, world) = await liveStore()
        s.writesEnabled = true
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) })
        let form = try #require(s.openForms["ses_fakeRates01"])
        let c = try #require(s.conversation("ses_fakeRates01"))
        s.pick(form, question: 0, option: "Reject")
        #expect(s.answer(form, in: c) == nil)
        #expect(await until { world.writes().count == 1 })
        #expect(world.writes()[0].contains("\"decision\":\"reject\""))
        #expect(await until { world.conversation("ses_fakeRates01")?.state == "idle" && world.conversation("ses_fakeRates01")?.permissions.isEmpty == true })
    }

    @Test func withCampusWritesOffNothingIsSentAndTheAskStaysOpen() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) })
        let form = try #require(s.openForms["ses_fakeRates01"])
        let c = try #require(s.conversation("ses_fakeRates01"))
        s.pick(form, question: 0, option: "Allow once")
        #expect(s.answer(form, in: c) == .off)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(world.writes().isEmpty && s.openForms["ses_fakeRates01"] != nil && s.conversation("ses_fakeRates01")?.needsYou == true)
        #expect(world.conversation("ses_fakeRates01")?.permissions.count == 1)
    }

    @Test func aDecisionCampusRefusesLeavesTheAskOpenAndSaysWhy() async throws {
        let (s, _, world) = await liveStore()
        s.writesEnabled = true
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) })
        // A form whose button sends a value the stand-in does not know (what a wrong guess about Campus's values would look like).
        let perm = CampusPermission(name: "bash", patterns: ["curl https://example.test"], decisions: [.init(label: "Run it", value: "allow")])
        var form = try #require(s.openForms["ses_fakeRates01"])
        form.permission = perm; form.questions[0].options = ["Run it"]
        s.openForms["ses_fakeRates01"] = form
        let c = try #require(s.conversation("ses_fakeRates01"))
        s.pick(form, question: 0, option: "Run it")
        #expect(s.answer(form, in: c) == nil)
        #expect(await until { if case .failed? = s.held?.phase { return true }; return false })
        if case .failed(let why)? = s.held?.phase { #expect(why == "Campus answered 400") }
        #expect(world.conversation("ses_fakeRates01")?.permissions.count == 1 && s.conversation("ses_fakeRates01")?.needsYou == true)
    }

    @Test func aChoiceThatIsNotOneOfTheOptionsIsNotSent() async throws {
        let (s, _, world) = await liveStore()
        s.writesEnabled = true
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        #expect(await until { (s.openForms["ses_fakeRates01"]?.isPermission == true && s.openForms["ses_fakeRates01"]?.permission?.needsConfirmation == false) })
        let form = try #require(s.openForms["ses_fakeRates01"])
        let c = try #require(s.conversation("ses_fakeRates01"))
        s.pick(form, question: 0, option: "Always allow")
        #expect(s.answer(form, in: c) == .invalid)
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(world.writes().isEmpty)
    }

    @Test func anAskAnsweredInCampusesOwnPageEndsInTheTranscriptAsAnsweredInCampus() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        s.retain("ses_fakeRates01")
        #expect(await until { (s.timeline("ses_fakeRates01")?.openForm?.isPermission == true && s.timeline("ses_fakeRates01")?.openForm?.permission?.needsConfirmation == false) })
        // Answered elsewhere: Campus no longer lists it and says the thread is working again; no event reached Conn.
        s.applyStatus("ses_fakeRates01", CampusStatus(run: .busy))
        let item = try #require(s.timeline("ses_fakeRates01")?.items.last { $0.kind == .form })
        #expect(item.form?.status == .resolved && s.timeline("ses_fakeRates01")?.openForm == nil && s.openForms["ses_fakeRates01"] == nil)
    }

    @Test func aListReadThatSaysNothingWaitsAnyMoreClosesTheAskInTheTranscript() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", announce: false)
        await s.refresh()
        s.retain("ses_fakeRates01")
        #expect(await until { (s.timeline("ses_fakeRates01")?.openForm?.isPermission == true && s.timeline("ses_fakeRates01")?.openForm?.permission?.needsConfirmation == false) })
        // Answered in Campus's own page with no event for it: the next list read is what tells Conn.
        world.answerPermissionElsewhere("ses_fakeRates01", announce: false)
        world.release("ses_fakeRates01")
        await s.refresh()
        #expect(s.openForms["ses_fakeRates01"] == nil && s.timeline("ses_fakeRates01")?.openForm == nil)
        #expect(s.timeline("ses_fakeRates01")?.items.last(where: { $0.kind == .form })?.form?.status == .resolved)
    }

    @Test func readingAndShowingAnAskSendsNothing() async throws {
        let (s, _, world) = await liveStore()
        world.askPermission("ses_fakeRates01", announce: true)
        await s.refresh()
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(world.writes().isEmpty)         // reading and showing it sent nothing
    }
}
