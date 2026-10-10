// Verify the shipped artwork, including the iconutil packaging round-trip.
import AppKit
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = root.appendingPathComponent("assets/icons")
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }

func check(_ url: URL, pixels: Int, inset: Int) throws {
  let data = try Data(contentsOf: url)
  guard let image = NSBitmapImageRep(data: data) else { fatalError("Cannot decode \(url.path)") }
  precondition(image.pixelsWide == pixels && image.pixelsHigh == pixels, "Wrong size: \(url.path)")
  precondition(image.hasAlpha, "Missing transparency: \(url.path)")
  var minX = pixels, minY = pixels, maxX = -1, maxY = -1
  for y in 0..<pixels {
    for x in 0..<pixels {
      // Ignore negligible antialiasing outside the tile's mathematical bounds.
      if image.colorAt(x: x, y: y)!.alphaComponent > 0.01 {
        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x)
        maxY = max(maxY, y)
      }
    }
  }
  precondition(
    minX == inset && minY == inset && maxX == pixels - inset - 1 && maxY == pixels - inset - 1,
    "Wrong tile bounds in \(url.lastPathComponent): \(minX),\(minY)–\(maxX),\(maxY)")
}

for name in ["herdr-ui-icon-clean.png", "herdr-worktree-1024.png"] {
  try check(assets.appendingPathComponent(name), pixels: 1024, inset: 100)
}

// Expected values transcribed from Apple's Sequoia production template,
// independent of the generator's sizing calculations.
let representations = [
  (16, 1, 1), (16, 2, 2), (32, 1, 2), (32, 2, 6),
  (128, 1, 12), (128, 2, 25), (256, 1, 25), (256, 2, 50),
  (512, 1, 50), (512, 2, 100),
]
for name in ["Herdr", "Herdr-worktree"] {
  let iconset = temporary.appendingPathComponent("\(name).iconset")
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
  process.arguments = ["-c", "iconset", assets.appendingPathComponent("\(name).icns").path, "-o", iconset.path]
  try process.run()
  process.waitUntilExit()
  precondition(process.terminationStatus == 0, "iconutil failed")
  for (size, scale, inset) in representations {
    let suffix = scale == 2 ? "@2x" : ""
    try check(iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"), pixels: size * scale, inset: inset)
  }
  print("PASS: \(name).icns — all 10 standard/Retina representations")
}
print("PASS: embedded PNG dimensions and transparent margins")
