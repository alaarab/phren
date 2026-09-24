package com.phren.kit.live

/** A Hook route's refusal naming the running conductor (LiveLaunchConflictTarget). */
data class LiveLaunchConflictTarget(val server: String?, val workspaceID: String, val tabID: String, val paneID: String?, val source: String?)

/** Transport failures (PhrenConnection.swift LiveConnectionError), with the iPhone's wording. */
sealed class LiveConnectionError(message: String) : Exception(message) {
    class UntrustedHost(val fingerprint: String) : LiveConnectionError("Verify this computer's SSH fingerprint before connecting.")
    class ChangedHost : LiveConnectionError("This computer's SSH host key has changed. The connection was stopped. Verify the computer before removing and adding this connection again.")
    class Authentication : LiveConnectionError("SSH did not accept this device's key. Add the public key to the selected user's authorized_keys file and enable Remote Login or SSH.")
    class Timeout : LiveConnectionError("The connection timed out. Check Tailscale and SSH, then run phren bridge doctor on the computer.")
    class Disconnected : LiveConnectionError("The connection to the computer closed.")
    class Ssh(detail: String) : LiveConnectionError(detail)
    class Response(val status: Int) : LiveConnectionError("The computer returned HTTP $status.")
    class GatewayRejection(val status: Int, val reason: String) : LiveConnectionError("$reason (HTTP $status)")
    class LaunchConflict(val reason: String, val target: LiveLaunchConflictTarget?) : LiveConnectionError("$reason (HTTP 409)")
    class Oversized : LiveConnectionError("The Phren Hook response exceeded this request's size limit.")
    class DeliveryUnconfirmed : LiveConnectionError("The computer did not confirm message delivery.")

    /** Failures that say the shared connection itself may be gone. */
    val retiresConnection: Boolean get() = this is Timeout || this is Disconnected || this is Ssh
}
