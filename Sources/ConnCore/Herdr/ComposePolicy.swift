// What the compose box may send. `pane.send_input` types the text and presses Enter; an embedded newline could be taken as
// an Enter too, so a two-line message might reach the agent as two submissions. Until a lab session shows what Herdr does
// with a newline, multi-line text is refused with a clear message (reviewer F15).
import Foundation

public enum ComposePolicy {
    public static let multiLineMessage = "Multi-line messages are not sent yet: Herdr may submit each line on its own. Put it on one line."

    /// Nil if the text may be sent; otherwise why not.
    public static func problem(for text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "Nothing to send." }
        if t.unicodeScalars.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\u{2028}" || $0 == "\u{2029}" || $0 == "\u{0085}" }) { return multiLineMessage }
        return nil
    }
}
