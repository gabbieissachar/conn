// Watch focus (README "Watch view", "Hiding a column"): what the column model needs from the app to tell that a hidden session's turn has ended.
// The rule itself is `WatchAttention` (ConnCore); what is kept is `WatchModel.attention`.
import SwiftUI
import ConnCore

extension AppModel {
    /// A session's state as Conn already shows it: the agent's (Herdr's, with a permission prompt Herdr did not call blocked shown as needing you) for a reader session,
    /// the conversation's for a Campus one while the link is live. Nil when there is none to go by: such a column never raises a cue.
    func wireWatchFocus() {
        watch.stateOf = { [weak self] session in
            guard let self = self else { return nil }
            if let id = CampusColumn.id(of: session) {
                guard self.campus.link == .live, let c = self.campus.conversation(id) else { return nil }
                return c.state
            }
            return self.agent(forSession: session)?.state
        }
        // Campus changes are looked at after they land (the store publishes before it stores the new value).
        campus.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.watch.observeStates() } }.store(in: &cancellables)
    }
}
