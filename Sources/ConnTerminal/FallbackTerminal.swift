// The Herdr client pane: Herdr's own screen in a terminal view.
//
// This runs a real Herdr client (`herdr session attach <session>`) in a pty, so it works whatever the stream protocol
// is, and it is interactive: keys typed here go to Herdr, and as a second attached client it takes part in Herdr's
// own sizing. For both reasons it never starts by itself. The app shows what it will do and the user starts it.
//
// Keys and mouse events typed into this pty steer only this client (its own workspace and tab), but Herdr's socket API
// focus commands (`workspace focus`, `tab focus`, `pane focus`) move every attached client. Nothing here calls them.
//
// Conn's sidebar moves this client the same way: by typing Herdr's own keys into this pty (see HerdrClientNavigation), which
// moves only this client. `lastUserInput` records when the person last typed or clicked in the client (not the keys Conn
// types for them), so the app can tell a switch they made inside the client from one made on another screen.
//
// The client may start with its own config file (`HERDR_CONFIG_PATH`, see HerdrClientConfig) so it can draw without
// Herdr's sidebar. Herdr reads that file only when the client starts; this code never asks a running server to reload.
import AppKit
import SwiftTerm
import ConnCore

@MainActor
public final class FallbackTerminalController: NSObject, LocalProcessTerminalViewDelegate {
    public let view: LocalProcessTerminalView
    public private(set) var running = false
    /// When the person last typed or clicked in the client.
    public private(set) var lastUserInput: Date?
    private var inputMonitor: Any?
    public private(set) var exitCode: Int32?
    /// The client config the running (or last) client was started with; nil when it read Herdr's own config.
    public private(set) var clientConfig: URL?
    public var onStateChange: (() -> Void)?

    public override init() {
        view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        super.init()
        // A key typed while the client's view has the keyboard, or a click on it, is the person using the client. Keys that
        // `sendNavigation` types go straight to the pty and never pass here.
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .leftMouseUp]) { [weak self] event in
            MainActor.assumeIsolated { self?.noteUserEvent(event) }
            return event
        }
        view.processDelegate = self
        view.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    }

    /// The only command this pane ever runs.
    public static func command(for endpoint: HerdrEndpoint) -> (executable: String, args: [String])? {
        guard HerdrEndpoint.validSession(endpoint.session), let bin = endpoint.binaryPath, !bin.isEmpty else { return nil }
        return (bin, ["session", "attach", endpoint.session])
    }

    /// The environment the client runs in: the app's own, with the terminal type set, the session selector removed (the
    /// explicit argument is the only one) and, when `clientConfig` is a checked path, Herdr pointed at that config file.
    static let paneContextKeys = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"]

    public static func environment(base: [String: String], endpoint: HerdrEndpoint, clientConfig: URL?) -> [String: String] {
        var env = base
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["CONN_HERDR_SOCKET_DIR"] = endpoint.socketDirectory
        env.removeValue(forKey: "HERDR_SESSION")   // the explicit session argument is the only selector
        // An app started from inside a Herdr pane inherits that pane's markers, and Herdr then refuses to run ("nested herdr is
        // disabled by default") and would aim at that pane's socket. The client is a top-level client of the named session.
        for key in paneContextKeys { env.removeValue(forKey: key) }
        if let clientConfig = clientConfig { env["HERDR_CONFIG_PATH"] = clientConfig.path }
        return env
    }

    /// `clientConfig` must already have passed `HerdrClientConfig.validate` (the app gets it from `HerdrClientConfig.resolve`).
    public func start(endpoint: HerdrEndpoint, theme: TerminalTheme, clientConfig: URL? = nil) {
        guard !running, let cmd = Self.command(for: endpoint) else { return }
        view.installColors(theme.swiftTermPalette)
        view.nativeBackgroundColor = theme.bg
        view.nativeForegroundColor = theme.fg
        let env = Self.environment(base: ProcessInfo.processInfo.environment, endpoint: endpoint, clientConfig: clientConfig)
        exitCode = nil
        self.clientConfig = clientConfig
        running = true
        view.startProcess(executable: cmd.executable, args: cmd.args, environment: env.map { "\($0.key)=\($0.value)" })
        onStateChange?()
    }

    public func stop() {
        if running { view.terminate() }
    }

    /// Type bytes into the running client, as if the person had typed them. Returns false (typing nothing) when it is not running.
    @discardableResult
    public func sendNavigation(_ bytes: [UInt8]) -> Bool {
        guard running else { return false }
        view.send(bytes)
        return true
    }

    private func noteUserEvent(_ event: NSEvent) {
        guard let window = view.window, event.window === window else { return }
        if event.type == .keyDown {
            guard window.firstResponder === view else { return }
        } else {
            guard let hit = window.contentView?.hitTest(event.locationInWindow), hit === view || hit.isDescendant(of: view) else { return }
        }
        lastUserInput = Date()
    }

    deinit { if let m = inputMonitor { NSEvent.removeMonitor(m) } }

    /// True when the person typed or clicked in the client within the last `seconds`.
    public func hadUserInput(within seconds: TimeInterval) -> Bool {
        lastUserInput.map { Date().timeIntervalSince($0) <= seconds } ?? false
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
