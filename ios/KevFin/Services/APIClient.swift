import Foundation

/// A thin async wrapper over the KevFin REST API (`/api/*`).
///
/// KevFin has no authentication layer (it's meant to live on a LAN / behind a
/// VPN), so requests are unauthenticated. Add headers here if you later put it
/// behind a reverse proxy that requires them.
struct APIClient {
    let baseURL: URL

    enum APIError: LocalizedError {
        case badStatus(Int)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .badStatus(let code): return "Server returned HTTP \(code)."
            case .invalidResponse:     return "The server response wasn't valid."
            }
        }
    }

    /// `GET /api/net-worth/history` — full daily series (server defaults to the
    /// whole history; we slice client-side for the selected range).
    func netWorthHistory() async throws -> [NetWorthPoint] {
        try await get("/api/net-worth/history", as: [NetWorthPoint].self)
    }

    /// `GET /api/net-worth/breakdown` — current accounts, manual assets, properties.
    func breakdown() async throws -> Breakdown {
        try await get("/api/net-worth/breakdown", as: Breakdown.self)
    }

    /// `GET /api/budget` — current-month budget summary (newest month by default).
    func budget() async throws -> BudgetSummary {
        try await get("/api/budget", as: BudgetSummary.self)
    }

    /// `GET /api/allocation` — portfolio allocation by asset class and sector.
    func allocation() async throws -> Allocation {
        try await get("/api/allocation", as: Allocation.self)
    }

    /// `GET /api/net-worth/tax-buckets` — investable balances grouped into tax
    /// buckets (taxable / pre-tax / Roth / HSA / college) — the Forecast pools.
    func taxBuckets() async throws -> TaxBuckets {
        try await get("/api/net-worth/tax-buckets", as: TaxBuckets.self)
    }

    /// `GET /api/budget/projection` — trailing spending/income averages and the
    /// annualized spending trend, derived from recent transactions.
    func spendingProjection() async throws -> SpendingProjection {
        try await get("/api/budget/projection", as: SpendingProjection.self)
    }

    // MARK: - Internals

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badStatus(http.statusCode) }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }
}
