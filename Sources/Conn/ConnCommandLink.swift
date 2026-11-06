// File > Install 'conn' Command in PATH: a link in ~/.local/bin to the script inside this app, so `conn .` opens a folder in the
// Editor view (README "Opening a folder from the terminal"). The decisions are ConnCore.CommandInstall; this file only gathers
// the places and words the menu shows. No sudo, no installer, no shell file is ever edited.
import SwiftUI
import AppKit
import ConnCore

struct ConnCommandOutcome: Equatable {
    var title: String
    var message: String
    var failed = false
}

enum ConnCommandLink {
    /// The script inside the running app (nil when Conn runs outside a bundle, for example straight from .build).
    static var script: URL? {
        guard let u = Bundle.main.resourceURL?.appendingPathComponent("bin/conn"), FileManager.default.isExecutableFile(atPath: u.path) else { return nil }
        return u
    }
    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    static func link(home: URL) -> URL { home.appendingPathComponent(".local/bin/\(CommandInstall.commandName)") }

    static func currentState() -> CommandInstall.State {
        guard let s = script else { return .notInstalled }
        return CommandInstall.state(link: link(home: home), script: s)
    }
}

extension AppModel {
    /// The menu item's words: "Install", or "Reinstall" when a link is there already.
    var connCommandInstallTitle: String {
        switch connCommand {
        case .installed, .stale: return "Reinstall 'conn' Command in PATH…"
        default: return "Install 'conn' Command in PATH…"
        }
    }
    var connCommandRemovable: Bool {
        switch connCommand { case .installed, .stale: return true; default: return false }
    }

    func installConnCommand(script: URL? = ConnCommandLink.script, home: URL = ConnCommandLink.home, environmentPath: String? = ProcessInfo.processInfo.environment["PATH"]) -> ConnCommandOutcome {
        guard let script = script else {
            return ConnCommandOutcome(title: "The 'conn' command is part of the built app", message: "This copy of Conn is not running from an app bundle, so there is no script to link. Build the app with ./build.sh and run it from build/Conn.app.", failed: true)
        }
        let link = ConnCommandLink.link(home: home)
        do { try CommandInstall.install(link: link, script: script) } catch {
            connCommand = CommandInstall.state(link: link, script: script)
            return ConnCommandOutcome(title: "Conn left \(Self.tilde(link, home)) alone", message: "\(error)", failed: true)
        }
        connCommand = CommandInstall.state(link: link, script: script)
        var msg = "\(Self.tilde(link, home)) now opens folders and files in Conn.\n\nIn a terminal: conn .    (or: conn some/folder file.md)"
        if !CommandInstall.likelyOnPath(directory: link.deletingLastPathComponent(), environmentPath: environmentPath, home: home) {
            msg += "\n\n~/.local/bin does not look like it is on your PATH yet. Add this line to ~/.zshrc, then open a new terminal:\n\nexport PATH=\"$HOME/.local/bin:$PATH\"\n\nConn does not edit your shell files."
        }
        return ConnCommandOutcome(title: "Installed the 'conn' command", message: msg)
    }

    func uninstallConnCommand(script: URL? = ConnCommandLink.script, home: URL = ConnCommandLink.home) -> ConnCommandOutcome {
        let link = ConnCommandLink.link(home: home)
        let script = script ?? URL(fileURLWithPath: "/nonexistent\(CommandInstall.scriptSuffix)")
        do {
            let removed = try CommandInstall.uninstall(link: link, script: script)
            connCommand = CommandInstall.state(link: link, script: script)
            return removed ? ConnCommandOutcome(title: "Removed the 'conn' command", message: "\(Self.tilde(link, home)) is gone. The script inside Conn.app is untouched.")
                           : ConnCommandOutcome(title: "Nothing to remove", message: "\(Self.tilde(link, home)) is not there.")
        } catch {
            return ConnCommandOutcome(title: "Conn left \(Self.tilde(link, home)) alone", message: "\(error)", failed: true)
        }
    }

    private static func tilde(_ url: URL, _ home: URL) -> String {
        url.path.hasPrefix(home.path + "/") ? "~" + url.path.dropFirst(home.path.count) : url.path
    }

    /// Shows an outcome in a sheet-less alert. Never called in test mode: a modal alert would stop a check.
    func showConnCommandAlert(_ o: ConnCommandOutcome) {
        let a = NSAlert()
        a.messageText = o.title
        a.informativeText = o.message
        a.alertStyle = o.failed ? .warning : .informational
        a.addButton(withTitle: "OK")
        a.runModal()
    }
}
