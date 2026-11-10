// Which WebKit website data store Campus's web views live in, and how Conn swaps it for a new one (README "Campus needs the company private network").
//
// Why a swap: WebKit keeps one connection pool per website data store and reuses a pooled connection for every page and every `fetch` of every web view on that store.
// When the network refuses Campus (off Zscaler, a public ingress answers every path with nginx's 403 page) and then comes back, a connection that was open while it
// refused keeps answering the refusal for as long as it lives, and Conn's polling and event stream keep it alive. Reloading, a new web view and clearing the caches all
// reuse it (measured; `data/conn-fix-queue/try-again/` in the firstmate home); only a different data store dials a new connection. Quitting Conn did the same by dropping
// every store, which is why that was the one thing that worked.
//
// So "Try again" (and, while the network keeps refusing, a drop by itself every 20 seconds) replaces the store: a new one, the session's cookies carried over as opaque
// objects (no value is read, printed, logged or stored here), the web views rebuilt on it, the old store forgotten. A person's launch keeps its stores in WebKit's own
// storage: the first launch uses WebKit's default store, as before, and the first swap moves Campus to a store with an identifier that Conn remembers; a later swap
// replaces that one and removes the old. A scripted launch swaps scratch stores that never touch a person's own sign-in.
import Foundation
import WebKit
import ConnCore

@MainActor
final class CampusWebStores {
    private let persistent: Bool
    private let defaults: UserDefaults
    private let idKey: String
    private let leftoverKey: String
    private(set) var current: WKWebsiteDataStore
    private var currentID: UUID?
    /// How many times the store was replaced in this run.
    private(set) var swaps = 0

    /// `legacy` is the store a person's launch uses until the first swap (WebKit's default store); a check hands it a store of its own.
    init(persistent: Bool, defaults: UserDefaults, key: String = "conn.campusStore", legacy: @MainActor () -> WKWebsiteDataStore = { .default() }) {
        self.persistent = persistent
        self.defaults = defaults
        idKey = key + ".id"
        leftoverKey = key + ".leftovers"
        if persistent, let text = defaults.string(forKey: idKey), let id = UUID(uuidString: text) {
            current = WKWebsiteDataStore(forIdentifier: id)
            currentID = id
        } else {
            current = persistent ? legacy() : .nonPersistent()
        }
        if persistent { sweepLeftovers() }
    }

    /// A new store that has the session, made but not yet the current one: `install` makes it so (with no waiting in between, so the caller can decide at the last moment),
    /// `discard` gives it up.
    struct Prepared { let store: WKWebsiteDataStore; let id: UUID?; let defaultCookies: [HTTPCookie] }

    func prepare(campusHost: String) async -> Prepared {
        let oldID = currentID
        let cookies = await current.httpCookieStore.allCookies()
        let new: WKWebsiteDataStore
        var newID: UUID?
        if persistent { let id = UUID(); new = WKWebsiteDataStore(forIdentifier: id); newID = id } else { new = .nonPersistent() }
        // The default store also holds what other web views of Conn keep; only what belongs to Campus's sign-in is carried over. A store of Campus's own is carried over whole.
        let ownsWholeStore = !persistent || oldID != nil
        let moving = ownsWholeStore ? cookies : cookies.filter { CampusCookieScope.carriesSignIn(domain: $0.domain, campusHost: campusHost) }
        for c in moving { await new.httpCookieStore.setCookie(c) }
        // Campus's own host's cookies in the default store are no longer used there once Campus has moved: they are taken out, and Google's and any parent domain's stay
        // (the default store also serves other pages).
        let stale = persistent && oldID == nil ? cookies.filter { CampusCookieScope.isExactly(domain: $0.domain, campusHost: campusHost) } : []
        return Prepared(store: new, id: newID, defaultCookies: stale)
    }

    /// Make the prepared store the current one. Returns what is left of the store that was replaced, for `forget`.
    func install(_ p: Prepared) -> Retired {
        let oldID = currentID
        // An identified store is removed by its identifier, so nothing here may still hold it (WebKit does not remove a store that is in use); the default store is kept to take cookies out of.
        let held: WKWebsiteDataStore? = oldID == nil ? current : nil
        current = p.store; currentID = p.id
        if let id = p.id { defaults.set(id.uuidString, forKey: idKey) }
        swaps += 1
        return Retired(store: held, id: oldID, defaultCookies: p.defaultCookies)
    }

    /// The prepared store is not used after all.
    func discard(_ p: Prepared) async { if let id = p.id { await remove(id) } }

    struct Retired { let store: WKWebsiteDataStore?; let id: UUID?; let defaultCookies: [HTTPCookie] }

    /// The web views that used the replaced store are gone: remove what it kept. A store that is still in use, or a removal that fails, is tried again at the next launch.
    func forget(_ r: Retired) async {
        if let store = r.store { for c in r.defaultCookies { await store.httpCookieStore.deleteCookie(c) } }
        if let id = r.id { await remove(id) }
    }

    /// Remove an identified store from disk. A store that is still in use, or a removal that fails, stays on a list and is tried again at the next launch.
    private func remove(_ id: UUID) async {
        var left = defaults.stringArray(forKey: leftoverKey) ?? []
        left.append(id.uuidString)
        defaults.set(left, forKey: leftoverKey)
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if (try? await WKWebsiteDataStore.remove(forIdentifier: id)) != nil {
            defaults.set((defaults.stringArray(forKey: leftoverKey) ?? []).filter { $0 != id.uuidString }, forKey: leftoverKey)
        }
    }

    private func sweepLeftovers() {
        let left = defaults.stringArray(forKey: leftoverKey) ?? []
        guard !left.isEmpty else { return }
        Task { @MainActor in
            var kept: [String] = []
            for text in left {
                guard let id = UUID(uuidString: text), id != currentID else { continue }
                if (try? await WKWebsiteDataStore.remove(forIdentifier: id)) == nil { kept.append(text) }
            }
            defaults.set(kept, forKey: leftoverKey)
        }
    }
}
