// Claude's permission prompt, recognised from the text of the pane.
//
// Herdr reads each pane's screen and decides `idle`, `working` or `blocked` (its detection manifest for Claude). A worker that sat at
// Claude's WebFetch prompt ("Do you want to allow Claude to fetch this content? 1. Yes / 2. Yes, and don't ask again for ... / 3. No")
// for minutes showed nothing in Conn: Herdr's rule for that prompt is its lowest-priority one (`legacy_no_prompt_blocker`, 300), and
// the rules that say `working` or `idle` outrank it, so Herdr kept the state it had. Conn shows what Herdr reports, so it showed no
// need either. This is Conn's own narrow check of the same screen: the question line, then the numbered answers, at the bottom of the
// pane, and nothing like an input box under them (an answered prompt is redrawn away, an empty input box comes back).
//
// Narrow on purpose: a false positive tells the captain an agent needs them when it does not. Pure, so it is tested on strings.
import Foundation

public enum ClaudePermissionPrompt {
    /// Only the bottom of the screen counts: an earlier prompt that scrolled up, or text quoting one, is not a prompt waiting now.
    static let bottomLines = 14
    /// The answers follow the question closely: "1. Yes", "2. Yes, and don't ask again for ...", "3. No, ..." (never more than a handful).
    static let answerWindow = 7

    /// A line without the box Claude draws around the prompt and without the cursor mark on the chosen answer.
    static func bare(_ line: String) -> String {
        var s = Substring(line)
        let frame: Set<Character> = ["│", "┃", "║", "╭", "╮", "╰", "╯", "─", "━", " ", "\t"]
        while let f = s.first, frame.contains(f) { s.removeFirst() }
        while let l = s.last, frame.contains(l) { s.removeLast() }
        return String(s)
    }

    private static func matches(_ pattern: String, _ s: String) -> Bool { s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }

    /// True when the screen shows a Claude permission prompt waiting for an answer.
    public static func isShowing(in screen: String) -> Bool {
        let lines = screen.split(separator: "\n", omittingEmptySubsequences: false).map { bare(String($0)) }.filter { !$0.isEmpty }
        let bottom = Array(lines.suffix(bottomLines))
        // The last question line: "Do you want to ...?" (allow Claude to fetch this content, proceed, make this edit, create ...).
        guard let q = bottom.lastIndex(where: { matches("^do you want to .{2,200}\\?$", $0) }) else { return false }
        let after = Array(bottom[(q + 1)...])
        // The numbered answers, in order, starting at 1 and starting with Yes; a No among them.
        let answers = after.prefix(answerWindow)
        var yes = false, no = false
        var lastAnswer = -1
        for (i, line) in answers.enumerated() {
            let l = line.hasPrefix("❯") ? bare(String(line.dropFirst())) : (line.hasPrefix(">") ? bare(String(line.dropFirst())) : line)
            if matches("^1\\.\\s*yes\\b", l) { yes = true; lastAnswer = i }
            else if matches("^[23]\\.\\s*yes\\b", l) { lastAnswer = i }
            else if matches("^[23]\\.\\s*no\\b", l) { no = true; lastAnswer = i }
        }
        guard yes, no else { return false }
        // Below the answers there may be a hint line ("Esc to cancel", "Tab to amend") but not the input box that comes back after an
        // answer ("❯" or ">" alone) and not more conversation.
        let rest = after.dropFirst(lastAnswer + 1)
        for line in rest {
            if matches("^[❯>]$", line) { return false }
            if !matches("^(esc|tab|ctrl|enter|shift|↑|↓|\\?|press)\\b|·|to (cancel|amend|explain|navigate|select|confirm)", line) { return false }
        }
        return true
    }
}

extension Snapshot {
    /// This snapshot with the given panes shown as needing the captain: only agents Herdr reports as working or idle change (a pane Herdr
    /// already says is blocked, done or unknown is left as it is), with the tab and space states rolled up the way Herdr does.
    public func showingPermissionPrompts(on panes: Set<String>) -> Snapshot {
        if panes.isEmpty { return self }
        var s = self
        for id in panes {
            guard let a = s.agent(id), a.state == .working || a.state == .idle else { continue }
            s.setState(id, to: .blocked)
        }
        return s
    }
}
