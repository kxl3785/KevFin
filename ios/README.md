# KevFin for iOS

A native SwiftUI companion app for the self-hosted [KevFin](../README.md)
net-worth tracker. It connects to your KevFin server's `/api` endpoints and
shows your net worth over time and your current accounts — read-only for now.

This is a **starter scaffold** meant to be opened and continued in Xcode on a
Mac. It builds and runs in the Simulator as-is.

## Requirements

- macOS with **Xcode 16** or newer
- iOS **17.0+** deployment target (uses Swift Charts and the Observation
  framework's `@Observable`)
- A running KevFin server reachable from your Mac / device

## Open & run

```bash
cd ios
open KevFin.xcodeproj
```

Then in Xcode: pick an iPhone Simulator and press **⌘R**. On first launch, go
to the **Settings** tab and enter your server's base URL, e.g.
`http://192.168.1.50:3001` (the default KevFin port is `3001`). The Dashboard
and Accounts tabs populate from there.

> The project uses Xcode's modern *file-system synchronized groups*, so any
> `.swift` file you drop into the `KevFin/` folder is picked up automatically —
> no need to manually add it to the target.

## What's wired up

| Screen | Source | KevFin endpoint |
| --- | --- | --- |
| Dashboard (net-worth chart + range picker) | `Views/DashboardView.swift`, `Views/NetWorthChart.swift` | `GET /api/net-worth/history` |
| Accounts (grouped by institution + real estate) | `Views/AccountsView.swift` | `GET /api/net-worth/breakdown` |
| Settings (server URL) | `Views/SettingsView.swift` | — |

Layout:

```
KevFin/
  KevFinApp.swift            App entry point (@main)
  Models/                    Codable types mirroring the API responses
  Services/
    APIClient.swift          Async URLSession wrapper over /api
    AppSettings.swift        Server URL, persisted in UserDefaults
  ViewModels/
    DashboardViewModel.swift @Observable loader for history + breakdown
  Views/                     SwiftUI screens and shared components
  Assets.xcassets/           App icon slot + accent color
  Info.plist                 Allows local-network (LAN/http) connections
```

## Networking notes

KevFin is typically self-hosted on a LAN over plain `http`. `Info.plist`
enables `NSAllowsLocalNetworking` so App Transport Security permits those
connections while still protecting public-internet traffic. If you reach your
server by a non-`.local` hostname or raw IP and hit an ATS error, add an
`NSExceptionDomains` entry for that host.

KevFin has **no authentication layer**, so the app makes unauthenticated
requests — keep the server on your LAN or behind a VPN (e.g. Tailscale). If you
later front it with an authenticating proxy, add the headers in
`APIClient.get(_:as:)`.

## Good next steps

- Add the **Budget** tab (`GET /api/budget`, `GET /api/budget/cashflow`).
- Add the **Forecast** view (`GET /api/net-worth/tax-buckets`,
  `GET /api/meta/assumptions`).
- Add a real app icon (drop images into `Assets.xcassets/AppIcon.appiconset`).
- Pull-to-refresh is wired; consider a background refresh + a widget.

## Publishing to the App Store

Code lives here; shipping happens on your Mac:

1. Join the **Apple Developer Program** ($99/yr).
2. In Xcode, set a unique **Bundle Identifier** (currently `com.kevfin.app`)
   and select your team under **Signing & Capabilities**.
3. **Product → Archive**, then distribute via the Organizer to **App Store
   Connect**.
4. Fill in the listing in App Store Connect and submit for review.

   Note: an App Store build that talks only to a user's private LAN server
   needs a clear story for the reviewer (e.g. a demo server or a documented
   setup), since reviewers must be able to exercise the app.
