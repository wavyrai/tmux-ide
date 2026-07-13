import AppKit
import OSLog
import Security
import UserNotifications

private enum PayloadKey {
  static let session = "session"
  static let hostSession = "hostSession"
  static let jumpOption = "jumpOption"
  static let tmuxPath = "tmuxPath"
  static let socketPath = "socketPath"
}

private struct NotifyOptions {
  var title = "tmux-ide"
  var message: String?
  var session: String?
  var hostSession: String?
  var jumpOption: String?
  var tmuxPath: String?
  var socketPath: String?

  init(arguments: [String]) {
    var index = 0
    while index < arguments.count {
      let flag = arguments[index]
      let value = index + 1 < arguments.count ? arguments[index + 1] : nil
      switch flag {
      case "--title": title = value ?? title
      case "--message": message = value
      case "--session": session = value
      case "--host-session": hostSession = value
      case "--jump-option": jumpOption = value
      case "--tmux-path": tmuxPath = value
      case "--socket-path": socketPath = value
      default:
        index += 1
        continue
      }
      index += 2
    }
  }
}

private final class NotifierAppDelegate: NSObject, NSApplicationDelegate,
  UNUserNotificationCenterDelegate, NSUserNotificationCenterDelegate
{
  private let options: NotifyOptions
  private let center = UNUserNotificationCenter.current()
  private let logger = Logger(subsystem: "com.wavyrai.tmuxide.notifier", category: "notifications")

  init(options: NotifyOptions) {
    self.options = options
    super.init()
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    // The delegate must be installed before launch finishes: Notification
    // Center can relaunch this helper directly when a delivered banner is
    // clicked, before applicationDidFinishLaunching has a chance to run.
    center.delegate = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if let legacyNotification =
      notification.userInfo?[NSApplication.launchUserNotificationUserInfoKey]
      as? NSUserNotification
    {
      activateLegacyNotification(legacyNotification)
      return
    }

    guard let message = options.message, !message.isEmpty else {
      // A no-argv launch is Notification Center reopening the helper for a
      // click. Keep the run loop alive briefly for didReceive(response:).
      terminate(after: 10)
      return
    }

    // `UNUserNotificationCenter` rejects ad-hoc signatures before it can ask
    // permission. npm/Homebrew builds are intentionally portable and ad-hoc
    // signed, so go straight to the native compatibility API in that shape.
    // A Developer ID / Apple Development build uses the modern API below.
    guard hasTeamSignature() else {
      postLegacy(message: message)
      return
    }

    // Do not leave a helper process behind if Notification Center is unable to
    // answer (for example while its service is restarting).
    terminate(after: 45)
    center.getNotificationSettings { [weak self] settings in
      guard let self else { return }
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        self.post(message: message)
      case .notDetermined:
        self.requestAuthorization(andPost: message)
      case .denied:
        logger.notice("Notifications are disabled for tmux-ide in System Settings")
        self.terminate(after: 0)
      @unknown default:
        self.terminate(after: 0)
      }
    }
  }

  private func requestAuthorization(andPost message: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      // The regular notification launch is deliberately background-only. Make
      // this LSUIElement active for the one-time system permission sheet; it
      // still has no Dock icon or visible window.
      NSApplication.shared.activate(ignoringOtherApps: true)
      self.center.requestAuthorization(options: [.alert]) { [weak self] granted, error in
        guard let self else { return }
        guard granted, error == nil else {
          if let error {
            // If a team-signed build still cannot use modern authorization,
            // keep native delivery, branding, and click relaunch available
            // through Notification Center's compatibility API.
            self.logger.notice(
              "Modern authorization unavailable; using native compatibility delivery: \(String(describing: error), privacy: .public)"
            )
            DispatchQueue.main.async {
              NSApplication.shared.hide(nil)
              self.postLegacy(message: message)
            }
          } else {
            // A nil error with granted=false is an explicit user decision.
            self.terminate(after: 0)
          }
          return
        }
        DispatchQueue.main.async {
          NSApplication.shared.hide(nil)
          self.post(message: message)
        }
      }
    }
  }

  private func post(message: String) {
    let content = UNMutableNotificationContent()
    content.title = options.title
    content.body = message
    if let session = options.session {
      content.threadIdentifier = session
    }

    content.userInfo = Dictionary(
      uniqueKeysWithValues: notificationPayload().map { (AnyHashable($0.key), $0.value) }
    )

    let request = UNNotificationRequest(
      identifier: "tmux-ide-\(UUID().uuidString)",
      content: content,
      trigger: nil
    )
    center.add(request) { [weak self] error in
      if let error {
        self?.logger.error(
          "Adding notification failed: \(String(describing: error), privacy: .public)"
        )
      }
      // The request is owned by Notification Center after add completes. Exit
      // like a normal helper; macOS relaunches this bundle if the user clicks.
      self?.terminate(after: 0.25)
    }
  }

  private func postLegacy(message: String) {
    let notification = NSUserNotification()
    notification.title = options.title
    notification.informativeText = message
    notification.userInfo = notificationPayload()
    let legacyCenter = NSUserNotificationCenter.default
    legacyCenter.delegate = self
    // Give LaunchServices a moment to finish registering a newly installed
    // bundle before legacy Notification Center resolves its sender identity.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
      legacyCenter.deliver(notification)
      // Notification Center owns the delivered item and relaunches this bundle
      // with launchUserNotificationUserInfoKey when it is clicked.
      self?.terminate(after: 0.5)
    }
  }

  private func hasTeamSignature() -> Bool {
    var staticCode: SecStaticCode?
    guard
      SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &staticCode) == errSecSuccess,
      let staticCode
    else { return false }

    var information: CFDictionary?
    guard
      SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &information
      ) == errSecSuccess,
      let values = information as? [String: Any],
      let teamIdentifier = values[kSecCodeInfoTeamIdentifier as String] as? String
    else { return false }
    return !teamIdentifier.isEmpty
  }

  private func notificationPayload() -> [String: Any] {
    var payload: [String: Any] = [:]
    if let session = options.session { payload[PayloadKey.session] = session }
    if let hostSession = options.hostSession { payload[PayloadKey.hostSession] = hostSession }
    if let jumpOption = options.jumpOption { payload[PayloadKey.jumpOption] = jumpOption }
    if let tmuxPath = options.tmuxPath { payload[PayloadKey.tmuxPath] = tmuxPath }
    if let socketPath = options.socketPath { payload[PayloadKey.socketPath] = socketPath }
    return payload
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // The immediate request can arrive while this short-lived LSUIElement app
    // is technically foreground. Explicit presentation prevents suppression.
    completionHandler([.banner, .list])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
      jumpToSession(response.notification.request.content.userInfo)
    }
    center.removeDeliveredNotifications(withIdentifiers: [response.notification.request.identifier])
    completionHandler()
    terminate(after: 0)
  }

  func userNotificationCenter(
    _ center: NSUserNotificationCenter,
    shouldPresent notification: NSUserNotification
  ) -> Bool {
    true
  }

  func userNotificationCenter(
    _ center: NSUserNotificationCenter,
    didActivate notification: NSUserNotification
  ) {
    activateLegacyNotification(notification)
  }

  private func activateLegacyNotification(_ notification: NSUserNotification) {
    if let payload = notification.userInfo {
      jumpToSession(
        Dictionary(uniqueKeysWithValues: payload.map { (AnyHashable($0.key), $0.value) })
      )
    }
    NSUserNotificationCenter.default.removeDeliveredNotification(notification)
    terminate(after: 0)
  }

  private func jumpToSession(_ payload: [AnyHashable: Any]) {
    guard
      let tmuxPath = payload[PayloadKey.tmuxPath] as? String,
      tmuxPath.hasPrefix("/"),
      let session = payload[PayloadKey.session] as? String,
      !session.isEmpty
    else { return }

    let socketPath = payload[PayloadKey.socketPath] as? String
    let hostSession = payload[PayloadKey.hostSession] as? String
    let jumpOption = payload[PayloadKey.jumpOption] as? String

    if let hostSession, !hostSession.isEmpty,
      runTmux(tmuxPath, socketPath, ["has-session", "-t", "=\(hostSession)"])
    {
      if let jumpOption, !jumpOption.isEmpty {
        _ = runTmux(
          tmuxPath, socketPath,
          [
            "set-option", "-t", hostSession, jumpOption, session,
          ])
      }
      _ = runTmux(tmuxPath, socketPath, ["switch-client", "-t", "=\(hostSession)"])
      return
    }
    _ = runTmux(tmuxPath, socketPath, ["switch-client", "-t", "=\(session)"])
  }

  private func runTmux(
    _ executable: String,
    _ socketPath: String?,
    _ arguments: [String]
  ) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    var argv: [String] = []
    if let socketPath, !socketPath.isEmpty {
      argv += ["-S", socketPath]
    }
    argv += arguments
    process.arguments = argv
    let null = FileHandle(forWritingAtPath: "/dev/null")
    process.standardOutput = null
    process.standardError = null
    do {
      try process.run()
      process.waitUntilExit()
      null?.closeFile()
      return process.terminationStatus == 0
    } catch {
      null?.closeFile()
      return false
    }
  }

  private func terminate(after seconds: TimeInterval) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
      NSApplication.shared.terminate(nil)
    }
  }
}

@main
private enum TmuxIdeNotifierMain {
  static func main() {
    let options = NotifyOptions(arguments: Array(CommandLine.arguments.dropFirst()))
    let app = NSApplication.shared
    let delegate = NotifierAppDelegate(options: options)
    app.setActivationPolicy(.accessory)
    app.delegate = delegate
    app.run()
    _ = delegate  // retain for the full application run loop
  }
}
