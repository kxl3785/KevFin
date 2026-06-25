import Foundation

/// One daily net-worth snapshot, matching `GET /api/net-worth/history`.
/// The server returns snake_case keys; the decoder is configured with
/// `.convertFromSnakeCase` (see `APIClient`), so the property names here are
/// the camelCase equivalents.
struct NetWorthPoint: Decodable, Identifiable {
    let date: String
    let accountsTotal: Double
    let realEstateTotal: Double
    let netWorth: Double

    /// The series is keyed by date, which is unique per snapshot.
    var id: String { date }

    /// `date` arrives as an ISO `yyyy-MM-dd` string; parse it lazily for charting.
    var day: Date? { NetWorthPoint.formatter.date(from: date) }

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}
