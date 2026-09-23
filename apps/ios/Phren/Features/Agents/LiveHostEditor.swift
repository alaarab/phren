import PhrenKit
import PhrenLive
import SwiftUI

struct LiveHostEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.liveSessionPreferences) private var preferencesStore
    var existing: LiveHost?
    @State private var id = UUID()
    @State private var name = ""
    @State private var address = ""
    @State private var port = "22"
    @State private var username = ""
    @State private var herdrSession = ""
    @State private var selectedColor: String?
    @State private var colorHex = ""
    @State private var key = ""
    @State private var error: String?
    @State private var saved = false
    @State private var removing = false
    @State private var copied = false
    @State private var showingColor = false

    private let colorNames = ["Blue", "Teal", "Green", "Amber", "Orange", "Pink", "Lavender", "Slate"]
    private var displayedColor: String { selectedColor ?? existing?.color ?? LiveHost.defaultColor(for: id) }

    var body: some View {
        PhrenForm {
            Section {
                Text(name.isEmpty ? (existing?.name ?? "Computer") : name)
                    .font(.title3).fontWeight(.medium)
                    .foregroundStyle(PhrenTheme.hostColor(displayedColor))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Section("Color") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(Array(LiveHost.colorPalette.enumerated()), id: \.element) { index, hex in
                            Button { chooseColor(hex) } label: {
                                ZStack {
                                    Circle().fill(PhrenTheme.hostColor(hex)).frame(width: 28, height: 28)
                                    if displayedColor == hex {
                                        Circle().stroke(PhrenTheme.text, lineWidth: 2).frame(width: 34, height: 34)
                                    }
                                }
                                .frame(width: 36, height: 36)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(colorNames[index])
                            .accessibilityIdentifier("host-color:\(hex)")
                        }
                    }
                }
                HStack(spacing: 12) {
                    PhrenColorButton(title: "Custom", color: PhrenTheme.hostColor(displayedColor),
                                     identifier: "host-color-custom") { showingColor = true }
                    Spacer(minLength: PhrenTheme.Space.small)
                    HStack(spacing: 1) {
                        Text("#").foregroundStyle(PhrenTheme.textDim)
                        PhrenTextField("RRGGBB", text: $colorHex, identifier: "host-color-hex",
                                       monospaced: true, surface: .bare)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .frame(width: 80)
                    }
                    .font(.system(.caption, design: .monospaced))
                }
                .padding(.vertical, 4)
            }
            Section("SSH computer") {
                PhrenTextField("Name", text: $name, identifier: "live-host-name", surface: .bare)
                PhrenTextField("Tailscale hostname or IP", text: $address, identifier: "live-host-address", surface: .bare)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(existing != nil)
                PhrenTextField("SSH port", text: $port, identifier: "live-host-port", surface: .bare)
                    .keyboardType(.numberPad).disabled(existing != nil)
                PhrenTextField("SSH username", text: $username, identifier: "live-host-username", surface: .bare)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(existing != nil)
                if existing != nil {
                    Text("To change the SSH destination or user, add another computer.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Authorize this iPhone") {
                Text("Create a device key, then add the copied line to ~/.ssh/authorized_keys for this user on the computer. The line permits Phren Hook, Herdr terminals, and local web previews. Run phren bridge install on this computer first. For an older connection, replace its existing phren-iphone line with this one.")
                    .font(.callout).foregroundStyle(.secondary)
                Link("Install Phren Hook on this computer", destination: URL(string: "https://alaarab.github.io/phren/phren-hook.html")!)
                    .font(.callout)
                if key.isEmpty {
                    Button("Create device key") { createKey() }
                } else {
                    Button(copied ? "Copied SSH authorization line" : "Copy SSH authorization line", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = key
                        copied = true
                    }
                    ShareLink("Share SSH authorization line", item: key)
                }
                if let fingerprint = existing?.fingerprint {
                    Text("Trusted host: \(fingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                }
                Text("The private key stays on this iPhone. Phren connects to existing Herdr sessions for status and agent chat.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Herdr server") {
                PhrenTextField("default", text: $herdrSession, identifier: "live-host-herdr-server", surface: .bare)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("Leave empty for the default server, or enter a named Herdr server on this computer.").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Section { Text(error).foregroundStyle(.orange) } }
            if existing != nil {
                Section {
                    Button("Forget computer", role: .destructive) { removing = true }
                    Text("Also remove this iPhone's public key from authorized_keys on the computer to revoke its access there.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(existing == nil ? "Add computer" : "Connection settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }.disabled(key.isEmpty)
            }
        }
        .phrenScreen()
        .phrenColorSheet(isPresented: $showingColor, title: "Computer color", selection: Binding(get: {
            PhrenTheme.hostColor(displayedColor)
        }, set: { color in
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
            func channel(_ component: CGFloat) -> Int { Int((min(1, max(0, component)) * 255).rounded()) }
            chooseColor(String(format: "#%02X%02X%02X", channel(red), channel(green), channel(blue)))
        }), identifier: "host-color-editor")
        .onAppear {
            if let existing {
                id = existing.id; name = existing.name; address = existing.address
                port = String(existing.port); username = existing.username
                herdrSession = existing.herdrSession ?? ""
                createKey()
            }
            colorHex = String(displayedColor.dropFirst())
        }
        .onChange(of: colorHex) { _, raw in
            guard raw.range(of: #"^[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil else { return }
            let normalized = raw.uppercased()
            guard raw == normalized else { colorHex = normalized; return }
            guard displayedColor != "#\(normalized)" else { return }
            chooseColor("#\(normalized)")
        }
        .onDisappear {
            if existing == nil && !saved { try? DeviceSSHKey.delete(id) }
        }
        .phrenDialog(
            isPresented: $removing,
            title: "Forget this computer and delete its SSH key from this iPhone?",
            message: "Phren stops connecting to it and removes the saved key. Remove the public key on the computer to revoke access there.",
            actions: [
                .init(id: "forget", title: "Forget computer", role: .destructive) { forget() },
                .init(id: "cancel", title: "Cancel", role: .cancel) {},
            ],
            identifier: "live-host-forget-dialog"
        )
    }

    private func forget() {
        Task { @MainActor in
            do {
                let next = try LiveSessionPreferences.removing(id, from: preferencesStore.data)
                try await SessionOverviewDiskCache.shared.purge(forgetting: id)
                try DeviceSSHKey.delete(id)
                preferencesStore.write(next)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func createKey() {
        do { key = try DeviceSSHKey.publicKey(id) }
        catch { self.error = error.localizedDescription }
    }
    private func chooseColor(_ color: String) {
        colorHex = String(color.dropFirst())
        guard existing != nil else { selectedColor = color; return }
        do {
            try preferencesStore.update { try LiveSessionPreferences.settingColor(hostID: id, color: color, in: $0) }
            selectedColor = color
        }
        catch { self.error = error.localizedDescription }
    }
    private func save() {
        do {
            let host = try LiveHost(id: id, name: name, address: address, port: Int(port) ?? 0,
                                   username: username, hookComputerID: existing?.hookComputerID,
                                   fingerprint: existing?.fingerprint,
                                   herdrSession: herdrSession.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : herdrSession.trimmingCharacters(in: .whitespacesAndNewlines),
                                   color: selectedColor ?? existing?.color)
            try preferencesStore.update { try LiveSessionPreferences.saving(host, in: $0) }
            saved = true
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
