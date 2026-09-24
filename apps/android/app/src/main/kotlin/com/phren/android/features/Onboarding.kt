package com.phren.android.features

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.android.design.FormDivider
import com.phren.android.design.FormRow
import com.phren.android.design.FormSection
import com.phren.android.design.LocalDismiss
import com.phren.android.design.PhrenFieldSurface
import com.phren.android.design.PhrenForm
import com.phren.android.design.PhrenMascot
import com.phren.android.design.PhrenNavBar
import com.phren.android.design.PhrenNavScreen
import com.phren.android.design.PhrenSheet
import com.phren.android.design.PhrenTextField
import com.phren.android.design.PhrenTheme
import com.phren.android.design.PhrenType
import com.phren.android.design.PhrenType.bold
import com.phren.android.design.PhrenType.mono
import com.phren.android.design.PhrenType.semibold
import com.phren.android.design.SF
import com.phren.android.design.ToolbarItem
import com.phren.android.design.phrenIdentifier
import com.phren.android.design.plainClickable
import com.phren.kit.DeviceCodeResponse
import com.phren.kit.DeviceFlowAuth
import com.phren.kit.GitHubClient
import com.phren.kit.GitHubError
import com.phren.kit.GitHubRepo
import com.phren.kit.KeychainStore
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** OnboardingFlow.swift: sign in, pick a store, first sync. */
@Composable
fun OnboardingFlow(model: AppModel, isPresented: Boolean = false) {
    val dismiss = LocalDismiss.current
    val done = if (isPresented && dismiss != null) listOf(ToolbarItem(text = "Done", label = "Done", identifier = "onboarding-done", onClick = dismiss)) else emptyList()
    when (model.phase) {
        AppModel.Phase.SIGNED_OUT -> WelcomeView(model, done)
        AppModel.Phase.PICKING_REPO -> RepoPickerView(model, done)
        AppModel.Phase.INITIAL_SYNC -> InitialSyncView(model)
        else -> PhrenNavScreen("Memory", trailing = done) {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically)) {
                CircularProgressIndicator(color = PhrenTheme.textMuted, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
                Text("Loading memory…", style = PhrenType.body, color = PhrenTheme.textMuted)
            }
        }
    }
}

@Composable
private fun WelcomeView(model: AppModel, trailing: List<ToolbarItem>) {
    val context = LocalContext.current
    var showPAT by remember { mutableStateOf(false) }
    var deviceCode by remember { mutableStateOf<DeviceCodeResponse?>(null) }
    var authError by remember { mutableStateOf<String?>(null) }
    var polling by remember { mutableStateOf(false) }
    var authJob by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(Unit) { onDispose { authJob?.cancel() } }

    fun startDeviceFlow() {
        if (polling) return
        authError = null
        if (!DeviceFlowAuth.isConfigured) { authError = "GitHub sign-in isn't set up yet — use a token instead."; return }
        polling = true
        authJob = model.scope.launch {
            try {
                val auth = DeviceFlowAuth()
                val code = auth.requestCode()
                deviceCode = code
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(code.verificationUri))) }
                when (val state = auth.waitForAuthorization(code)) {
                    is DeviceFlowAuth.PollState.Authorized -> model.signIn(state.token, KeychainStore.TokenKind.OAUTH)
                    DeviceFlowAuth.PollState.Expired -> authError = "The code expired — try again."
                    DeviceFlowAuth.PollState.Denied -> authError = "Authorization was denied."
                    else -> {}
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                authError = "Couldn't reach GitHub: ${e.message}"
            } finally {
                polling = false; deviceCode = null
            }
        }
    }

    PhrenNavScreen("Memory", trailing = trailing) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp).padding(bottom = 90.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            PhrenMascot(84.dp, bobbing = false, glow = false, modifier = Modifier.padding(top = 20.dp))
            Text("Connect project memory", style = PhrenType.largeTitle.copy(fontWeight = FontWeight.SemiBold), color = PhrenTheme.text)
            Text("Findings, skills, and tasks — synced with your GitHub repositories.", style = PhrenType.callout, color = PhrenTheme.textMuted)
            Text("Agents and terminals work without GitHub. Connect memory whenever you're ready.", style = PhrenType.footnote, color = PhrenTheme.textMuted)
            model.authenticationMessage?.let { Text(it, style = PhrenType.footnote, color = PhrenTheme.warning) }
            deviceCode?.let { DeviceCodeView(it, polling) }
            authError?.let { Text(it, style = PhrenType.footnote, color = Color(0xFFFF453A)) }
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (DeviceFlowAuth.isConfigured) {
                    WideButton("Sign in with GitHub", SF("person.crop.circle"), prominent = true, enabled = !polling, identifier = "onboarding-device-flow") { startDeviceFlow() }
                }
                WideButton("Connect with a GitHub token", SF("key.fill"), prominent = false, identifier = "onboarding-token-sign-in") {
                    authJob?.cancel(); showPAT = true
                }
            }
            Text("Your sign-in is saved on this device, encrypted with the Android Keystore. Sync goes directly to GitHub.", style = PhrenType.caption, color = PhrenTheme.textDim)
        }
    }
    if (showPAT) PhrenSheet({ showPAT = false }) { PATSignInSheet(model) }
}

/** `.borderedProminent` / `.bordered` at full width. */
@Composable
fun WideButton(title: String, icon: ImageVector?, prominent: Boolean, enabled: Boolean = true, identifier: String? = null, onClick: () -> Unit) {
    val bg = if (prominent) PhrenTheme.accentSolid else PhrenTheme.accent.copy(alpha = 0.15f)
    val fg = if (prominent) Color.White else PhrenTheme.accent
    Row(
        Modifier.fillMaxWidth().heightIn(min = 50.dp).background(if (enabled) bg else bg.copy(alpha = 0.4f), CircleShape)
            .plainClickable(enabled, onClick = onClick).then(if (identifier != null) Modifier.phrenIdentifier(identifier) else Modifier).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = fg, modifier = Modifier.size(18.dp))
        Text(title, style = PhrenType.body.semibold(), color = fg)
    }
}

@Composable
private fun DeviceCodeView(code: DeviceCodeResponse, polling: Boolean) {
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().background(PhrenTheme.surfaceRaised, shape).border(1.dp, PhrenTheme.border, shape).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Enter this code on GitHub:", style = PhrenType.footnote.mono(), color = PhrenTheme.textMuted)
        SelectionContainer { Text(code.userCode, style = PhrenType.title.mono().bold(), color = PhrenTheme.cyan, modifier = Modifier.phrenIdentifier("onboarding-device-code")) }
        if (polling) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CircularProgressIndicator(color = PhrenTheme.textMuted, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
            Text("Waiting for approval…", style = PhrenType.footnote.mono(), color = PhrenTheme.textMuted)
        }
    }
}

@Composable
private fun PATSignInSheet(model: AppModel) {
    val context = LocalContext.current
    val dismiss = LocalDismiss.current ?: {}
    var token by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var validating by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        PhrenNavBar("Token sign-in", inSheet = true,
            leading = listOf(ToolbarItem(text = "Cancel", label = "Cancel", onClick = dismiss)),
            trailing = listOf(ToolbarItem(text = "Sign in", label = "Sign in", bold = true, enabled = token.isNotBlank() && !validating, identifier = "onboarding-token-submit") {
                validating = true
                model.scope.launch {
                    try { model.signIn(token, KeychainStore.TokenKind.PAT); dismiss() }
                    catch (e: Exception) { error = "GitHub rejected that token. Check you pasted all of it and that it hasn't expired." }
                    validating = false
                }
            }))
        PhrenForm {
            FormSection("Personal access token",
                footer = null) {
                FormRow("Create a token on GitHub", titleColor = PhrenTheme.navigation, chevron = false) {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/settings/personal-access-tokens/new")))
                }
                FormDivider(16.dp)
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("github_pat_… or ghp_…", token, { token = it }, identifier = "onboarding-token", monospaced = true, surface = PhrenFieldSurface.BARE, secure = true)
                }
            }
            Text(inlineMarkdown("Create a fine-grained token with **Contents: Read and write** and **Metadata: Read** on your phren store repository. The token is stored only on this device. Under Repository access, select your store repository — a token that can't see it will show only your public repos."),
                style = PhrenType.footnote, color = PhrenTheme.textMuted, modifier = Modifier.padding(start = 17.dp, end = 17.dp, top = 0.dp))
            error?.let { Text(it, style = PhrenType.footnote, color = Color(0xFFFF453A), modifier = Modifier.padding(17.dp)) }
        }
    }
}

@Composable
private fun RepoPickerView(model: AppModel, trailing: List<ToolbarItem>) {
    PhrenNavScreen("Choose your store",
        leading = listOf(ToolbarItem(text = "Sign out", label = "Sign out", identifier = "onboarding-sign-out") { model.scope.launch { model.signOut() } }),
        trailing = trailing) {
        RepoPickerList(model, emptySet(),
            footer = "Pick the GitHub repository that holds your phren store (it contains phren.root.yaml). Set one up on your computer with `phren team init` or `phren store add`.") { repo ->
            model.scope.launch { model.addStore(repo) }
        }
    }
}

/** Repo list with phren-store detection (first run and Settings → Add store). */
@Composable
fun RepoPickerList(
    model: AppModel,
    existingStoreIds: Set<String>,
    footer: String = "Add any repository that holds a phren store (it contains phren.root.yaml).",
    onSelect: (GitHubRepo) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var repos by remember { mutableStateOf<List<GitHubRepo>>(emptyList()) }
    val storeNames = remember { mutableStateListOf<String>() }
    var noAccessCount by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var probing by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var manual by remember { mutableStateOf("") }

    suspend fun load() {
        loading = true; loadError = null; storeNames.clear(); noAccessCount = 0
        try { repos = model.client.listAllRepos(maxPages = 5) } catch (e: Exception) { loadError = e.message; loading = false; return }
        loading = false
        probing = true
        val gate = Semaphore(8)
        repos.map { repo ->
            scope.async {
                when (gate.withPermit { model.client.probeStore(repo) }) {
                    GitHubClient.StoreProbe.IsStore -> storeNames += repo.fullName
                    GitHubClient.StoreProbe.NoAccess -> noAccessCount++
                    else -> {}
                }
            }
        }.awaitAll()
        probing = false
    }
    LaunchedEffect(Unit) { load() }

    val likely = repos.filter { it.fullName in storeNames }
    val others = repos.filter { it.fullName !in storeNames }
    val onlyPublic = !loading && loadError == null && repos.isNotEmpty() && repos.all { !it.isPrivate }
    val noAccessMessage = if (noAccessCount > 0) {
        val subject = if (noAccessCount == 1) "1 repository answers" else "$noAccessCount repositories answer"
        "$subject a permissions error checking for phren.root.yaml — your token can list ${if (noAccessCount == 1) "it" else "them"} but not read contents. Add Contents: Read and write under Repository access on GitHub, then pull to refresh."
    } else null

    @Composable
    fun RepoRow(repo: GitHubRepo, isStore: Boolean) {
        val added = repo.fullName in existingStoreIds
        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).plainClickable(!added) { onSelect(repo) }.phrenIdentifier("repo:${repo.fullName}")
            .padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(repo.fullName, style = PhrenType.body, color = if (added) PhrenTheme.textDim else PhrenTheme.text)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (repo.isPrivate) Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(SF("lock"), null, tint = PhrenTheme.textSecondary, modifier = Modifier.size(11.dp)); Text(" Private", style = PhrenType.caption2, color = PhrenTheme.textSecondary)
                    }
                    if (repo.permissions?.push == false) Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(SF("eye"), null, tint = Color(0xFFFF9F0A), modifier = Modifier.size(11.dp)); Text(" Read-only", style = PhrenType.caption2, color = Color(0xFFFF9F0A))
                    }
                }
            }
            if (added) Icon(SF("checkmark.circle.fill"), null, tint = Color(0xFF30D158), modifier = Modifier.size(20.dp))
            else if (isStore) Icon(SF("brain.head.profile"), null, tint = PhrenTheme.navigation, modifier = Modifier.size(20.dp))
        }
    }

    Refreshable {
        PhrenForm {
            if (likely.isNotEmpty() || probing) FormSection(if (probing) "Phren stores  ·  checking…" else "Phren stores") {
                if (likely.isEmpty()) Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(color = PhrenTheme.textMuted, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                    Text("Checking your repositories for phren stores…", style = PhrenType.body, color = PhrenTheme.text)
                } else likely.forEachIndexed { i, repo -> if (i > 0) FormDivider(16.dp); RepoRow(repo, true) }
            }
            FormSection(if (likely.isEmpty()) "Your repositories" else "Other repositories",
                footer = noAccessMessage ?: if (onlyPublic) "Only public repositories are listed. If your phren store repo is private, your token doesn't have access to it yet — add the repo under Repository access on GitHub, then pull to refresh." else null) {
                if (loading) Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(color = PhrenTheme.textMuted, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Text("Loading repositories…", style = PhrenType.body, color = PhrenTheme.text)
                } else loadError?.let { message ->
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(message, style = PhrenType.footnote, color = Color(0xFFFF453A))
                        Text("Try again", style = PhrenType.body, color = PhrenTheme.navigation, modifier = Modifier.plainClickable { scope.launch { load() } })
                    }
                }
                others.forEachIndexed { i, repo -> if (i > 0 || loading || loadError != null) FormDivider(16.dp); RepoRow(repo, false) }
            }
            FormSection("Or enter a repository directly", footer = error ?: footer) {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    PhrenTextField("owner/repo", manual, { manual = it }, identifier = "onboarding-manual-repo", surface = PhrenFieldSurface.BARE)
                }
                FormDivider(16.dp)
                FormRow("Open", titleColor = if (manual.contains("/")) PhrenTheme.navigation else PhrenTheme.textDim, chevron = false, enabled = manual.contains("/"), identifier = "onboarding-manual-open") {
                    val parts = manual.trim().split("/")
                    if (parts.size != 2) return@FormRow
                    scope.launch {
                        try { onSelect(model.client.repo(parts[0], parts[1])) }
                        catch (e: Exception) {
                            error = if ((e as? GitHubError.Http)?.status == 404 || e.message?.contains("404") == true)
                                "Can't see ${parts[0]}/${parts[1]}. GitHub returns 'not found' for private repositories your token can't read. Give the token access under Repository access on GitHub (Contents: Read and write, Metadata: Read), then try again."
                            else "Couldn't open $manual: ${e.message}"
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InitialSyncView(model: AppModel) {
    Column(Modifier.fillMaxSize().background(PhrenTheme.bg), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)) {
        PhrenMascot(90.dp)
        CircularProgressIndicator(color = PhrenTheme.cyan, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
        Text("Syncing your store…", style = PhrenType.headline.mono(), color = PhrenTheme.text)
        model.storeDescriptors.lastOrNull()?.let { Text(it.id, style = PhrenType.footnote.mono(), color = PhrenTheme.lavender) }
    }
}

@Suppress("unused") private val keepSpacer: @Composable () -> Unit = { Spacer(Modifier) }
