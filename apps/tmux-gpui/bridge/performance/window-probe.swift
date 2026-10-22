// Build explicitly before measurement: swiftc window-probe.swift -o window-probe
// Captures only a caller-owned PID/window pair; never captures a desktop display.
import AppKit
import CoreGraphics
import ImageIO
import Vision

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func fail(_ message: String) -> Never { emit(["error": message]); exit(1) }
func nanos() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
let args = Array(CommandLine.arguments.dropFirst())
func ownedWindow(_ pid: pid_t, _ id: CGWindowID) -> Bool {
    let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
    return rows.contains { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid)
        && ($0[kCGWindowNumber as String] as? UInt32) == id }
}
func displayInfo(_ row: [String: Any]) -> [String: Any] {
    guard let raw = row[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return ["refreshHz": "unknown", "scale": "unknown"] }
    var displays = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetDisplaysWithRect(rect, 16, &displays, &count) == .success, count == 1 else { return ["refreshHz": "unknown", "scale": "unknown", "reason": "window spans or lacks a display"] }
    let id = displays[0], bounds = CGDisplayBounds(id)
    let hz = CGDisplayCopyDisplayMode(id)?.refreshRate ?? 0
    return ["id": id, "refreshHz": hz > 0 ? hz as Any : "unknown", "scale": bounds.width > 0 ? Double(CGDisplayPixelsWide(id)) / bounds.width as Any : "unknown"]
}
func windows(_ pids: Set<Int>) -> [[String: Any]] {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        guard let pid = row[kCGWindowOwnerPID as String] as? Int, pids.contains(pid),
              let id = row[kCGWindowNumber as String] as? Int,
              (row[kCGWindowLayer as String] as? Int) == 0 else { return nil }
        return ["pid": pid, "window": id, "bounds": row[kCGWindowBounds as String] ?? [:], "display": displayInfo(row)]
    }
}
guard let operation = args.first else { fail("operation required") }
if operation == "preflight" {
    emit(["screenCapture": CGPreflightScreenCaptureAccess(), "inputPosting": CGPreflightPostEventAccess(), "endpoint": "owned-window-screenshot-observation"])
} else if operation == "clock" {
    emit(["clockNs": String(nanos())])
} else if operation == "windows" {
    emit(["windows": windows(Set(args.dropFirst().compactMap(Int.init)))])
} else if operation == "launch-terminal" {
    guard args.count == 4 else { fail("launch-terminal APP ENV.json SCRIPT") }
    let env = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [String: String]
    let config = NSWorkspace.OpenConfiguration()
    config.createsNewApplicationInstance = true
    config.activates = false
    config.environment = env
    config.arguments = ["--config-default-files=false", "--font-family=Menlo", "--font-size=14", "--window-width=140", "--window-height=45", "--quit-after-last-window-closed=true", "-e", args[3]]
    let before = Set(NSWorkspace.shared.runningApplications.map(\.processIdentifier))
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: args[1]), configuration: config) { app, error in
        guard let app = app, error == nil, !before.contains(app.processIdentifier) else { fail("terminal did not create an independent process") }
        try? String(app.processIdentifier).write(toFile: args[2] + ".pid", atomically: true, encoding: .utf8)
        emit(["pid": app.processIdentifier]); exit(0)
    }
    RunLoop.main.run()
} else {
    guard args.count >= 3, let pid = Int32(args[1]), let window = UInt32(args[2]), ownedWindow(pid, window) else { fail("owned window identity mismatch") }
    if operation == "activate" {
        guard NSRunningApplication(processIdentifier: pid)?.activate(options: []) == true else { fail("activation failed") }
        emit(["activated": true])
    } else if operation == "input" {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { fail("owned input window is not foreground") }
        guard args.count == 4, CGPreflightPostEventAccess(), args[3].range(of: "^P[0-9]{3}$", options: .regularExpression) != nil else { fail("input requires permission and exact fixture marker") }
        let started = nanos()
        for character in args[3] {
            let chars = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { fail("key event unavailable") }
            down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            down.postToPid(pid); up.postToPid(pid)
        }
        CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true)?.postToPid(pid)
        CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)?.postToPid(pid)
        emit(["triggerStartNs": String(started), "triggerEndNs": String(nanos())])
    } else if operation == "capture" {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { fail("owned capture window is not foreground") }
        guard args.count == 6, CGPreflightScreenCaptureAccess(), let rgb = UInt32(args[4], radix: 16) else { fail("capture PATH RGB requires permission") }
        let start = nanos()
        let command = Process(); command.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        command.arguments = ["-x", "-o", "-l", String(window), args[3]]
        try command.run(); command.waitUntilExit()
        guard command.terminationStatus == 0, ownedWindow(pid, window),
              let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width <= 8192, image.height <= 8192 else { fail("bounded window capture failed") }
        let captured = nanos()
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        recognition.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([recognition])
        let markerVisible = (recognition.results ?? []).contains { result in
            result.topCandidates(1).contains { $0.string.split(whereSeparator: { $0.isWhitespace }).contains(Substring(args[5])) }
        }
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let count = pixels.withUnsafeMutableBytes { bytes -> Int in
            guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            let data = bytes.bindMemory(to: UInt8.self)
            return stride(from: 0, to: data.count, by: 4).reduce(0) { sum, n in
                sum + ((abs(Int(data[n]) - Int((rgb >> 16) & 255)) <= 4 && abs(Int(data[n+1]) - Int((rgb >> 8) & 255)) <= 4 && abs(Int(data[n+2]) - Int(rgb & 255)) <= 4) ? 1 : 0)
            }
        }
        emit(["captureStartNs": String(start), "captureEndNs": String(captured), "matchingPixels": count, "markerVisible": markerVisible, "width": image.width, "height": image.height])
    } else { fail("unknown operation") }
}
