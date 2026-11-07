// Which reader conversation an agent row stands for.
//
// Herdr names a conversation for a pane only after an integration has reported one (`agent_session`; the field is omitted until
// then), so a pane that was started a moment ago has none. The reader column must then say so. It must never stay on the
// conversation of the agent chosen before, which reads as that agent's transcript.
import Foundation

public enum ReaderTarget {
    /// The session the reader opens for an agent: the one Herdr names, else the one its open ask names (the reader's own id for the
    /// pane's conversation). nil when neither names one the reader would follow: the agent has no transcript yet.
    public static func session(herdr: String?, ask: String?) -> String? {
        for candidate in [herdr, ask] {
            if let s = candidate, OpenAsk.validSession(s) { return s }
        }
        return nil
    }
}
