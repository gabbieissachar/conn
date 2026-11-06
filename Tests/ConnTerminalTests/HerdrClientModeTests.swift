import Testing
import Foundation
import ConnCore
@testable import ConnTerminal

/// How the Herdr client mode launches its client: the command, the environment, and which config file it points at.
@Suite("Herdr client mode launch") @MainActor struct HerdrClientModeTests {
    let endpoint = HerdrEndpoint(session: "demo", socketDirectory: "/tmp/conn-sockets", binaryPath: "/bin/echo")
    let base = ["PATH": "/usr/bin", "HERDR_SESSION": "default", "HOME": "/Users/someone"]

    @Test func theCommandIsAlwaysAnAttachToTheNamedSession() {
        let cmd = FallbackTerminalController.command(for: endpoint)
        #expect(cmd?.executable == "/bin/echo")
        #expect(cmd?.args == ["session", "attach", "demo"])
        // A session name that could be read as a path or as more than one argument never launches anything.
        for bad in ["", "a b", "../x", "x/y", "a;b"] {
            #expect(FallbackTerminalController.command(for: HerdrEndpoint(session: bad, socketDirectory: "/tmp", binaryPath: "/bin/echo")) == nil)
        }
        #expect(FallbackTerminalController.command(for: HerdrEndpoint(session: "demo", socketDirectory: "/tmp", binaryPath: "")) == nil)
    }

    @Test func aClientConfigPointsHerdrAtThatFileOnlyForThisClient() {
        let url = URL(fileURLWithPath: "/tmp/conn-client/hidden-sidebar.toml")
        let env = FallbackTerminalController.environment(base: base, endpoint: endpoint, clientConfig: url)
        #expect(env["HERDR_CONFIG_PATH"] == "/tmp/conn-client/hidden-sidebar.toml")
        #expect(env["HERDR_SESSION"] == nil)                       // the explicit session argument is the only selector
        #expect(env["TERM"] == "xterm-256color" && env["COLORTERM"] == "truecolor")
        #expect(env["CONN_HERDR_SOCKET_DIR"] == "/tmp/conn-sockets")
        #expect(env["PATH"] == "/usr/bin" && env["HOME"] == "/Users/someone")
        // The app's own environment is untouched: the next client, or a tool the app starts, does not inherit the path.
        #expect(base["HERDR_CONFIG_PATH"] == nil)
    }

    @Test func withoutAClientConfigTheClientKeepsWhateverConfigPathTheAppWasStartedWith() {
        let plain = FallbackTerminalController.environment(base: base, endpoint: endpoint, clientConfig: nil)
        #expect(plain["HERDR_CONFIG_PATH"] == nil)
        let inherited = FallbackTerminalController.environment(base: base.merging(["HERDR_CONFIG_PATH": "/x/y.toml"]) { $1 }, endpoint: endpoint, clientConfig: nil)
        #expect(inherited["HERDR_CONFIG_PATH"] == "/x/y.toml")
    }

    @Test func theModeFromTheToggleToTheEnvironment() throws {
        // The path the app takes: resolve the config (toggle and custom path), then build the client's environment.
        let base0 = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-client-mode-\(UUID().uuidString)")
        let home = base0.appendingPathComponent("home").path, temp = base0.appendingPathComponent("tmp").path
        try FileManager.default.createDirectory(atPath: temp, withIntermediateDirectories: true)
        let hidden = try HerdrClientConfig.resolve(hideSidebar: true, custom: nil, home: home, temporaryDirectory: temp)
        let envHidden = FallbackTerminalController.environment(base: base, endpoint: endpoint, clientConfig: hidden)
        #expect(envHidden["HERDR_CONFIG_PATH"]?.hasSuffix("/Conn/herdr-client/hidden-sidebar.toml") == true)
        let shown = try HerdrClientConfig.resolve(hideSidebar: false, custom: nil, home: home, temporaryDirectory: temp)
        #expect(FallbackTerminalController.environment(base: base, endpoint: endpoint, clientConfig: shown)["HERDR_CONFIG_PATH"] == nil)
        // A config that fails the check never reaches the environment: resolve throws, so no client starts.
        #expect(throws: HerdrClientConfig.Failure.self) {
            try HerdrClientConfig.resolve(hideSidebar: true, custom: home + "/.config/herdr/config.toml", home: home, temporaryDirectory: temp)
        }
    }
}

/// The same launch through a real pty and SwiftTerm's process view, against a stub `herdr` (a shell script that reports what it
/// was started with and echoes what is typed). No Herdr server is involved, so this runs everywhere; the lab test next to it
/// does the same against a real Herdr session.
extension SwiftTermMainActorTests {
@Suite("Herdr client mode through a pty") @MainActor struct HerdrClientModePtyTests {
    func stubHerdr() throws -> String {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-stub-herdr-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("herdr").path
        let script = """
        #!/bin/sh
        echo "args: $*"
        if [ -z "$HERDR_CONFIG_PATH" ]; then echo "config: none"; else
          echo "config: ${HERDR_CONFIG_PATH##*/}"
          if grep -q 'sidebar_collapsed_mode = "hidden"' "$HERDR_CONFIG_PATH"; then echo "sidebar: hidden"; else echo "sidebar: shown"; fi
        fi
        echo "selector: ${HERDR_SESSION:-none}"
        echo "ready"
        while read line; do
          if [ "$line" = q ]; then exit 7; fi
          echo "key: $line"
        done
        """
        try script.write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return path
    }

    func screen(_ c: FallbackTerminalController) -> String {
        c.view.visibleRowsText(0..<c.view.terminalDimensions.rows).joined(separator: "\n")
    }

    func wait(_ seconds: Double, until condition: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return condition()
    }

    @Test func attachRunsTheClientWithItsOwnConfigKeysReachItAndStopEndsIt() async throws {
        let bin = try stubHerdr()
        let endpoint = HerdrEndpoint(session: "demo", socketDirectory: "/tmp/conn-no-sockets", binaryPath: bin)
        let temp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-pty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        let config = try #require(try HerdrClientConfig.resolve(hideSidebar: true, custom: nil, home: temp.path, temporaryDirectory: temp.path,
                                                                sourceConfig: temp.appendingPathComponent("none.toml")))

        let c = FallbackTerminalController()
        c.view.frame = NSRect(x: 0, y: 0, width: 900, height: 500)
        c.start(endpoint: endpoint, theme: .dark, clientConfig: config)
        defer { c.stop() }
        #expect(c.running && c.clientConfig == config)
        #expect(await wait(5) { screen(c).contains("ready") }, "the client did not start:\n\(screen(c))")
        #expect(screen(c).contains("args: session attach demo"))
        #expect(screen(c).contains("config: hidden-sidebar.toml") && screen(c).contains("sidebar: hidden"), "\(screen(c))")
        #expect(screen(c).contains("selector: none"))

        // Typing in the pane reaches the client's own stdin.
        c.view.send(txt: "hello\r")
        #expect(await wait(5) { screen(c).contains("key: hello") }, "\(screen(c))")

        // The client ends itself (q): the pane reports the exit code and is no longer running.
        c.view.send(txt: "q\r")
        #expect(await wait(5) { !c.running })
        #expect(c.exitCode == 7)
    }

    @Test func stopEndsARunningClientAndTheNextAttachWithoutAConfigStartsWithNone() async throws {
        let bin = try stubHerdr()
        let endpoint = HerdrEndpoint(session: "demo", socketDirectory: "/tmp/conn-no-sockets", binaryPath: bin)
        let c = FallbackTerminalController()
        c.view.frame = NSRect(x: 0, y: 0, width: 900, height: 500)
        c.start(endpoint: endpoint, theme: .dark)
        #expect(await wait(5) { screen(c).contains("ready") })
        #expect(screen(c).contains("args: session attach demo"))
        #expect(c.clientConfig == nil)
        c.stop()
        #expect(await wait(5) { !c.running }, "stop did not end the client")
        // A client that was never started, and one already stopped, take stop() without effect.
        c.stop()
        FallbackTerminalController().stop()
    }
}
}
