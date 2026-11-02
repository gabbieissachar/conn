import Foundation
import CoreGraphics
import ImageIO

enum Concept: String, CaseIterable {
    case commandC = "command-c"
    case signalPennant = "signal-pennant"
    case linkedLoops = "linked-loops"
}

let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), arguments.indices.contains(i + 1) else { return nil }
    return arguments[i + 1]
}

let outputDir = URL(fileURLWithPath: argument("--output") ?? ".build/conn-icon-concepts", isDirectory: true)
let previewURL = URL(fileURLWithPath: argument("--preview") ?? "docs/icon-concepts.png")
let iconsetDir = argument("--iconset").map { URL(fileURLWithPath: $0, isDirectory: true) }
let selected = Concept(rawValue: argument("--selected") ?? Concept.commandC.rawValue) ?? .commandC
let fileManager = FileManager.default
try fileManager.createDirectory(at: outputDir, withIntermediateDirectories: true)
if let iconsetDir { try fileManager.createDirectory(at: iconsetDir, withIntermediateDirectories: true) }

func color(_ hex: UInt32) -> CGColor {
    let r = CGFloat((hex >> 16) & 0xff) / 255
    let g = CGFloat((hex >> 8) & 0xff) / 255
    let b = CGFloat(hex & 0xff) / 255
    return CGColor(red: r, green: g, blue: b, alpha: 1)
}

func image(size: Int, concept: Concept) -> CGImage {
    let space = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: size * 4, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(size)
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.interpolationQuality = .high

    func roundedBackground(_ fill: CGColor) {
        context.setFillColor(fill)
        context.addPath(CGPath(roundedRect: CGRect(x: s * 0.04, y: s * 0.04, width: s * 0.92, height: s * 0.92),
                               cornerWidth: s * 0.20, cornerHeight: s * 0.20, transform: nil))
        context.fillPath()
    }

    func point(_ x: CGFloat, _ yDown: CGFloat) -> CGPoint { CGPoint(x: s * x, y: s * (1 - yDown)) }

    switch concept {
    case .commandC:
        roundedBackground(color(0x17324D))
        let path = CGMutablePath()
        path.move(to: point(0.72, 0.27))
        path.addCurve(to: point(0.29, 0.50), control1: point(0.59, 0.24), control2: point(0.28, 0.30))
        path.addCurve(to: point(0.72, 0.73), control1: point(0.28, 0.70), control2: point(0.59, 0.76))
        context.addPath(path)
        context.setStrokeColor(color(0xF47C61))
        context.setLineWidth(s * 0.16)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.strokePath()

    case .signalPennant:
        roundedBackground(color(0xF4E7C6))
        let flag = CGMutablePath()
        flag.move(to: point(0.26, 0.20))
        flag.addLine(to: point(0.74, 0.50))
        flag.addLine(to: point(0.26, 0.80))
        flag.closeSubpath()
        context.addPath(flag)
        context.setFillColor(color(0x0F7772))
        context.fillPath()
        context.move(to: point(0.26, 0.16))
        context.addLine(to: point(0.26, 0.84))
        context.setStrokeColor(color(0xE26F4A))
        context.setLineWidth(s * 0.09)
        context.setLineCap(.round)
        context.strokePath()

    case .linkedLoops:
        roundedBackground(color(0xD85E45))
        func loop(centerX: CGFloat, angle: CGFloat, stroke: CGColor) {
            context.saveGState()
            context.translateBy(x: s * centerX, y: s * 0.50)
            context.rotate(by: angle)
            let rect = CGRect(x: -s * 0.27, y: -s * 0.15, width: s * 0.54, height: s * 0.30)
            context.addPath(CGPath(roundedRect: rect, cornerWidth: s * 0.15, cornerHeight: s * 0.15, transform: nil))
            context.setStrokeColor(stroke)
            context.setLineWidth(s * 0.12)
            context.setLineCap(.round)
            context.strokePath()
            context.restoreGState()
        }
        loop(centerX: 0.39, angle: -0.48, stroke: color(0x17324D))
        loop(centerX: 0.61, angle: 0.48, stroke: color(0xF4E7C6))
    }

    return context.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) throws {
    try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "ConnIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot create PNG destination"])
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "ConnIcon", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot write PNG"])
    }
}

for concept in Concept.allCases {
    try writePNG(image(size: 512, concept: concept), to: outputDir.appendingPathComponent("\(concept.rawValue)-512.png"))
    try writePNG(image(size: 32, concept: concept), to: outputDir.appendingPathComponent("\(concept.rawValue)-32.png"))
}

let sheetSize = CGSize(width: 1728, height: 640)
let sheetContext = CGContext(data: nil, width: Int(sheetSize.width), height: Int(sheetSize.height), bitsPerComponent: 8,
                             bytesPerRow: Int(sheetSize.width) * 4, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
sheetContext.setFillColor(color(0xF7F5F0))
sheetContext.fill(CGRect(origin: .zero, size: sheetSize))
for (index, concept) in Concept.allCases.enumerated() {
    let x = CGFloat(index) * 576
    sheetContext.draw(image(size: 512, concept: concept), in: CGRect(x: x + 32, y: 96, width: 512, height: 512))
    sheetContext.draw(image(size: 32, concept: concept), in: CGRect(x: x + 272, y: 32, width: 32, height: 32))
}
try writePNG(sheetContext.makeImage()!, to: previewURL)

if let iconsetDir {
    let sizes: [(name: String, pixels: Int)] = [
        ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)
    ]
    for item in sizes {
        try writePNG(image(size: item.pixels, concept: selected), to: iconsetDir.appendingPathComponent(item.name))
    }
}
