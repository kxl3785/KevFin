import Foundation

/// Current asset breakdown, matching `GET /api/net-worth/breakdown`.
struct Breakdown: Decodable {
    let accounts: [Account]
    let manualAssets: [ManualAsset]
    let properties: [Property]
}

struct Account: Decodable, Identifiable {
    let id: Int
    let orgName: String?
    let name: String
    let balance: Double
    let currency: String?
    let category: String?
    let hidden: Bool?

    /// SQLite serializes booleans as 0/1, so decode `hidden` leniently.
    enum CodingKeys: String, CodingKey {
        case id, orgName, name, balance, currency, category, hidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        orgName = try c.decodeIfPresent(String.self, forKey: .orgName)
        name = try c.decode(String.self, forKey: .name)
        balance = try c.decode(Double.self, forKey: .balance)
        currency = try c.decodeIfPresent(String.self, forKey: .currency)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        hidden = (try? c.decodeIfPresent(Int.self, forKey: .hidden)).map { ($0 ?? 0) != 0 }
    }
}

struct ManualAsset: Decodable, Identifiable {
    let id: Int
    let name: String
    let category: String?
    let value: Double
}

struct Property: Decodable, Identifiable {
    let id: Int
    let address: String
    let zestimate: Double?
    let mortgageBalance: Double?

    /// Estimated equity in the property, when both figures are present.
    var equity: Double? {
        guard let zestimate else { return nil }
        return zestimate - (mortgageBalance ?? 0)
    }
}
