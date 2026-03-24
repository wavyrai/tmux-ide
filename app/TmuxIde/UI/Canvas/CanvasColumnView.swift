import SwiftUI

struct CanvasColumnView: View {
    let column: CanvasColumn
    let sessionName: String
    let baseURL: URL

    init(column: CanvasColumn, sessionName: String = "", baseURL: URL = ConnectionTarget.localhost.baseURL) {
        self.column = column
        self.sessionName = sessionName
        self.baseURL = baseURL
    }

    var body: some View {
        VStack(spacing: 8) {
            ForEach(column.items) { item in
                CanvasTileView(item: item, sessionName: sessionName, baseURL: baseURL)
            }
        }
        .frame(minWidth: 300, idealWidth: 400, maxWidth: 600)
    }
}
