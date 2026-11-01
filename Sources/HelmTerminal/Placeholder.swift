import SwiftTerm
import HelmCore
public enum HelmTerminalProbe { public static func ok() -> String { "\(HelmCoreVersion.string) \(type(of: Terminal.self))" } }
