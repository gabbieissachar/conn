import Testing
import Foundation
import ConnCore

@Suite("Claude permission prompt on the pane") struct PermissionPromptTests {
    private let webFetch = """
    ● Fetching the how-to page now.

    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ Fetch                                                                        │
    │                                                                              │
    │   https://example.invalid/guides/whatsapp                                    │
    │   Claude wants to fetch content from example.invalid                         │
    │                                                                              │
    │ Do you want to allow Claude to fetch this content?                           │
    │ ❯ 1. Yes                                                                     │
    │   2. Yes, and don't ask again for example.invalid                            │
    │   3. No, and tell Claude what to do differently (esc)                        │
    ╰──────────────────────────────────────────────────────────────────────────────╯
    """

    @Test func theWebFetchPromptIsRecognised() {
        #expect(ClaudePermissionPrompt.isShowing(in: webFetch))
    }

    @Test func theSamePromptWithoutItsBoxOrWithAnotherAnswerChosenIsRecognised() {
        let plain = """
        Do you want to allow Claude to fetch this content?
        ❯ 1. Yes
          2. Yes, and don't ask again for example.invalid
          3. No
        """
        #expect(ClaudePermissionPrompt.isShowing(in: plain))
        #expect(ClaudePermissionPrompt.isShowing(in: plain.replacingOccurrences(of: "❯ 1. Yes", with: "  1. Yes").replacingOccurrences(of: "  3. No", with: "❯ 3. No")))
    }

    @Test func otherClaudePermissionPromptsHaveTheSameShape() {
        #expect(ClaudePermissionPrompt.isShowing(in: """
        │ Bash command
        │   git status
        │ Do you want to proceed?
        │ ❯ 1. Yes
        │   2. Yes, and don't ask again for git status commands in /tmp
        │   3. No, and tell Claude what to do differently (esc)
        """))
        #expect(ClaudePermissionPrompt.isShowing(in: """
        Edit file
        Do you want to make this edit to Sources/App.swift?
        ❯ 1. Yes
          2. Yes, allow all edits during this session (shift+tab)
          3. No, and tell Claude what to do differently (esc)
        Esc to cancel · Tab to amend
        """))
        #expect(ClaudePermissionPrompt.isShowing(in: """
        Do you want to proceed?
        ❯ 1. Yes
          2. No
        """))
    }

    @Test func anAnsweredPromptIsNotOne() {
        // The prompt box is redrawn away and the input box comes back: a stale question above it is not waiting.
        let answered = webFetch + """


        ● Fetched. The page lists three steps.

        ╭──────────────────────────────────────────────────────────────────────────────╮
        │ >                                                                            │
        ╰──────────────────────────────────────────────────────────────────────────────╯
          ? for shortcuts
        """
        #expect(!ClaudePermissionPrompt.isShowing(in: answered))
        // The input box straight under the answers (before Claude has redrawn anything else) is not a prompt either.
        #expect(!ClaudePermissionPrompt.isShowing(in: """
        Do you want to allow Claude to fetch this content?
        1. Yes
        3. No
        ╭────────────╮
        │ ❯          │
        ╰────────────╯
        """))
    }

    @Test func aPromptThatScrolledUpOrIsQuotedInTheConversationIsNotOne() {
        let filler = (1...20).map { "● working line \($0)" }.joined(separator: "\n")
        #expect(!ClaudePermissionPrompt.isShowing(in: webFetch + "\n" + filler))
        #expect(!ClaudePermissionPrompt.isShowing(in: """
        ● You asked what the prompt says. It reads:
          Do you want to allow Claude to fetch this content?
          1. Yes
          3. No
        ● That is all it says. Anything else?
        """))
    }

    @Test func otherQuestionsAreNotPermissionPrompts() {
        #expect(!ClaudePermissionPrompt.isShowing(in: "● Do you want to proceed with option 1?\n  Say yes and I will."))
        #expect(!ClaudePermissionPrompt.isShowing(in: "Do you want to allow Claude to fetch this content?"))                    // no answers yet
        #expect(!ClaudePermissionPrompt.isShowing(in: "Do you want to continue?\n1. Maybe\n2. Later"))                         // no Yes / No
        #expect(!ClaudePermissionPrompt.isShowing(in: "Would you like to continue?\n❯ 1. Yes\n  2. No"))                       // not Claude's "Do you want to" shape
        #expect(!ClaudePermissionPrompt.isShowing(in: ""))
    }

    @Test func aPaneShownAsBlockedChangesOnlyAWorkingOrIdleAgent() {
        let working = Agent(id: "w1:p1", name: "a", harness: "claude", state: .working, workspaceID: "w1", tabID: "w1:t1", sessionID: nil, cwd: "")
        let idle = Agent(id: "w1:p2", name: "b", harness: "claude", state: .idle, workspaceID: "w1", tabID: "w1:t2", sessionID: nil, cwd: "")
        let done = Agent(id: "w1:p3", name: "c", harness: "claude", state: .done, workspaceID: "w1", tabID: "w1:t3", sessionID: nil, cwd: "")
        var snap = Snapshot()
        snap.agents = [working, idle, done]
        let shown = snap.showingPermissionPrompts(on: ["w1:p1", "w1:p2", "w1:p3", "gone"])
        #expect(shown.agent("w1:p1")?.state == .blocked && shown.agent("w1:p2")?.state == .blocked)
        #expect(shown.agent("w1:p3")?.state == .done)               // Herdr's own state stands
        #expect(snap.showingPermissionPrompts(on: []) == snap)
        #expect(snap.agent("w1:p1")?.state == .working)             // the original is untouched
    }
}
