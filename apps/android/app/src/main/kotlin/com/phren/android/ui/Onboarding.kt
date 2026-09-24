package com.phren.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.phren.android.AppModel
import com.phren.kit.DeviceCodeResponse
import com.phren.kit.DeviceFlowAuth
import com.phren.kit.GitHubClient
import com.phren.kit.GitHubRepo
import com.phren.kit.KeychainStore
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

@Composable
fun OnboardingFlow(model: AppModel) {
    when (model.phase) {
        AppModel.Phase.SIGNED_OUT -> WelcomeScreen(model)
        AppModel.Phase.PICKING_REPO -> RepoPickerScreen(model)
        AppModel.Phase.INITIAL_SYNC -> InitialSyncScreen(model)
        else -> Box(Modifier.fillMaxSize().background(PhrenTheme.bg), contentAlignment = Alignment.Center) { IosSpinner() }
    }
}

@Composable
private fun WelcomeScreen(model: AppModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var showPAT by remember { mutableStateOf(false) }
    var deviceCode by remember { mutableStateOf<DeviceCodeResponse?>(null) }
    var authError by remember { mutableStateOf<String?>(null) }
    var polling by remember { mutableStateOf(false) }

    fun startDeviceFlow() = scope.launch {
        authError = null
        if (!DeviceFlowAuth.isConfigured) {
            authError = "GitHub sign-in isn't set up yet — use a token instead."
            return@launch
        }
        val auth = DeviceFlowAuth()
        try {
            val code = auth.requestCode()
            deviceCode = code
            polling = true
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(code.verificationUri)))
                when (val state = auth.waitForAuthorization(code)) {
                    is DeviceFlowAuth.PollState.Authorized -> model.signIn(state.token, KeychainStore.TokenKind.OAUTH)
                    DeviceFlowAuth.PollState.Expired -> authError = "The code expired — try again."
                    DeviceFlowAuth.PollState.Denied -> authError = "Authorization was denied."
                    else -> {}
                }
            } finally {
                polling = false
            }
        } catch (e: Exception) {
            authError = "Couldn't reach GitHub: ${e.message}"
        }
        deviceCode = null
    }

    Column(
        Modifier.fillMaxSize().background(PhrenTheme.bg).windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.weight(1f))
        PhrenMascot(size = 130.dp)
        Spacer(Modifier.height(24.dp))
        Text("phren", style = IosType.largeTitle.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.text)
        Spacer(Modifier.height(24.dp))
        Text("memory that travels with your agents", style = IosType.callout.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.lavender, textAlign = TextAlign.Center)
        Spacer(Modifier.height(28.dp))
        TypewriterFindingCard()
        Spacer(Modifier.height(24.dp))
        Text(
            "Connect a GitHub token to open your phren store. It's stored only in this device's encrypted keystore.",
            style = IosType.footnote, color = PhrenTheme.textMuted, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.weight(1f))
        deviceCode?.let {
            DeviceCodeCard(it, polling)
            Spacer(Modifier.height(24.dp))
        }
        authError?.let {
            Text(it, style = IosType.footnote, color = PhrenTheme.systemRed)
            Spacer(Modifier.height(24.dp))
        }
        ProminentButton("Connect with a GitHub token", Icons.Filled.Key) { showPAT = true }
        if (DeviceFlowAuth.isConfigured) {
            Spacer(Modifier.height(12.dp))
            Text(
                "Sign in with GitHub instead", style = IosType.footnote,
                color = PhrenTheme.accent.copy(alpha = if (polling) 0.35f else 1f),
                modifier = Modifier.clickable(enabled = !polling) { startDeviceFlow() },
            )
        }
        Spacer(Modifier.height(16.dp))
    }
    if (showPAT) PATSignInSheet(model) { showPAT = false }
}

/** `.buttonStyle(.borderedProminent)` */
@Composable
fun ProminentButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, fill: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier.then(if (fill) Modifier.fillMaxWidth() else Modifier)
            .background(PhrenTheme.accent, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(label, style = IosType.body.copy(fontWeight = FontWeight.SemiBold), color = Color.White)
    }
}

@Composable
private fun DeviceCodeCard(code: DeviceCodeResponse, polling: Boolean) {
    Column(
        Modifier.background(PhrenTheme.surfaceRaised, RoundedCornerShape(8.dp)).border(1.dp, PhrenTheme.border, RoundedCornerShape(8.dp)).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Enter this code on GitHub:", style = IosType.footnote.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.textMuted)
        Spacer(Modifier.height(8.dp))
        SelectionContainer { Text(code.userCode, style = IosType.title.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.cyan) }
        if (polling) {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                IosSpinner(size = 14)
                Spacer(Modifier.width(6.dp))
                Text("Waiting for approval…", style = IosType.footnote.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.textMuted)
            }
        }
    }
}

@Composable
private fun PATSignInSheet(model: AppModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var validating by remember { mutableStateOf(false) }
    IosSheet(
        onDismiss, "Token sign-in", confirmLabel = "Sign in",
        confirmEnabled = token.isNotBlank() && !validating,
        onConfirm = {
            scope.launch {
                validating = true
                try {
                    model.signIn(token, KeychainStore.TokenKind.PAT)
                    onDismiss()
                } catch (_: Exception) {
                    error = "GitHub rejected that token. Check you pasted all of it and that it hasn't expired."
                } finally {
                    validating = false
                }
            }
        },
    ) {
        LazyColumn {
            item { IosSectionHeader("Personal access token") }
            item {
                FormCell(RowPosition.FIRST, onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/settings/personal-access-tokens/new"))) }) {
                    Text("Create a token on GitHub", style = IosType.body, color = PhrenTheme.accent)
                }
            }
            item {
                FormCell(RowPosition.LAST) {
                    Box(Modifier.fillMaxWidth()) {
                        if (token.isEmpty()) Text("github_pat_… or ghp_…", style = IosType.body, color = PhrenTheme.tertiaryLabel)
                        BasicTextField(
                            token, { token = it }, singleLine = true,
                            textStyle = IosType.body.copy(color = PhrenTheme.text),
                            cursorBrush = SolidColor(PhrenTheme.accent),
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            item {
                val footer = buildAnnotatedString {
                    append("Create a fine-grained token with ")
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Contents: Read and write") }
                    append(" and ")
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Metadata: Read") }
                    append(" on your phren store repository. The token is stored only in this device's encrypted keystore. Under Repository access, select your store repository — a token that can't see it will show only your public repos.")
                }
                Text(footer, style = IosType.footnote, color = PhrenTheme.secondaryLabel, modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 7.dp))
            }
            error?.let { e ->
                item {
                    Spacer(Modifier.height(20.dp))
                    FormCell { Text(e, style = IosType.footnote, color = PhrenTheme.systemRed) }
                }
            }
        }
    }
}

@Composable
private fun RepoPickerScreen(model: AppModel) {
    val scope = rememberCoroutineScope()
    IosScreen(
        "Choose your store", large = true,
        leading = { ToolbarButton(ToolbarAction(text = "Sign out") { scope.launch { model.signOut() } }) },
    ) {
        RepoPickerList(
            model, emptySet(),
            footer = "Pick the GitHub repository that holds your phren store (it contains phren.root.yaml). Set one up on your computer with `phren team init` or `phren store add`.",
        ) { repo -> scope.launch { model.addStore(repo) } }
    }
}

/** Lists the token's repos, probing each for `phren.root.yaml` (8 at a time). */
@Composable
fun RepoPickerList(
    model: AppModel,
    existingStoreIds: Set<String>,
    footer: String = "Add any repository that holds a phren store (it contains phren.root.yaml).",
    rowBackground: Color = IosColors.row,
    onSelect: (GitHubRepo) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var repos by remember { mutableStateOf<List<GitHubRepo>>(emptyList()) }
    val phrenStoreNames = remember { mutableStateListOf<String>() }
    var noAccessCount by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var probing by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var manualEntry by remember { mutableStateOf("") }

    suspend fun load() {
        loading = true
        loadError = null
        phrenStoreNames.clear()
        noAccessCount = 0
        try {
            repos = model.client.listAllRepos(maxPages = 5)
        } catch (e: Exception) {
            loadError = e.message
            loading = false
            return
        }
        loading = false
        probing = true
        val gate = Semaphore(8)
        repos.map { repo ->
            scope.async {
                val probe = gate.withPermit { model.client.probeStore(repo) }
                when (probe) {
                    GitHubClient.StoreProbe.IsStore -> phrenStoreNames.add(repo.fullName)
                    // Visible but unreadable: a scope gap, not "not a store".
                    GitHubClient.StoreProbe.NoAccess -> noAccessCount++
                    else -> {}
                }
            }
        }.awaitAll()
        probing = false
    }

    LaunchedEffect(Unit) { load() }

    val likely = repos.filter { it.fullName in phrenStoreNames }
    val others = repos.filter { it.fullName !in phrenStoreNames }
    val onlyPublic = !loading && loadError == null && repos.isNotEmpty() && repos.all { !it.isPrivate }
    val noAccessMessage = if (noAccessCount > 0) {
        val subject = if (noAccessCount == 1) "1 repository answers" else "$noAccessCount repositories answer"
        val pronoun = if (noAccessCount == 1) "it" else "them"
        "$subject a permissions error checking for phren.root.yaml — your token can list $pronoun but not read contents. Add Contents: Read and write under Repository access on GitHub, then pull to refresh."
    } else null

    @Composable
    fun RepoRow(repo: GitHubRepo, isStore: Boolean, pos: RowPosition) {
        val added = repo.fullName in existingStoreIds
        IosCell(pos, background = rowBackground, onClick = if (added) null else ({ onSelect(repo) })) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(repo.fullName, style = IosType.body, color = PhrenTheme.text.copy(alpha = if (added) 0.4f else 1f))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (repo.isPrivate) {
                            Icon(Icons.Outlined.Lock, null, tint = PhrenTheme.secondaryLabel, modifier = Modifier.size(11.dp))
                            Text("Private", style = IosType.caption2, color = PhrenTheme.secondaryLabel)
                        }
                        if (repo.permissions?.push == false) {
                            Icon(Icons.Outlined.Visibility, null, tint = PhrenTheme.systemOrange, modifier = Modifier.size(11.dp))
                            Text("Read-only", style = IosType.caption2, color = PhrenTheme.systemOrange)
                        }
                    }
                }
                if (added) Icon(Icons.Filled.CheckCircle, "Added", tint = PhrenTheme.systemGreen, modifier = Modifier.size(22.dp))
                else if (isStore) Icon(Icons.Outlined.Psychology, "phren store", tint = PhrenTheme.accent, modifier = Modifier.size(22.dp))
            }
        }
    }

    IosRefreshable({ load() }, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            if (likely.isNotEmpty() || probing) {
                item {
                    Row(Modifier.padding(start = 32.dp, top = 22.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("PHREN STORES", style = IosType.footnote, color = PhrenTheme.secondaryLabel)
                        if (probing) { Spacer(Modifier.width(6.dp)); IosSpinner(size = 10) }
                    }
                }
                if (likely.isEmpty()) {
                    item {
                        IosCell(RowPosition.ONLY, background = rowBackground) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IosSpinner(size = 14); Spacer(Modifier.width(8.dp))
                                Text("Checking your repositories for phren stores…", style = IosType.body, color = PhrenTheme.text)
                            }
                        }
                    }
                } else {
                    items(likely.size, key = { "s-" + likely[it].id }) { i -> RepoRow(likely[i], true, RowPosition.of(i, likely.size)) }
                }
            }
            item { IosSectionHeader(if (likely.isEmpty()) "Your repositories" else "Other repositories") }
            val statusRows = (if (loading || loadError != null) 1 else 0)
            val count = statusRows + others.size
            if (statusRows == 1) {
                item {
                    IosCell(RowPosition.of(0, count), background = rowBackground) {
                        if (loading) Row(verticalAlignment = Alignment.CenterVertically) {
                            IosSpinner(); Spacer(Modifier.width(8.dp))
                            Text("Loading repositories…", style = IosType.body, color = PhrenTheme.text)
                        } else Column {
                            Text(loadError ?: "", style = IosType.footnote, color = PhrenTheme.systemRed)
                            Spacer(Modifier.height(8.dp))
                            Text("Try again", style = IosType.body, color = PhrenTheme.accent, modifier = Modifier.clickable { scope.launch { load() } })
                        }
                    }
                }
            }
            items(others.size, key = { "o-" + others[it].id }) { i -> RepoRow(others[i], false, RowPosition.of(i + statusRows, count)) }
            (noAccessMessage ?: if (onlyPublic) "Only public repositories are listed. If your phren store repo is private, your token doesn't have access to it yet — add the repo under Repository access on GitHub, then pull to refresh." else null)
                ?.let { item { IosSectionFooter(it) } }

            item { IosSectionHeader("Or enter a repository directly") }
            item {
                IosCell(RowPosition.FIRST, background = rowBackground) {
                    Box(Modifier.fillMaxWidth()) {
                        if (manualEntry.isEmpty()) Text("owner/repo", style = IosType.body, color = PhrenTheme.tertiaryLabel)
                        BasicTextField(
                            manualEntry, { manualEntry = it }, singleLine = true,
                            textStyle = IosType.body.copy(color = PhrenTheme.text), cursorBrush = SolidColor(PhrenTheme.accent),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            item {
                val enabled = manualEntry.contains("/")
                IosCell(RowPosition.LAST, background = rowBackground, onClick = if (enabled) ({
                    scope.launch {
                        val parts = manualEntry.trim().split("/")
                        if (parts.size != 2) return@launch
                        val (owner, name) = parts
                        try {
                            onSelect(model.client.repo(owner, name))
                        } catch (e: Exception) {
                            error = if (e.message?.contains("404") == true)
                                "Can't see $owner/$name. GitHub returns 'not found' for private repositories your token can't read. Give the token access under Repository access on GitHub (Contents: Read and write, Metadata: Read), then try again."
                            else "Couldn't open $manualEntry: ${e.message}"
                        }
                    }
                }) else null) {
                    Text("Open", style = IosType.body, color = PhrenTheme.accent.copy(alpha = if (enabled) 1f else 0.35f))
                }
            }
            item {
                error?.let { Text(it, style = IosType.footnote, color = PhrenTheme.systemRed, modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 7.dp)) }
                    ?: IosSectionFooter(footer)
            }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }
}

@Composable
private fun InitialSyncScreen(model: AppModel) {
    Column(Modifier.fillMaxSize().background(PhrenTheme.bg), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        PhrenMascot(size = 90.dp)
        Spacer(Modifier.height(16.dp))
        IosSpinner(color = PhrenTheme.cyan)
        Spacer(Modifier.height(16.dp))
        Text("Syncing your store…", style = IosType.headline.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.text)
        model.storeDescriptors.lastOrNull()?.let {
            Spacer(Modifier.height(16.dp))
            Text(it.id, style = IosType.footnote.copy(fontFamily = FontFamily.Monospace), color = PhrenTheme.lavender)
        }
    }
}
