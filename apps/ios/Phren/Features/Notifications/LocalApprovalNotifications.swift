import Foundation
import PhrenKit
import UIKit
import UserNotifications

@MainActor
final class LocalApprovalNotifications {
    private struct Record: Codable {
        let id: String
        let hostID: UUID
        let targetID: String
        let workspaceID: String
        let tabID: String
        let expiresAt: Date
    }
    private let center: LocalNotificationCenter
    private let defaults: UserDefaults
    private let enabled: () -> Bool
    private var ledger: ApprovalNotificationLedger
    private var records: [String: Record]
    private var waiting: [String: UNNotificationRequest] = [:]
    private var expiry: Task<Void, Never>?
    private let ledgerKey = "notifications.approval-ledger.v1"
    private let recordsKey = "notifications.approval-records.v1"

    init(center: LocalNotificationCenter, defaults: UserDefaults,
         enabled: @escaping () -> Bool = { LocalNotificationSettings.approvalsEnabled }) {
        self.center = center; self.defaults = defaults
        self.enabled = enabled
        ledger = defaults.data(forKey: ledgerKey).flatMap { try? JSONDecoder().decode(ApprovalNotificationLedger.self, from: $0) } ?? .init()
        records = defaults.data(forKey: recordsKey).flatMap { try? JSONDecoder().decode([String: Record].self, from: $0) } ?? [:]
    }

    func sync(_ approval: AgentApproval?, session: LiveAgentSession, target: AgentChatTarget,
              deliver: Bool, now: Date = .now) async {
        guard !Task.isCancelled else { return }
        retireExpired(now: now)
        let id = approval.map { identifier(hostID: session.host.id, actionID: $0.id) }
        remove(records.values.filter { $0.targetID == target.id && $0.id != id }.map(\.id))
        guard let approval, let id, let expiration = approval.expiration, expiration > now,
              enabled() else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(target.providerName) asks"
        if let question = approval.questionPrompt?.questions.first?.question {
            content.body = question
        } else {
            let title = approval.choice?.title ?? approval.title ?? approval.toolName ?? "Allow this action?"
            var lines = [title]
            if let explanation = approval.explanation, explanation != approval.command,
               explanation != title, explanation != approval.title { lines.append(explanation) }
            if let command = approval.command, command != title { lines.append(command) }
            content.body = lines.joined(separator: "\n")
        }
        content.sound = .default
        // Local alerts always open the current, authenticated chat card.
        content.categoryIdentifier = "PHREN_AGENT_QUESTION"
        content.userInfo = ["localKind": "approval", "hostID": session.host.id.uuidString,
                            "workspaceID": target.workspaceID, "tabID": target.tabID,
                            "muxID": target.muxID, "source": target.source,
                            "label": session.tab.displayTitle, "cwd": session.tab.cwd ?? "/",
                            "expiresAt": expiration.timeIntervalSince1970]
        records[id] = Record(id: id, hostID: session.host.id, targetID: target.id,
                             workspaceID: target.workspaceID, tabID: target.tabID, expiresAt: expiration)
        waiting[id] = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        saveRecords(); scheduleExpiry()
        if deliver { await deliverWaiting(now: now) }
    }

    func deliverWaiting(now: Date = .now) async {
        retireExpired(now: now)
        guard enabled() else { clear(); return }
        for (id, request) in waiting {
            guard !Task.isCancelled else { return }
            guard let record = records[id], ledger.claim(id, expiresAt: record.expiresAt, now: now) else { continue }
            // Persist before crossing the async notification-center boundary.
            defaults.set(try? JSONEncoder().encode(ledger), forKey: ledgerKey)
            try? await center.add(request)
            // An answer or expiry may have arrived while add was suspended.
            if records[id] == nil || record.expiresAt <= .now || !enabled() || Task.isCancelled {
                center.remove([id])
            }
        }
    }

    func answered(hostID: UUID, actionID: String) {
        let id = identifier(hostID: hostID, actionID: actionID)
        _ = ledger.claim(id, expiresAt: .distantFuture, now: .now)
        defaults.set(try? JSONEncoder().encode(ledger), forKey: ledgerKey)
        remove([id])
    }

    func reconcile(host: LiveHost, sessions: [LiveAgentSession]) {
        remove(records.values.filter { record in
            record.hostID == host.id && !sessions.contains {
                $0.workspaceID == record.workspaceID && $0.tab.id == record.tabID && $0.tab.approvalPending == true
            }
        }.map(\.id))
        retireExpired()
    }

    func retainHosts(_ ids: Set<UUID>) { remove(records.values.filter { !ids.contains($0.hostID) }.map(\.id)) }
    func retireExpired(now: Date = .now) { remove(records.values.filter { $0.expiresAt <= now }.map(\.id)) }
    func clear() { remove(Array(records.keys)) }

    private func identifier(hostID: UUID, actionID: String) -> String {
        "local.approval." + LocalNotificationIdentity.digest(hostID.uuidString, actionID)
    }
    private func remove(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        center.remove(ids)
        for id in ids { records.removeValue(forKey: id); waiting.removeValue(forKey: id) }
        saveRecords(); scheduleExpiry()
    }
    private func saveRecords() { defaults.set(try? JSONEncoder().encode(records), forKey: recordsKey) }
    private func scheduleExpiry() {
        expiry?.cancel()
        guard let next = records.values.map(\.expiresAt).min() else { return }
        expiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, next.timeIntervalSinceNow))) } catch { return }
            self?.retireExpired()
        }
    }
}
