import Foundation

/// Investable balances grouped into tax buckets, matching
/// `GET /api/net-worth/tax-buckets`. These are the starting pools the KevFin
/// web app feeds into its Monte Carlo retirement model.
struct TaxBuckets: Decodable {
    let buckets: [String]
    let totals: [String: Double]
    let accounts: [TaxAccount]

    /// Total investable assets across every bucket.
    var grandTotal: Double { totals.values.reduce(0, +) }

    /// Buckets in the server's canonical order, paired with their totals.
    var orderedTotals: [(bucket: String, total: Double)] {
        buckets.map { (bucket: $0, total: totals[$0] ?? 0) }
    }
}

struct TaxAccount: Decodable, Identifiable {
    let id: String
    let name: String
    let orgName: String?
    let balance: Double
    let bucket: String

    enum CodingKeys: String, CodingKey { case id, name, orgName, balance, bucket }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The account id may serialize as a number or a string depending on the
        // SQLite column type — accept either.
        if let intID = try? c.decode(Int.self, forKey: .id) {
            id = String(intID)
        } else {
            id = try c.decode(String.self, forKey: .id)
        }
        name = try c.decode(String.self, forKey: .name)
        orgName = try c.decodeIfPresent(String.self, forKey: .orgName)
        balance = try c.decode(Double.self, forKey: .balance)
        bucket = try c.decode(String.self, forKey: .bucket)
    }
}

/// Trailing spending/income averages, matching `GET /api/budget/projection`.
struct SpendingProjection: Decodable {
    let monthsAnalyzed: Int
    let avgMonthlySpending: Double
    let avgMonthlyIncome: Double
    let trendPctPerYear: Double

    var avgAnnualSpending: Double { avgMonthlySpending * 12 }
    var avgAnnualIncome: Double { avgMonthlyIncome * 12 }
    /// Estimated annual savings (income minus spending), floored at zero.
    var estimatedAnnualSavings: Double { max(0, (avgMonthlyIncome - avgMonthlySpending) * 12) }
}

/// Human-friendly labels for the raw bucket keys returned by the API.
enum BucketLabel {
    static func display(_ key: String) -> String {
        switch key {
        case "taxable": return "Taxable"
        case "pretax":  return "Pre-tax"
        case "roth":    return "Roth"
        case "hsa":     return "HSA"
        case "college": return "College"
        default:        return key.capitalized
        }
    }
}
