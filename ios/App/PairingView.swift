// Pairing: pick the computer, type the six digits it is showing.
//
// Two ways in, because discovery is allowed to fail. Bonjour finds the
// computer by name when the network cooperates; when it does not — a guest
// network with multicast off, a responder that could not take port 5353 —
// the address the desktop panel prints is typed instead. Neither path is a
// fallback bolted on: the desktop panel changes its own wording to match.
import SwiftUI
import CompanionCore
#if canImport(UIKit)
import UIKit
#endif

struct PairingView: View {
    @EnvironmentObject private var session: Session
    @StateObject private var discovery = Discovery()

    @State private var manualAddress = ""
    @State private var code = ""
    @State private var chosen: Connection?
    @State private var pairing = false
    @State private var failure: String?
    /// "Looking…" forever is not an answer. After a few seconds with nothing
    /// found, say the thing that is almost always true.
    @State private var searchedLongEnough = false

    var body: some View {
        NavigationStack {
            Form {
                if let chosen {
                    codeSection(for: chosen)
                } else {
                    discoverySection
                    manualSection
                }

                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                    }
                }

                Section {
                    Text("On your computer, open OpenMausBot → Settings → Companion, turn it on, and start pairing.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Pair with a computer")
            .onAppear { discovery.start() }
            .onDisappear { discovery.stop() }
            .task {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                searchedLongEnough = true
            }
        }
    }

    // MARK: - Choosing a computer

    private var discoverySection: some View {
        Section("On this network") {
            if let problem = discovery.failure {
                Label(problem, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if discovery.found.isEmpty {
                HStack {
                    ProgressView()
                    Text("Looking…").foregroundStyle(.secondary)
                }
                if searchedLongEnough {
                    // Bonjour is multicast: it does not cross subnets, and
                    // guest networks usually block it between clients even
                    // within one. Different Wi-Fi on the two devices is by
                    // far the most common reason this list stays empty.
                    Text("Nothing found yet. Check that this phone and your computer are on the same Wi-Fi network — a guest network often blocks them from seeing each other. You can always enter the address below instead.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    // The honest answer when a network refuses to cooperate.
                    // Tailscale sidesteps the whole problem: both devices get
                    // an address on a private network of your own, and it
                    // does not care which Wi-Fi either of them is on.
                    Text("If it never appears, install Tailscale on both and sign in to the same account — the Companion panel will then show a name ending in .ts.net to enter below.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(discovery.found) { service in
                Button {
                    Task { await choose(service) }
                } label: {
                    Label(service.name, systemImage: "desktopcomputer")
                }
            }
        }
    }

    private var manualSection: some View {
        Section {
            TextField("192.168.1.42:8810", text: $manualAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            Button("Continue") {
                failure = nil
                guard let connection = Self.parse(manualAddress) else {
                    failure = "That should look like 192.168.1.42:8810."
                    return
                }
                chosen = connection
            }
            .disabled(manualAddress.trimmingCharacters(in: .whitespaces).isEmpty)
        } header: {
            Text("Or enter the address")
        } footer: {
            Text("Whatever the Companion panel shows — an address on this network, or a Tailscale name like macbook.tail1234.ts.net:8810, which works from anywhere.")
        }
    }

    private func choose(_ service: Discovery.Found) async {
        failure = nil
        do {
            chosen = try await discovery.resolve(service)
        } catch {
            failure = error.localizedDescription
        }
    }

    // MARK: - The code

    private func codeSection(for connection: Connection) -> some View {
        Section(connection.name) {
            TextField("000000", text: $code)
                .keyboardType(.numberPad)
                .font(.system(.title, design: .monospaced))
                .multilineTextAlignment(.center)
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                }

            Button {
                Task { await submit(connection) }
            } label: {
                if pairing {
                    ProgressView()
                } else {
                    Text("Pair")
                }
            }
            .disabled(code.count != 6 || pairing)

            Button("Choose a different computer", role: .cancel) {
                chosen = nil
                code = ""
                failure = nil
            }
        }
    }

    private func submit(_ connection: Connection) async {
        pairing = true
        failure = nil
        defer { pairing = false }
        do {
            try await session.pair(with: connection, code: code, deviceName: Self.deviceName())
        } catch {
            // the harness's own wording ("that code is not right", "too many
            // incorrect codes — start pairing again") is better than ours
            failure = error.localizedDescription
            code = ""
        }
    }

    // MARK: - Helpers

    static func deviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return "Companion"
        #endif
    }

    /// "192.168.1.42:8810", or a bare host on the default companion port.
    static func parse(_ text: String) -> Connection? {
        // 8810 is the companion's default. It is not 8800, which is the
        // harness's webhook receiver — a bare hostname sent there would get
        // a 404 from a server that is not this one.
        Connection.parse(text)
    }
}
