import Foundation
import Observation

@Observable
final class ForecastViewModel {
    enum LoadState: Equatable {
        case idle, loading, loaded, failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var taxBuckets: TaxBuckets?
    private(set) var projection: SpendingProjection?

    @MainActor
    func load(using baseURL: URL) async {
        state = .loading
        let client = APIClient(baseURL: baseURL)
        do {
            async let buckets = client.taxBuckets()
            // The projection depends on imported transactions and may legitimately
            // be empty; treat its failure as non-fatal so the buckets still show.
            self.taxBuckets = try await buckets
            self.projection = try? await client.spendingProjection()
            state = .loaded
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// A simple deterministic projection of a starting principal compounded
    /// annually with a fixed yearly contribution. This is intentionally *not*
    /// the web app's Monte Carlo model — it's a quick on-device estimate.
    static func project(principal: Double, years: Int, annualReturn: Double, annualContribution: Double) -> Double {
        var value = principal
        for _ in 0..<max(0, years) {
            value = value * (1 + annualReturn) + annualContribution
        }
        return value
    }
}
