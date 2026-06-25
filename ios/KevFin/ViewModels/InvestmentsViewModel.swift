import Foundation
import Observation

@Observable
final class InvestmentsViewModel {
    enum LoadState: Equatable {
        case idle, loading, loaded, failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var allocation: Allocation?

    /// Asset-class slices with any value, largest first.
    var assetClasses: [AllocationSlice] {
        (allocation?.byAssetClass ?? []).filter { $0.value > 0 }.sorted { $0.value > $1.value }
    }

    /// Top sector slices (capped so the list stays scannable on a phone).
    var topSectors: [AllocationSlice] {
        (allocation?.bySector ?? []).filter { $0.value > 0 }.sorted { $0.value > $1.value }
    }

    @MainActor
    func load(using baseURL: URL) async {
        state = .loading
        do {
            allocation = try await APIClient(baseURL: baseURL).allocation()
            state = .loaded
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
