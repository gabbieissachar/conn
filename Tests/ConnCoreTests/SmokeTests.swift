import Testing
@testable import ConnCore

@Test func versionIsSet() { #expect(!ConnCoreVersion.string.isEmpty) }
