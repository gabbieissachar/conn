import Testing
@testable import HelmCore

@Test func versionIsSet() { #expect(!HelmCoreVersion.string.isEmpty) }
