import Foundation
import Observation

@Observable
final class BudgetViewModel {
    enum LoadState: Equatable {
        case idle, loading, loaded, failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var summary: BudgetSummary?

    /// Categories with actual spending this month, biggest first, excluding the
    /// flagged "excluded" rows (e.g. the mortgage line) which aren't spending.
    var spendingCategories: [BudgetCategory] {
        (summary?.byCategory ?? [])
            .filter { !($0.excluded ?? false) && ($0.effectiveSpent > 0 || $0.hasTarget) }
    }

    @MainActor
    func load(using baseURL: URL) async {
        state = .loading
        do {
            summary = try await APIClient(baseURL: baseURL).budget()
            state = .loaded
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
