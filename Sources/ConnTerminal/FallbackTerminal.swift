// The fallback pane: Herdr's own screen in a terminal view.
//
// This runs a real Herdr client (`herdr session attach <session>`) in a pty, so it works whatever the stream protocol
// is, and it is interactive: keys typed here go to Herdr, and as a second attached client it takes part in Herdr's
// own sizing. For both reasons it never starts by itself. The app shows what it will do and the user starts it.
import AppKit
import SwiftTerm
import ConnCore

@MainActor
public final class FallbackTerminalController: NSObject, LocalProcessTerminalViewDelegate {
    public let view: LocalProcessTerminalView
    public private(set) var running = false
    public private(set) var exitCode: Int32?
    public var onStateChange: (() -> Void)?

    public override init() {
        view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        super.init()
        view.processDelegate = self
        view.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    }

    /// The only command this pane ever runs.
    public static func command(for endpoint: HerdrEndpoint) -> (executable: String, args: [String])? {
        guard HerdrEndpoint.validSession(endpoint.session), let bin = endpoint.binaryPath, !bin.isEmpty else { return nil }
        return (bin, ["session", "attach", endpoint.session])
    }

    public func start(endpoint: HerdrEndpoint, theme: TerminalTheme) {
        guard !running, let cmd = Self.command(for: endpoint) else { return }
        view.installColors(theme.swiftTermPalette)
        view.nativeBackgroundColor = theme.bg
        view.nativeForegroundColor = theme.fg
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["CONN_HERDR_SOCKET_DIR"] = endpoint.socketDirectory
        env.removeValue(forKey: "HERDR_SESSION")   // the explicit session argument is the only selector
        exitCode = nil
        running = true
        view.startProcess(executable: cmd.executable, args: cmd.args, environment: env.map { "\($0.key)=\($0.value)" })
        onStateChange?()
    }

    public func stop() {
        if running { view.terminate() }
    }

    nonisolated public func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    nonisolated public func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    nonisolated public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated public func processTerminated(source: TerminalView, exitCode: Int32?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.running = false
            self.exitCode = exitCode
            self.onStateChange?()
        }
    }
}
