import SwiftUI
import WebKit

// MARK: - WebView Tile

struct WebViewTileView: View {
    let initialURL: String?

    @Environment(\.themeColors) private var tc
    @StateObject private var controller: BrowserController

    @State private var addressBarText: String

    init(initialURL: String?) {
        self.initialURL = initialURL
        let url = initialURL ?? "https://www.google.com"
        _controller = StateObject(wrappedValue: BrowserController(initialURL: url))
        _addressBarText = State(initialValue: url)
    }

    var body: some View {
        VStack(spacing: 0) {
            browserToolbar
            progressBar
            errorBanner
            webViewContent
        }
    }

    // MARK: - Toolbar

    private var browserToolbar: some View {
        HStack(spacing: 8) {
            navigationButtons
            addressBar
            toolbarActions
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(tc.surface0)
    }

    private var navigationButtons: some View {
        HStack(spacing: 4) {
            Button { controller.goBack() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!controller.canGoBack)
            .opacity(controller.canGoBack ? 1 : 0.35)
            .help("Back")

            Button { controller.goForward() } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!controller.canGoForward)
            .opacity(controller.canGoForward ? 1 : 0.35)
            .help("Forward")

            if controller.isLoading {
                Button { controller.stopLoading() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Stop")
            } else {
                Button { controller.reload() } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Reload")
            }
        }
    }

    private var addressBar: some View {
        HStack(spacing: 6) {
            if controller.isSecure {
                Image(systemName: "lock.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(tc.tertiaryText)
            }
            TextField("Search or enter URL", text: $addressBarText)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .onSubmit {
                    controller.load(urlString: addressBarText)
                }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(tc.surface1.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .onChange(of: controller.currentURLString) { _, newURL in
            if let newURL {
                addressBarText = newURL
            }
        }
    }

    private var toolbarActions: some View {
        HStack(spacing: 2) {
            Button {
                controller.openInDefaultBrowser()
            } label: {
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 11))
                    .frame(width: 26, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(tc.secondaryText)
            .help("Open in Browser")

            Menu {
                Button { adjustZoom(by: 0.1) } label: {
                    Label("Zoom In", systemImage: "plus.magnifyingglass")
                }
                Button { adjustZoom(by: -0.1) } label: {
                    Label("Zoom Out", systemImage: "minus.magnifyingglass")
                }
                Button { controller.webView.pageZoom = 1.0 } label: {
                    Label("Reset Zoom", systemImage: "1.magnifyingglass")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 26, height: 24)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .frame(width: 26)
            .foregroundStyle(tc.secondaryText)
            .help("More")
        }
    }

    // MARK: - Progress Bar

    @ViewBuilder
    private var progressBar: some View {
        if controller.isLoading {
            GeometryReader { geo in
                Rectangle()
                    .fill(tc.accent)
                    .frame(width: geo.size.width * controller.estimatedProgress, height: 2)
                    .animation(.linear(duration: 0.2), value: controller.estimatedProgress)
            }
            .frame(height: 2)
        }
    }

    // MARK: - Error Banner

    @ViewBuilder
    private var errorBanner: some View {
        if let error = controller.navigationError {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.system(size: 10))
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(tc.secondaryText)
                    .lineLimit(1)
                Spacer()
                Button {
                    controller.reload()
                } label: {
                    Text("Retry")
                        .font(.system(size: 10, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                Button {
                    controller.navigationError = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tc.surface1)
        }
    }

    // MARK: - WebView Content

    private var webViewContent: some View {
        WebViewRepresentable(webView: controller.webView)
    }

    // MARK: - Helpers

    private func adjustZoom(by delta: CGFloat) {
        let current = controller.webView.pageZoom
        controller.webView.pageZoom = max(0.5, min(3.0, current + delta))
    }
}

// MARK: - NSViewRepresentable wrapper for WKWebView

struct WebViewRepresentable: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView {
        webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        // WebView is managed by BrowserController — no updates needed here
    }
}
