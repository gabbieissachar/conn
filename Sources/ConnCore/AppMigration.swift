import Foundation

/// Moves app-owned configuration and state when the app bundle is renamed.
public enum ConnMigration {
    public static let oldBundleIdentifier = "dev.local.helm"
    public static let bundleIdentifier = "dev.local.conn"

    public struct Report: Equatable, Sendable {
        public let stateMigrated: Bool
        public let defaultsMigrated: Bool

        public init(stateMigrated: Bool, defaultsMigrated: Bool) {
            self.stateMigrated = stateMigrated
            self.defaultsMigrated = defaultsMigrated
        }
    }

    public static func stateDirectory(home: String = NSHomeDirectory(), appName: String = "Conn") -> URL {
        URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent(appName, isDirectory: true)
    }

    /// Migrate the old Helm locations only when their Conn counterparts do not exist.
    @discardableResult
    public static func migrateIfNeeded(
        home: String = NSHomeDirectory(),
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) -> Report {
        let oldDefaults = UserDefaults(suiteName: oldBundleIdentifier)
        return migrate(
            stateFrom: stateDirectory(home: home, appName: "Helm"),
            stateTo: stateDirectory(home: home),
            oldDefaults: oldDefaults,
            newDefaults: defaults,
            oldBundleIdentifier: oldBundleIdentifier,
            newBundleIdentifier: bundleIdentifier,
            fileManager: fileManager
        )
    }

    /// Injectable form used by the app and by migration tests.
    @discardableResult
    public static func migrate(
        stateFrom: URL,
        stateTo: URL,
        oldDefaults: UserDefaults?,
        newDefaults: UserDefaults,
        oldBundleIdentifier: String,
        newBundleIdentifier: String,
        fileManager: FileManager = .default
    ) -> Report {
        var stateMigrated = false
        if fileManager.fileExists(atPath: stateFrom.path) && !fileManager.fileExists(atPath: stateTo.path) {
            try? fileManager.createDirectory(at: stateTo.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try fileManager.moveItem(at: stateFrom, to: stateTo)
                stateMigrated = true
            } catch {
                do {
                    try fileManager.copyItem(at: stateFrom, to: stateTo)
                    stateMigrated = true
                } catch {
                    stateMigrated = false
                }
            }
        }

        var defaultsMigrated = false
        let oldValues = oldDefaults?.persistentDomain(forName: oldBundleIdentifier) ?? [:]
        let newValues = newDefaults.persistentDomain(forName: newBundleIdentifier) ?? [:]
        if !oldValues.isEmpty && newValues.isEmpty {
            var migrated = oldValues
            for key in oldValues.keys where key.hasPrefix("helm.") {
                migrated["conn." + key.dropFirst("helm.".count)] = migrated.removeValue(forKey: key)
            }
            newDefaults.setPersistentDomain(migrated, forName: newBundleIdentifier)
            defaultsMigrated = true
        }

        return Report(stateMigrated: stateMigrated, defaultsMigrated: defaultsMigrated)
    }
}
