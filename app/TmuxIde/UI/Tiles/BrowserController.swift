import AppKit
import Foundation
import SwiftUI
import WebKit

@MainActor
final class BrowserController: NSObject, ObservableObject, WKNavigationDelegate {

    @Published private(set) var currentURLString: String?
    @Published private(set) var pageTitle: String?
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var estimatedProgress: Double = 0
    @Published private(set) var canGoBack: Bool = false
    @Published private(set) var canGoForward: Bool = false
    @Published var navigationError: String?

    var isSecure: Bool {
        currentURLString?.hasPrefix("https://") ?? false
    }

    let webView: WKWebView

    private var kvoObservations: [NSKeyValueObservation] = []

    init(initialURL: String?) {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.websiteDataStore = .default()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.pageZoom = 0.85
        super.init()
        webView.navigationDelegate = self
        installKVOObservers()

        if let initialURL {
            load(urlString: initialURL)
        }
    }

    deinit {
        kvoObservations.removeAll()
    }

    private func installKVOObservers() {
        kvoObservations.append(webView.observe(\.canGoBack, options: [.new]) { [weak self] _, change in
            Task { @MainActor [weak self] in self?.canGoBack = change.newValue ?? false }
        })
        kvoObservations.append(webView.observe(\.canGoForward, options: [.new]) { [weak self] _, change in
            Task { @MainActor [weak self] in self?.canGoForward = change.newValue ?? false }
        })
        kvoObservations.append(webView.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            Task { @MainActor [weak self] in self?.isLoading = change.newValue ?? false }
        })
        kvoObservations.append(webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, change in
            Task { @MainActor [weak self] in self?.estimatedProgress = change.newValue ?? 0 }
        })
        kvoObservations.append(webView.observe(\.title, options: [.new]) { [weak self] _, change in
            Task { @MainActor [weak self] in self?.pageTitle = change.newValue ?? nil }
        })
    }

    // MARK: - Navigation

    func load(urlString: String?) {
        navigationError = nil
        guard let urlString, let url = normalizeURL(urlString) else { return }
        webView.load(URLRequest(url: url))
        currentURLString = url.absoluteString
    }

    func goBack() {
        navigationError = nil
        webView.goBack()
    }

    func goForward() {
        navigationError = nil
        webView.goForward()
    }

    func reload() {
        navigationError = nil
        webView.reload()
    }

    func stopLoading() {
        webView.stopLoading()
    }

    func openInDefaultBrowser() {
        guard let currentURLString, let url = URL(string: currentURLString) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - URL Normalization

    func normalizeURL(_ value: String?) -> URL? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Already has a scheme
        if let url = URL(string: trimmed), let scheme = url.scheme, !scheme.isEmpty {
            return url
        }

        // Detect localhost patterns — use http
        if trimmed.hasPrefix("localhost") || trimmed.hasPrefix("127.0.0.1") || trimmed.hasPrefix("0.0.0.0") {
            if let withHTTP = URL(string: "http://\(trimmed)") {
                return withHTTP
            }
        }

        // If it looks like a domain, treat as URL
        if trimmed.contains(".") || trimmed.contains(":") {
            if let withHTTPS = URL(string: "https://\(trimmed)") {
                return withHTTPS
            }
        }

        // Otherwise, search query
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmed
        return URL(string: "https://www.google.com/search?q=\(encoded)")
    }

    // MARK: - WKNavigationDelegate

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            self?.navigationError = nil
            self?.currentURLString = webView.url?.absoluteString
        }
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            self?.navigationError = nil
            self?.currentURLString = webView.url?.absoluteString
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        Task { @MainActor [weak self] in
            self?.navigationError = error.localizedDescription
            self?.currentURLString = webView.url?.absoluteString
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        Task { @MainActor [weak self] in
            self?.navigationError = error.localizedDescription
        }
    }
}
