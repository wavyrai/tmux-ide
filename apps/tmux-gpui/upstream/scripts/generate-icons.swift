// Render each native icon resolution directly from the vector artwork.
import AppKit
import CoreImage
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = root.appendingPathComponent("assets/icons")
let variants: [(String, String, String?)] = [
  ("herdr-ui-icon-clean.svg", "herdr-worktree-1024.png", "Herdr"),
  ("herdr-icon-square-clean.svg", "herdr-square-worktree-1024.png", nil),
]
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }

// Sequoia's Template - Icon - App.sketch uses pixel-aligned margins that vary
// by resolution, rather than uniformly scaling the 1024px icon. See assets/icons/README.md.
let macOSInsets = [16: 1, 32: 2, 64: 6, 128: 12, 256: 25, 512: 50, 1024: 100]

func render(_ sourceName: String, pixels: Int, macOS: Bool) throws -> Data {
  let output = temporary.appendingPathComponent("render.png")
  let renderer = Process()
  renderer.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  // The rounded source has an 896px tile centered in a 1024px canvas. Fit
  // that tile to Apple's footprint before rasterizing, preserving vector detail.
  let width = macOS ? Double(pixels - 2 * macOSInsets[pixels]!) * 1024 / 896 : Double(pixels)
  let offset = (Double(pixels) - width) / 2
  renderer.arguments = [
    "rsvg-convert", "--width", String(width), "--height", String(width),
    "--page-width", String(pixels), "--page-height", String(pixels),
    "--left", String(offset), "--top", String(offset),
    "--output", output.path, assets.appendingPathComponent(sourceName).path,
  ]
  try renderer.run()
  renderer.waitUntilExit()
  precondition(renderer.terminationStatus == 0, "rsvg-convert failed; install with brew install librsvg")
  let png = try Data(contentsOf: output)
  guard let image = NSBitmapImageRep(data: png),
    image.pixelsWide == pixels, image.pixelsHigh == pixels
  else {
    fatalError("Unexpected SVG render dimensions")
  }
  return png
}

let colorContext = CIContext()
func worktreePNG(_ source: Data) -> Data {
  let image = NSBitmapImageRep(data: source)!.cgImage!
  // Map luminance to a saturated red palette while retaining the original alpha
  // and shading at this resolution.
  let red = CIImage(cgImage: image).applyingFilter(
    "CIColorMatrix",
    parameters: [
      "inputRVector": CIVector(x: 0.1382, y: 0.4649, z: 0.0469, w: 0),
      "inputGVector": CIVector(x: 0.0255, y: 0.0858, z: 0.0087, w: 0),
      "inputBVector": CIVector(x: 0.0255, y: 0.0858, z: 0.0087, w: 0),
      "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
      "inputBiasVector": CIVector(x: 0.25, y: 0.02, z: 0.035, w: 0),
    ])
  guard let redImage = colorContext.createCGImage(red, from: red.extent) else {
    fatalError("Unable to generate the red worktree icon")
  }
  return NSBitmapImageRep(cgImage: redImage).representation(using: .png, properties: [:])!
}

func worktreeColor(_ color: NSColor) -> NSColor {
  // Apply the same mapping as the rendered PNGs to a one-pixel swatch.
  let swatch = CGContext(
    data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  swatch.setFillColor(color.cgColor)
  swatch.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
  let png = NSBitmapImageRep(cgImage: swatch.makeImage()!).representation(using: .png, properties: [:])!
  let red = NSBitmapImageRep(data: worktreePNG(png))!
  return red.colorAt(x: 0, y: 0)!.usingColorSpace(.sRGB)!
}

func hexString(_ color: NSColor) -> String {
  let channel = { (value: CGFloat) in Int((value * 255).rounded()) }
  return String(
    format: "#%02x%02x%02x", channel(color.redComponent), channel(color.greenComponent),
    channel(color.blueComponent))
}

func match(_ pattern: String, in text: String) -> String {
  let regex = try! NSRegularExpression(pattern: pattern)
  guard let result = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else {
    fatalError("Rounded icon SVG no longer matches: \(pattern)")
  }
  return String(text[Range(result.range(at: 1), in: text)!])
}

// macOS 26 and later redraw flattened .icns artwork with Liquid Glass lighting,
// which visibly softens it in the Dock. An Icon Composer document gives the
// system the vector ram and flat tile color to render sharply at every size.
// actool compiles it to an asset catalog selected by CFBundleIconName.
func compileAssetCatalog(_ sourceName: String, name: String, isWorktree: Bool) throws {
  let svg = try String(contentsOf: assets.appendingPathComponent(sourceName), encoding: .utf8)
  let ram = match(#"<path id="ram" d="([^"]+)""#, in: svg)
  let transform = match(##"<use href="#ram" transform="([^"]+)""##, in: svg)
  let hex = { (hex: String) in
    let value = Int(hex.dropFirst(), radix: 16)!
    let color = NSColor(
      srgbRed: CGFloat(value >> 16 & 255) / 255, green: CGFloat(value >> 8 & 255) / 255,
      blue: CGFloat(value & 255) / 255, alpha: 1)
    return isWorktree ? worktreeColor(color) : color
  }
  let tile = hex(match(##"<rect x="64" y="64" width="896" height="896" rx="192" fill="(#[0-9a-f]{6})""##, in: svg))
  let fill = hex(match(##"<use href="#ram" [^>]*fill="(#[0-9a-f]{6})""##, in: svg))

  // Both variants use the icon name Info.plist's CFBundleIconName selects.
  let document = temporary.appendingPathComponent("\(name)/Herdr.icon")
  try FileManager.default.createDirectory(
    at: document.appendingPathComponent("Assets"), withIntermediateDirectories: true)
  // The system masks the full-bleed canvas, so crop to the source's 896px tile.
  let layer = """
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="64 64 896 896">
      <path d="\(ram)" transform="\(transform)" fill="\(hexString(fill))" />
    </svg>

    """
  try layer.write(to: document.appendingPathComponent("Assets/ram.svg"), atomically: true, encoding: .utf8)
  // Glass, specular highlights, translucency, and shadows stay off to keep the
  // flat artwork.
  let manifest: [String: Any] = [
    "fill": [
      "solid": String(
        format: "srgb:%.5f,%.5f,%.5f,1.00000", tile.redComponent, tile.greenComponent, tile.blueComponent)
    ],
    "groups": [
      [
        "layers": [["glass": false, "image-name": "ram.svg", "name": "ram"]],
        "shadow": ["kind": "none", "opacity": 0.5],
        "specular": false,
        "translucency": ["enabled": false, "value": 0.5],
      ]
    ],
    "supported-platforms": ["squares": ["macOS"]],
  ]
  try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    .write(to: document.appendingPathComponent("icon.json"))

  let output = temporary.appendingPathComponent("\(name)-catalog")
  try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
  let actool = Process()
  actool.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
  actool.arguments = [
    "actool", document.path, "--compile", output.path, "--app-icon", "Herdr",
    "--enable-on-demand-resources", "NO", "--development-region", "en",
    "--target-device", "mac", "--platform", "macosx", "--minimum-deployment-target", "14.2",
    "--output-partial-info-plist", output.appendingPathComponent("partial.plist").path,
  ]
  actool.standardOutput = FileHandle.nullDevice
  try actool.run()
  actool.waitUntilExit()
  precondition(actool.terminationStatus == 0, "actool failed; install Xcode 26 or later")
  let destination = assets.appendingPathComponent("\(name).car")
  try? FileManager.default.removeItem(at: destination)
  try FileManager.default.copyItem(at: output.appendingPathComponent("Assets.car"), to: destination)
  print("Generated assets/icons/\(name).car")
}

for (sourceName, redName, bundleName) in variants {
  let source = try render(sourceName, pixels: 1024, macOS: bundleName != nil)
  let redPNG = worktreePNG(source)
  let pngURL = assets.appendingPathComponent(sourceName).deletingPathExtension().appendingPathExtension("png")
  try source.write(to: pngURL)
  try redPNG.write(to: assets.appendingPathComponent(redName))

  guard let bundleName else { continue }
  for (name, isWorktree) in [(bundleName, false), ("\(bundleName)-worktree", true)] {
    let iconset = temporary.appendingPathComponent("\(name).iconset")
    try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
      for scale in [1, 2] {
        let pixels = size * scale
        let rendered = try render(sourceName, pixels: pixels, macOS: true)
        let png = isWorktree ? worktreePNG(rendered) : rendered
        let suffix = scale == 2 ? "@2x" : ""
        try png.write(to: iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
      }
    }
    let iconutil = Process()
    iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    iconutil.arguments = [
      "-c", "icns", iconset.path, "-o", assets.appendingPathComponent("\(name).icns").path,
    ]
    try iconutil.run()
    iconutil.waitUntilExit()
    precondition(iconutil.terminationStatus == 0, "iconutil failed")
    print("Generated assets/icons/\(name).icns")
    try compileAssetCatalog(sourceName, name: name, isWorktree: isWorktree)
  }
}
