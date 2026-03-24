import SwiftUI

/// Tile view that shows pending checkpoints and review requests for a session,
/// with approve/reject actions for workflow supervision.
struct WorkflowTileView: View {
    let sessionName: String
    let baseURL: URL

    @Environment(\.themeColors) private var tc
    @State private var checkpoints: [Checkpoint] = []
    @State private var reviews: [ReviewRequest] = []
    @State private var isLoading = true
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Image(systemName: "checkmark.shield")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tc.accent)
                Text("Workflow")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tc.primaryText)
                Spacer()
                if pendingCount > 0 {
                    Text("\(pendingCount)")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(.orange))
                }
                Button {
                    Task { await loadData() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10))
                        .foregroundStyle(tc.tertiaryText)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(tc.surface1)

            Divider().background(tc.divider)

            // Content
            if isLoading {
                VStack {
                    ProgressView().controlSize(.small)
                    Text("Loading...")
                        .font(.caption2)
                        .foregroundStyle(tc.tertiaryText)
                }
                .frame(maxWidth: .infinity, minHeight: 100)
            } else if let error {
                VStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.yellow)
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(tc.secondaryText)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, minHeight: 100)
                .padding(.horizontal, 12)
            } else if checkpoints.isEmpty && reviews.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "checkmark.circle")
                        .font(.title3)
                        .foregroundStyle(tc.accent.opacity(0.4))
                    Text("No pending items")
                        .font(.caption)
                        .foregroundStyle(tc.tertiaryText)
                }
                .frame(maxWidth: .infinity, minHeight: 100)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        if !pendingCheckpoints.isEmpty {
                            sectionHeader("CHECKPOINTS", count: pendingCheckpoints.count)
                            ForEach(pendingCheckpoints) { cp in
                                CheckpointRow(checkpoint: cp, sessionName: sessionName, baseURL: baseURL) {
                                    Task { await loadData() }
                                }
                            }
                        }

                        if !openReviews.isEmpty {
                            if !pendingCheckpoints.isEmpty {
                                Divider().background(tc.divider).padding(.vertical, 4)
                            }
                            sectionHeader("REVIEWS", count: openReviews.count)
                            ForEach(openReviews) { review in
                                ReviewRow(review: review, sessionName: sessionName, baseURL: baseURL) {
                                    Task { await loadData() }
                                }
                            }
                        }
                    }
                    .padding(10)
                }
            }
        }
        .background(tc.surface0)
        .task { await loadData() }
    }

    // MARK: - Data

    private var pendingCheckpoints: [Checkpoint] {
        checkpoints.filter { $0.status == "pending" }
    }

    private var openReviews: [ReviewRequest] {
        reviews.filter { $0.status == "open" }
    }

    private var pendingCount: Int {
        pendingCheckpoints.count + openReviews.count
    }

    private func loadData() async {
        isLoading = true
        error = nil
        let client = CommandCenterClient(target: .localhost)
        do {
            async let cps = client.fetchCheckpoints(session: sessionName)
            async let rvs = client.fetchReviews(session: sessionName)
            checkpoints = try await cps
            reviews = try await rvs
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Section Header

    @ViewBuilder
    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .tracking(0.8)
                .foregroundStyle(tc.mutedText)
            Text("\(count)")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(tc.mutedText)
        }
        .padding(.bottom, 2)
    }
}

// MARK: - Checkpoint Row

private struct CheckpointRow: View {
    @Environment(\.themeColors) private var tc
    let checkpoint: Checkpoint
    let sessionName: String
    let baseURL: URL
    let onAction: () -> Void

    @State private var isActing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(.orange)
                    .frame(width: 6, height: 6)
                Text(checkpoint.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(tc.primaryText)
                    .lineLimit(1)
                Spacer()
                Text("T-\(checkpoint.taskId)")
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .foregroundStyle(tc.tertiaryText)
            }

            if !checkpoint.description.isEmpty {
                Text(checkpoint.description)
                    .font(.system(size: 10))
                    .foregroundStyle(tc.secondaryText)
                    .lineLimit(2)
            }

            if !checkpoint.files.isEmpty {
                Text("\(checkpoint.files.count) file\(checkpoint.files.count == 1 ? "" : "s") changed")
                    .font(.system(size: 9))
                    .foregroundStyle(tc.tertiaryText)
            }

            // Action buttons
            HStack(spacing: 8) {
                Button {
                    Task { await approve() }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "checkmark")
                        Text("Approve")
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(.green.opacity(0.8)))
                }
                .buttonStyle(.plain)
                .disabled(isActing)

                Button {
                    Task { await reject() }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "xmark")
                        Text("Reject")
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(tc.primaryText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().strokeBorder(tc.divider))
                }
                .buttonStyle(.plain)
                .disabled(isActing)

                Spacer()
            }
            .padding(.top, 2)
        }
        .padding(8)
        .background(tc.surface1.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }

    private func approve() async {
        isActing = true
        let client = CommandCenterClient(target: .localhost)
        _ = try? await client.updateCheckpoint(session: sessionName, id: checkpoint.id, status: "approved", reviewedBy: "user")
        isActing = false
        onAction()
    }

    private func reject() async {
        isActing = true
        let client = CommandCenterClient(target: .localhost)
        _ = try? await client.updateCheckpoint(session: sessionName, id: checkpoint.id, status: "rejected", reviewedBy: "user")
        isActing = false
        onAction()
    }
}

// MARK: - Review Row

private struct ReviewRow: View {
    @Environment(\.themeColors) private var tc
    let review: ReviewRequest
    let sessionName: String
    let baseURL: URL
    let onAction: () -> Void

    @State private var isActing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(.blue)
                    .frame(width: 6, height: 6)
                Text(review.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(tc.primaryText)
                    .lineLimit(1)
                Spacer()
                Text("T-\(review.taskId)")
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .foregroundStyle(tc.tertiaryText)
            }

            if !review.description.isEmpty {
                Text(review.description)
                    .font(.system(size: 10))
                    .foregroundStyle(tc.secondaryText)
                    .lineLimit(2)
            }

            Text("by \(review.requestedBy.isEmpty ? "unknown" : review.requestedBy)")
                .font(.system(size: 9))
                .foregroundStyle(tc.tertiaryText)

            if !review.comments.isEmpty {
                Text("\(review.comments.count) comment\(review.comments.count == 1 ? "" : "s")")
                    .font(.system(size: 9))
                    .foregroundStyle(tc.tertiaryText)
            }

            // Action buttons
            HStack(spacing: 8) {
                Button {
                    Task { await approve() }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "checkmark")
                        Text("Approve")
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(.green.opacity(0.8)))
                }
                .buttonStyle(.plain)
                .disabled(isActing)

                Button {
                    Task { await requestChanges() }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text("Changes")
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(tc.primaryText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().strokeBorder(tc.divider))
                }
                .buttonStyle(.plain)
                .disabled(isActing)

                Spacer()
            }
            .padding(.top, 2)
        }
        .padding(8)
        .background(tc.surface1.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }

    private func approve() async {
        isActing = true
        let client = CommandCenterClient(target: .localhost)
        _ = try? await client.updateReview(session: sessionName, id: review.id, status: "approved")
        isActing = false
        onAction()
    }

    private func requestChanges() async {
        isActing = true
        let client = CommandCenterClient(target: .localhost)
        _ = try? await client.updateReview(session: sessionName, id: review.id, status: "changes-requested")
        isActing = false
        onAction()
    }
}
