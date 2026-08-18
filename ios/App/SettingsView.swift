// What little the phone gets to configure.
//
// Almost nothing, on purpose: companion settings, API keys and pairing all
// live on the computer, because losing the phone must not mean losing the
// ability to lock it out. This is a status page with an unpair button.
import SwiftUI
import CompanionCore

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var confirmingSignOut = false

    var body: some View {
        Form {
            Section("Computer") {
                if let connection = session.connection {
                    LabeledContent("Name", value: connection.name)
                    LabeledContent("Address", value: "\(connection.host):\(connection.port)")
                }
                LabeledContent("Connection", value: statusText)
            }

            Section {
                Button("Unpair this phone", role: .destructive) { confirmingSignOut = true }
            } footer: {
                Text("Removes the pairing from this phone only. To stop it reaching the computer at all, remove the device in OpenMausBot → Settings → Companion.")
            }

            Section("Not here") {
                Text("API keys, pairing and the Local VM are managed on the computer. This phone is deliberately not allowed to change them.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Unpair this phone?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) { session.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need a new pairing code to connect again.")
        }
    }

    private var statusText: String {
        switch session.status {
        case .live: return "Connected"
        case .connecting: return "Connecting…"
        case .unpaired: return "Not paired"
        case .unauthorized: return "Unpaired on the computer"
        case let .offline(reason): return reason
        }
    }
}
