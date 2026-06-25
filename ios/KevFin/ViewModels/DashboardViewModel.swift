import Foundation
import Observation

/// Drives the Dashboard and Accounts screens: loads the net-worth history and
/// the current breakdown from the server and exposes derived values for the UI.
@Observable
final class DashboardViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var history: [NetWorthPoint] = []
    private(set) var breakdown: Breakdown?

    /// The most recent net-worth value, if we have any history.
    var currentNetWorth: Double? { history.last?.netWorth }

    /// Change versus the first point in the currently loaded series.
    var changeSinceStart: Double? {
        guard let first = history.first?.netWorth, let last = history.last?.netWorth else { return nil }
        return last - first
    }

    /// Visible accounts grouped by their institution name, for the Accounts list.
    var accountsByInstitution: [(institution: String, accounts: [Account])] {
        let visible = (breakdown?.accounts ?? []).filter { !($0.hidden ?? false) }
        let groups = Dictionary(grouping: visible) { $0.orgName ?? "Other" }
        return groups
            .map { (institution: $0.key, accounts: $0.value.sorted { $0.name < $1.name }) }
            .sorted { $0.institution < $1.institution }
    }

    @MainActor
    func load(using baseURL: URL) async {
        state = .loading
        let client = APIClient(baseURL: baseURL)
        do {
            async let history = client.netWorthHistory()
            async let breakdown = client.breakdown()
            self.history = try await history
            self.breakdown = try await breakdown
            state = .loaded
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
